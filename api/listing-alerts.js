// api/listing-alerts.js
//
// When a listing is posted, tell the members who asked to hear about listings
// like it.
//
// Two groups are told:
//   · members with a saved alert whose filters the listing fits (the same
//     filters as the Marketplace: words, category, compensation type and
//     range, skill). They get a notification on the site and an email.
//   · members whose profile skills overlap the listing's tags. They get an
//     email only, as before.
//
// WHAT THIS TRUSTS. The page says only which listing. Who posted it, what it
// says and whether it is public are read from the record. Only the poster can
// trigger it, each listing triggers it once, and a private listing triggers
// nothing. How many emails any one member gets is limited in _mail.js; a
// member who has blocked the poster is not told.

export const config = { maxDuration: 60 };

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { verifyCaller } from './_auth.js';
import { sendMemberEmail, escapeHtml } from './_mail.js';

const MAX_ALERT_RECIPIENTS = 200;
const MAX_SKILL_RECIPIENTS = 50;

function db() {
    if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    return getFirestore();
}

/// Does a listing fit a saved alert? Mirrors applyMarketplaceFilters() on the page.
export function alertMatches(f, p) {
    if (!f || typeof f !== 'object') return false;
    const q = String(f.q || '').toLowerCase().trim();
    if (!q && !f.category && !f.compType && !f.compRange && !f.tag) return false;      // an alert with no filters would match everything
    if (q) {
        const text = `${p.title || ''} ${p.description || ''} ${p.category || ''} ${p.posterUsername || ''} ${p.compensation || ''} ${(p.tags || []).join(' ')}`.toLowerCase();
        if (!text.includes(q)) return false;
    }
    if (f.category && p.category !== f.category) return false;
    if (f.compType && p.compensationType !== f.compType) return false;
    if (f.compRange) {
        const amount = parseFloat(String(p.compensation || '0').replace(/[^0-9.]/g, '')) || 0;
        if (f.compRange === '0-500'      && amount > 500) return false;
        if (f.compRange === '500-2000'   && (amount < 500 || amount > 2000)) return false;
        if (f.compRange === '2000-10000' && (amount < 2000 || amount > 10000)) return false;
        if (f.compRange === '10000+'     && amount < 10000) return false;
    }
    if (f.tag && !(p.tags || []).includes(f.tag)) return false;
    return true;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const caller = await verifyCaller(req, { allowService: false });
    if (!caller) return res.status(401).json({ error: 'Unauthorized' });

    const id = req.body && req.body.subprojectId;
    if (typeof id !== 'string' || !id || id.length > 128) return res.status(400).json({ error: 'subprojectId required' });

    try {
        const store = db();
        const doc = await store.collection('subprojects').doc(id).get();
        if (!doc.exists) return res.status(404).json({ error: 'Listing not found' });
        const p = doc.data();
        const poster = p.posterUid || p.ownerUid;
        if (poster !== caller.uid) return res.status(403).json({ error: 'Only the poster can announce a listing' });
        if (p.planNode === true || p.isPrivate === true || (p.status && p.status !== 'open')) return res.status(200).json({ success: true, told: 0, skipped: 'not a public open listing' });

        // Once per listing. create() fails if the record exists.
        try { await store.collection('alertRuns').doc(id).create({ by: caller.uid, at: FieldValue.serverTimestamp() }); }
        catch (e) { return res.status(200).json({ success: true, told: 0, skipped: 'already announced' }); }

        const tags = Array.isArray(p.tags) ? p.tags.filter(t => typeof t === 'string').slice(0, 10) : [];
        const [alertSnap, skillSnap] = await Promise.all([
            store.collection('listingAlerts').limit(5000).get(),
            tags.length ? store.collection('users').where('skills', 'array-contains-any', tags).limit(MAX_SKILL_RECIPIENTS + 10).get() : Promise.resolve({ docs: [] })
        ]);

        // One entry per member: an alert beats a skill match.
        const tell = new Map();
        for (const d of alertSnap.docs) {
            const a = d.data();
            if (!a.uid || a.uid === poster || tell.has(a.uid)) continue;
            if (!alertMatches(a.filters, p)) continue;
            tell.set(a.uid, { alert: String(a.name || 'Saved alert').slice(0, 80), email: a.email !== false });
            if (tell.size >= MAX_ALERT_RECIPIENTS) break;
        }
        let skillCount = 0;
        for (const d of skillSnap.docs) {
            if (d.id === poster || tell.has(d.id) || skillCount >= MAX_SKILL_RECIPIENTS) continue;
            const u = d.data();
            tell.set(d.id, { skills: (u.skills || []).filter(s => tags.includes(s)).slice(0, 8), email: true });
            skillCount++;
        }

        const title = String(p.title || 'Untitled').slice(0, 140);
        const data = { postingTitle: escapeHtml(title), compensation: escapeHtml(String(p.compensation || '').slice(0, 80)),
                       category: escapeHtml(String(p.category || 'General').slice(0, 60)), posterUsername: escapeHtml(String(p.posterUsername || 'a member').slice(0, 40)) };
        let told = 0, emailed = 0;
        const all = [...tell.entries()];
        for (let i = 0; i < all.length; i += 10) {
            await Promise.all(all.slice(i, i + 10).map(async ([uid, how]) => {
                // Not from someone they have blocked.
                const blocked = await store.collection('blocks').doc(uid + '_' + poster).get().catch(() => null);
                if (blocked && blocked.exists) return;
                const user = await store.collection('users').doc(uid).get().catch(() => null);
                const name = escapeHtml(String((user && user.exists && (user.data().firstName || user.data().username)) || 'there').slice(0, 40));
                told++;
                if (how.alert) {
                    await store.collection('notifications').add({
                        recipientUid: uid, type: 'listing_alert', read: false, projectId: id,
                        message: `🔔 New listing for your alert "${how.alert}": ${title}`, createdAt: new Date()
                    }).catch(() => {});
                }
                if (!how.email) return;
                const out = how.alert
                    ? await sendMemberEmail({ toUid: uid, type: 'listing_alert', key: id, trusted: true, data: Object.assign({ recipientName: name, alertName: escapeHtml(how.alert) }, data) })
                    : await sendMemberEmail({ toUid: uid, type: 'new_bounty_match', key: id, trusted: true, data: Object.assign({ recipientName: name, matchedSkills: how.skills.map(escapeHtml) }, data) });
                if (out.sent) emailed++;
            }));
        }
        return res.status(200).json({ success: true, told, emailed });
    } catch (e) {
        console.error('listing-alerts failed:', e.message);
        return res.status(500).json({ error: 'Alerts could not be sent' });
    }
}

// api/error-digest.js
// Runs daily via Vercel cron. Reads the errorLog collection, groups failures,
// and emails a digest. Silent failures are the main risk in this codebase —
// three separate ones (deposit-escrow-fee 401s, resolve-dispute missing its API
// key, send-email rejecting every payload) ran for weeks without surfacing.

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (!getApps().length) {
    initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
const db = getFirestore();

const ALERT_EMAIL = 'james.ferraioli@gmail.com';
const SITE        = 'https://www.nqvate.com';

export default async function handler(req, res) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}` &&
        authHeader !== `Bearer ${process.env.INTERNAL_API_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

        const snap = await db.collection('errorLog')
            .where('createdAt', '>=', since)
            .orderBy('createdAt', 'desc')
            .limit(500)
            .get();

        if (snap.empty) {
            console.log('✅ error-digest: no errors in the last 24h');
            return res.json({ success: true, errors: 0 });
        }

        // Group by endpoint + status so one broken route is one line, not 300
        const groups = {};
        snap.forEach(doc => {
            const d   = doc.data();
            const key = `${d.endpoint || 'unknown'} → ${d.status || d.kind || 'error'}`;
            if (!groups[key]) {
                groups[key] = { count: 0, sample: d.message || '', lastSeen: d.createdAt, uids: new Set() };
            }
            groups[key].count++;
            if (d.uid) groups[key].uids.add(d.uid);
        });

        const rows = Object.entries(groups)
            .sort((a, b) => b[1].count - a[1].count)
            .map(([key, g]) =>
                `${String(g.count).padStart(4)}×  ${key}\n` +
                `       users affected: ${g.uids.size || 'unknown'}\n` +
                (g.sample ? `       sample: ${String(g.sample).slice(0, 180)}\n` : '')
            );

        const total = snap.size;
        const body =
            `NQVate error digest — last 24 hours\n` +
            `${total} failure${total === 1 ? '' : 's'} across ${Object.keys(groups).length} distinct issue${Object.keys(groups).length === 1 ? '' : 's'}.\n\n` +
            rows.join('\n') +
            `\n\nFull log: Firebase Console → Firestore → errorLog`;

        console.error(`🚨 error-digest: ${total} failures in 24h`);

        await fetch(`${SITE}/api/send-email`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.INTERNAL_API_SECRET}`
            },
            body: JSON.stringify({
                to: ALERT_EMAIL,
                subject: `🚨 NQVate: ${total} failures in the last 24h`,
                body
            })
        }).catch(e => console.warn('Digest email failed:', e.message));

        // Prune entries older than 30 days so the collection stays small
        const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const old    = await db.collection('errorLog')
            .where('createdAt', '<', cutoff).limit(400).get();
        if (!old.empty) {
            const batch = db.batch();
            old.forEach(d => batch.delete(d.ref));
            await batch.commit();
            console.log(`🧹 pruned ${old.size} old error records`);
        }

        return res.json({ success: true, errors: total, groups: Object.keys(groups).length });

    } catch (e) {
        console.error('error-digest failed:', e.message);
        return res.status(500).json({ error: e.message });
    }
}

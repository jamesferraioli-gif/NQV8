// api/_mail.js
//
// Every notification email NQVate sends goes through sendMemberEmail() here,
// whether a page asked for it (send-email.js) or one of the server's own jobs
// did (a dispute ruling, an automatic release, a listing alert).
//
// Three things are decided in this one place, so no caller can skip them:
//
//   WHO          the address is read from Firebase Authentication by user id.
//                It is never taken from a request.
//
//   WHETHER      the member's own settings (users/{uid}.emailPrefs):
//                  updates  — things that happened on their own work: a bid,
//                             an acceptance, a submission, a payout, a dispute
//                  matches  — new listings that fit their alerts or skills
//                Both are on unless switched off. Every email carries a link
//                that switches its own kind off in one click.
//
//   HOW OFTEN    a per-member log (emailLog/{uid}) holds a daily count and the
//                last time each (kind of email, subject) was sent:
//                  · the same email about the same thing is not repeated
//                    inside its quiet period (six hours for "new bid", so ten
//                    bids on one posting are one email, not ten)
//                  · no more than DAILY_CAP emails of a kind in a day
//                Anything held back is still in the member's notifications on
//                the site; only the email is skipped.

import crypto from 'crypto';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM = 'NQVate <noreply@nqvate.com>';
export const BASE_URL = 'https://www.nqvate.com';

const MINUTE = 60 * 1000, HOUR = 60 * MINUTE;
export const DAILY_CAP = { updates: 20, matches: 3 };
// kind: which setting governs it. quiet: how long before the same email about the same subject may go again.
export const EMAIL_RULES = {
    bid_received:        { kind: 'updates', quiet: 6 * HOUR },
    bid_accepted:        { kind: 'updates', quiet: 10 * MINUTE },
    work_submitted:      { kind: 'updates', quiet: 10 * MINUTE },
    submission_approved: { kind: 'updates', quiet: 10 * MINUTE },
    changes_requested:   { kind: 'updates', quiet: 10 * MINUTE },
    dispute_filed:       { kind: 'updates', quiet: HOUR },
    dispute_resolved:    { kind: 'updates', quiet: HOUR },
    team_added:          { kind: 'updates', quiet: HOUR },
    notice:              { kind: 'updates', quiet: 10 * MINUTE },
    new_bounty_match:    { kind: 'matches', quiet: 24 * HOUR },
    listing_alert:       { kind: 'matches', quiet: 24 * HOUR }
};
// What a signed-in member may ask to have sent to another member. The rest
// are sent only by the server's own jobs.
export const MEMBER_TEMPLATES = ['bid_received', 'bid_accepted', 'work_submitted', 'submission_approved', 'changes_requested', 'dispute_filed', 'team_added'];

function ensureApp() {
    if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}

export const escapeHtml = s => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/// Escape every string a member supplied, at any depth, and cap its length.
export function cleanData(v, depth = 0) {
    if (typeof v === 'string') return escapeHtml(v.slice(0, 500));
    if (typeof v === 'number' || typeof v === 'boolean' || v == null) return v;
    if (depth > 3) return '';
    if (Array.isArray(v)) return v.slice(0, 20).map(x => cleanData(x, depth + 1));
    if (typeof v === 'object') { const o = {}; for (const k of Object.keys(v).slice(0, 40)) o[k] = cleanData(v[k], depth + 1); return o; }
    return '';
}

export async function emailForUid(uid) {
    ensureApp();
    try { return (await getAuth().getUser(uid)).email || null; }
    catch (e) { return null; }
}

// ── The one-click "stop these" link ──────────────────────────────────────
// Signed with the server secret, so a link works for exactly one member and
// one kind of email and cannot be made up for anyone else.
export function unsubscribeToken(uid, kind) {
    return crypto.createHmac('sha256', String(process.env.INTERNAL_API_SECRET || '')).update(uid + ':' + kind).digest('hex').slice(0, 40);
}
export function unsubscribeUrl(uid, kind) {
    return `${BASE_URL}/api/email-prefs?u=${encodeURIComponent(uid)}&k=${kind}&t=${unsubscribeToken(uid, kind)}`;
}

// A plain message with one button: used for everything that does not need
// its own layout. All values must already be escaped.
function card({ heading, intro, rows = [], note, cta, ctaLabel }) {
    return `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#09090b;color:#f4f4f5;padding:32px;border-radius:16px;">
            <div style="text-align:center;margin-bottom:32px;">
                <div style="background:linear-gradient(135deg,#22d3ee,#8b5cf6);width:56px;height:56px;border-radius:14px;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;color:#fff;">NQV8</div>
            </div>
            <h1 style="font-size:24px;font-weight:700;margin-bottom:8px;">${heading}</h1>
            <p style="color:#a1a1aa;margin-bottom:24px;line-height:1.5;">${intro}</p>
            ${rows.length ? `<div style="background:#18181b;border:1px solid #3f3f46;border-radius:12px;padding:20px;margin-bottom:24px;">${rows.map(([k, v], i) => `
                <p style="color:#a1a1aa;font-size:12px;margin:0 0 4px;">${k}</p>
                <p style="font-weight:600;font-size:15px;margin:0 0 ${i === rows.length - 1 ? 0 : 12}px;">${v}</p>`).join('')}
            </div>` : ''}
            ${note ? `<div style="background:#1c1400;border:1px solid #f59e0b;border-radius:12px;padding:16px;margin-bottom:24px;"><p style="color:#fbbf24;font-size:14px;margin:0;">${note}</p></div>` : ''}
            <a href="${cta || BASE_URL}" style="display:block;background:#fff;color:#000;text-align:center;padding:14px;border-radius:12px;font-weight:600;text-decoration:none;margin-bottom:24px;">${ctaLabel || 'Open NQVate'}</a>
            <p style="color:#a1a1aa;font-size:12px;text-align:center;">NQVate · <a href="${BASE_URL}" style="color:#22d3ee;">nqvate.com</a></p>
        </div>`;
}

const templates = {

    // Someone bid on your posting
    bid_received: ({ posterName, bidderUsername, postingTitle, bidAmount, postingId }) => ({
        subject: `New bid on "${postingTitle}"`,
        html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#09090b;color:#f4f4f5;padding:32px;border-radius:16px;">
            <div style="text-align:center;margin-bottom:32px;">
                <div style="background:linear-gradient(135deg,#22d3ee,#8b5cf6);width:56px;height:56px;border-radius:14px;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;color:#000;">NQV8</div>
            </div>
            <h1 style="font-size:24px;font-weight:700;margin-bottom:8px;">You received a bid 💰</h1>
            <p style="color:#a1a1aa;margin-bottom:24px;">Hey ${posterName}, <strong style="color:#f4f4f5;">@${bidderUsername}</strong> placed a bid on your posting.</p>
            <div style="background:#18181b;border:1px solid #3f3f46;border-radius:12px;padding:20px;margin-bottom:24px;">
                <p style="color:#a1a1aa;font-size:12px;margin:0 0 4px;">Posting</p>
                <p style="font-weight:600;font-size:16px;margin:0 0 12px;">${postingTitle}</p>
                <p style="color:#a1a1aa;font-size:12px;margin:0 0 4px;">Bid Amount</p>
                <p style="color:#22d3ee;font-weight:700;font-size:20px;margin:0;">${bidAmount}</p>
            </div>
            <a href="${BASE_URL}" style="display:block;background:#fff;color:#000;text-align:center;padding:14px;border-radius:12px;font-weight:600;text-decoration:none;margin-bottom:24px;">Review Bid →</a>
            <p style="color:#52525b;font-size:12px;text-align:center;">NQVate · <a href="${BASE_URL}" style="color:#22d3ee;">nqvate.com</a></p>
        </div>`
    }),

    // Your bid was accepted
    bid_accepted: ({ builderName, posterUsername, postingTitle, compensation, postingId }) => ({
        subject: `Your bid was accepted on "${postingTitle}" 🎉`,
        html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#09090b;color:#f4f4f5;padding:32px;border-radius:16px;">
            <div style="text-align:center;margin-bottom:32px;">
                <div style="background:linear-gradient(135deg,#22d3ee,#8b5cf6);width:56px;height:56px;border-radius:14px;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;color:#000;">NQV8</div>
            </div>
            <h1 style="font-size:24px;font-weight:700;margin-bottom:8px;">Bid accepted! 🎉</h1>
            <p style="color:#a1a1aa;margin-bottom:24px;">Hey ${builderName}, <strong style="color:#f4f4f5;">@${posterUsername}</strong> accepted your bid. Funds are now locked in escrow.</p>
            <div style="background:#18181b;border:1px solid #3f3f46;border-radius:12px;padding:20px;margin-bottom:24px;">
                <p style="color:#a1a1aa;font-size:12px;margin:0 0 4px;">Project</p>
                <p style="font-weight:600;font-size:16px;margin:0 0 12px;">${postingTitle}</p>
                <p style="color:#a1a1aa;font-size:12px;margin:0 0 4px;">Your Compensation</p>
                <p style="color:#10b981;font-weight:700;font-size:20px;margin:0;">${compensation}</p>
            </div>
            <div style="background:#052e16;border:1px solid #10b981;border-radius:12px;padding:16px;margin-bottom:24px;">
                <p style="color:#34d399;font-size:14px;margin:0;">✅ Funds are locked in escrow and will be released automatically when your work is approved.</p>
            </div>
            <a href="${BASE_URL}" style="display:block;background:#fff;color:#000;text-align:center;padding:14px;border-radius:12px;font-weight:600;text-decoration:none;margin-bottom:24px;">Open Project →</a>
            <p style="color:#52525b;font-size:12px;text-align:center;">NQVate · <a href="${BASE_URL}" style="color:#22d3ee;">nqvate.com</a></p>
        </div>`
    }),

    // Work submitted for review
    work_submitted: ({ posterName, builderUsername, postingTitle }) => ({
        subject: `@${builderUsername} submitted work on "${postingTitle}"`,
        html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#09090b;color:#f4f4f5;padding:32px;border-radius:16px;">
            <div style="text-align:center;margin-bottom:32px;">
                <div style="background:linear-gradient(135deg,#22d3ee,#8b5cf6);width:56px;height:56px;border-radius:14px;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;color:#000;">NQV8</div>
            </div>
            <h1 style="font-size:24px;font-weight:700;margin-bottom:8px;">Work submitted for review 📦</h1>
            <p style="color:#a1a1aa;margin-bottom:24px;">Hey ${posterName}, <strong style="color:#f4f4f5;">@${builderUsername}</strong> has submitted deliverables for <strong style="color:#f4f4f5;">${postingTitle}</strong>.</p>
            <div style="background:#1c1400;border:1px solid #f59e0b;border-radius:12px;padding:16px;margin-bottom:24px;">
                <p style="color:#fbbf24;font-size:14px;margin:0;">⏱ Review within 7 days or funds will auto-release to the builder.</p>
            </div>
            <a href="${BASE_URL}" style="display:block;background:#fff;color:#000;text-align:center;padding:14px;border-radius:12px;font-weight:600;text-decoration:none;margin-bottom:24px;">Review Submission →</a>
            <p style="color:#52525b;font-size:12px;text-align:center;">NQVate · <a href="${BASE_URL}" style="color:#22d3ee;">nqvate.com</a></p>
        </div>`
    }),

    // Submission approved
    submission_approved: ({ builderName, postingTitle, compensation }) => ({
        subject: `Your work was approved — funds released! 💸`,
        html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#09090b;color:#f4f4f5;padding:32px;border-radius:16px;">
            <div style="text-align:center;margin-bottom:32px;">
                <div style="background:linear-gradient(135deg,#22d3ee,#8b5cf6);width:56px;height:56px;border-radius:14px;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;color:#000;">NQV8</div>
            </div>
            <h1 style="font-size:24px;font-weight:700;margin-bottom:8px;">Work approved! 💸</h1>
            <p style="color:#a1a1aa;margin-bottom:24px;">Hey ${builderName}, your submission for <strong style="color:#f4f4f5;">${postingTitle}</strong> was approved and funds have been released from escrow.</p>
            <div style="background:#18181b;border:1px solid #3f3f46;border-radius:12px;padding:20px;margin-bottom:24px;">
                <p style="color:#a1a1aa;font-size:12px;margin:0 0 4px;">Amount Released</p>
                <p style="color:#10b981;font-weight:700;font-size:24px;margin:0;">${compensation}</p>
                <p style="color:#52525b;font-size:11px;margin:4px 0 0;">96.5% of agreed compensation after platform fee</p>
            </div>
            <a href="${BASE_URL}" style="display:block;background:#fff;color:#000;text-align:center;padding:14px;border-radius:12px;font-weight:600;text-decoration:none;margin-bottom:24px;">View Profile →</a>
            <p style="color:#52525b;font-size:12px;text-align:center;">NQVate · <a href="${BASE_URL}" style="color:#22d3ee;">nqvate.com</a></p>
        </div>`
    }),

    // Changes requested
    changes_requested: ({ builderName, posterUsername, postingTitle, feedback }) => ({
        subject: `Changes requested on "${postingTitle}"`,
        html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#09090b;color:#f4f4f5;padding:32px;border-radius:16px;">
            <div style="text-align:center;margin-bottom:32px;">
                <div style="background:linear-gradient(135deg,#22d3ee,#8b5cf6);width:56px;height:56px;border-radius:14px;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;color:#000;">NQV8</div>
            </div>
            <h1 style="font-size:24px;font-weight:700;margin-bottom:8px;">Changes requested 🔁</h1>
            <p style="color:#a1a1aa;margin-bottom:24px;">Hey ${builderName}, <strong style="color:#f4f4f5;">@${posterUsername}</strong> has requested changes on <strong style="color:#f4f4f5;">${postingTitle}</strong>.</p>
            <div style="background:#18181b;border:1px solid #3f3f46;border-radius:12px;padding:20px;margin-bottom:24px;">
                <p style="color:#a1a1aa;font-size:12px;margin:0 0 8px;">Feedback</p>
                <p style="color:#f4f4f5;font-size:14px;margin:0;">${feedback}</p>
            </div>
            <a href="${BASE_URL}" style="display:block;background:#fff;color:#000;text-align:center;padding:14px;border-radius:12px;font-weight:600;text-decoration:none;margin-bottom:24px;">Resubmit Work →</a>
            <p style="color:#52525b;font-size:12px;text-align:center;">NQVate · <a href="${BASE_URL}" style="color:#22d3ee;">nqvate.com</a></p>
        </div>`
    }),

    // Dispute resolved
    dispute_resolved: ({ recipientName, postingTitle, yourPct, ruling }) => ({
        subject: `Dispute resolved on "${postingTitle}"`,
        html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#09090b;color:#f4f4f5;padding:32px;border-radius:16px;">
            <div style="text-align:center;margin-bottom:32px;">
                <div style="background:linear-gradient(135deg,#22d3ee,#8b5cf6);width:56px;height:56px;border-radius:14px;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;color:#000;">NQV8</div>
            </div>
            <h1 style="font-size:24px;font-weight:700;margin-bottom:8px;">Dispute resolved ⚖️</h1>
            <p style="color:#a1a1aa;margin-bottom:24px;">Hey ${recipientName}, Claude AI has reviewed the dispute for <strong style="color:#f4f4f5;">${postingTitle}</strong> and issued a ruling.</p>
            <div style="background:#18181b;border:1px solid #3f3f46;border-radius:12px;padding:20px;margin-bottom:24px;">
                <p style="color:#a1a1aa;font-size:12px;margin:0 0 4px;">Your Share</p>
                <p style="color:#22d3ee;font-weight:700;font-size:24px;margin:0 0 12px;">${yourPct}%</p>
                <p style="color:#a1a1aa;font-size:12px;margin:0 0 8px;">Claude's Ruling</p>
                <p style="color:#f4f4f5;font-size:13px;margin:0;">${ruling}</p>
            </div>
            <p style="color:#52525b;font-size:12px;margin-bottom:24px;text-align:center;">This ruling is final. Funds have been distributed on-chain automatically.</p>
            <a href="${BASE_URL}" style="display:block;background:#fff;color:#000;text-align:center;padding:14px;border-radius:12px;font-weight:600;text-decoration:none;margin-bottom:24px;">View Project →</a>
            <p style="color:#52525b;font-size:12px;text-align:center;">NQVate · <a href="${BASE_URL}" style="color:#22d3ee;">nqvate.com</a></p>
        </div>`
    }),

    // New bounty matching skills
    new_bounty_match: ({ recipientName, postingTitle, compensation, category, matchedSkills, posterUsername }) => ({
        subject: `New ${category} bounty matches your skills — ${compensation}`,
        html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#09090b;color:#f4f4f5;padding:32px;border-radius:16px;">
            <div style="text-align:center;margin-bottom:32px;">
                <div style="background:linear-gradient(135deg,#22d3ee,#8b5cf6);width:56px;height:56px;border-radius:14px;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;color:#000;">NQV8</div>
            </div>
            <h1 style="font-size:24px;font-weight:700;margin-bottom:8px;">New bounty matches your skills 🎯</h1>
            <p style="color:#a1a1aa;margin-bottom:24px;">Hey ${recipientName}, a new bounty was posted that matches your skills.</p>
            <div style="background:#18181b;border:1px solid #3f3f46;border-radius:12px;padding:20px;margin-bottom:16px;">
                <p style="font-weight:600;font-size:16px;margin:0 0 8px;">${postingTitle}</p>
                <p style="color:#22d3ee;font-weight:700;font-size:18px;margin:0 0 8px;">${compensation}</p>
                <p style="color:#a1a1aa;font-size:12px;margin:0 0 8px;">Posted by @${posterUsername} · ${category}</p>
                <div style="display:flex;flex-wrap:wrap;gap:6px;">
                    ${matchedSkills.map(s => `<span style="background:#1e3a3a;color:#22d3ee;padding:2px 10px;border-radius:20px;font-size:11px;">${s}</span>`).join('')}
                </div>
            </div>
            <a href="${BASE_URL}" style="display:block;background:#fff;color:#000;text-align:center;padding:14px;border-radius:12px;font-weight:600;text-decoration:none;margin-bottom:24px;">View & Bid →</a>
            <p style="color:#52525b;font-size:11px;text-align:center;margin-bottom:8px;">You're receiving this because your skills match this bounty's requirements.</p>
            <p style="color:#52525b;font-size:12px;text-align:center;">NQVate · <a href="${BASE_URL}" style="color:#22d3ee;">nqvate.com</a></p>
        </div>`
    }),

    // The other party opened a dispute
    dispute_filed: ({ recipientName, filerUsername, postingTitle, reason }) => ({
        subject: `A dispute was opened on "${postingTitle}"`,
        html: card({
            heading: 'A dispute was opened ⚖️',
            intro: `Hey ${recipientName || 'there'}, <strong style="color:#f4f4f5;">@${filerUsername}</strong> has opened a dispute on <strong style="color:#f4f4f5;">${postingTitle}</strong>. The posting is frozen while Claude reviews the evidence and issues a ruling.`,
            rows: reason ? [['Their reason', reason]] : [],
            ctaLabel: 'View the dispute'
        })
    }),

    // You were added to a company's team
    team_added: ({ recipientName, ownerUsername, companyName }) => ({
        subject: `You were added to the ${companyName} team`,
        html: card({
            heading: 'You joined a team 👥',
            intro: `Hey ${recipientName || 'there'}, <strong style="color:#f4f4f5;">@${ownerUsername}</strong> added you to the team for <strong style="color:#f4f4f5;">${companyName}</strong>. You can now work on its plan in Studio and post bounties for it.`,
            ctaLabel: 'Open Studio'
        })
    }),

    // A new listing fits an alert the member saved
    listing_alert: ({ recipientName, alertName, postingTitle, compensation, category, posterUsername }) => ({
        subject: `New listing for your alert "${alertName}": ${postingTitle}`,
        html: card({
            heading: 'A listing matches your alert 🔔',
            intro: `Hey ${recipientName || 'there'}, <strong style="color:#f4f4f5;">@${posterUsername}</strong> just posted something that fits your alert <strong style="color:#f4f4f5;">${alertName}</strong>.`,
            rows: [['Listing', postingTitle], ['Compensation', compensation || 'See listing'], ['Category', category || 'General']],
            ctaLabel: 'View the listing'
        })
    }),

    // Anything the server already put in the member's notifications
    notice: ({ heading, message }) => ({
        subject: String(heading).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').slice(0, 140),
        html: card({ heading, intro: message })
    })
};

function footer(uid, kind) {
    const what = kind === 'matches' ? 'emails about new listings that match your alerts and skills' : 'emails about activity on your own bounties';
    return `
        <p style="font-family:sans-serif;max-width:600px;margin:12px auto 0;color:#71717a;font-size:11px;text-align:center;line-height:1.5;">
            You are getting this because of your email settings on NQVate.<br>
            <a href="${unsubscribeUrl(uid, kind)}" style="color:#a1a1aa;">Stop ${what}</a> · change this any time in Profile → Email notifications.
        </p>`;
}

/// Decide whether this email may go now, and record it if so. Atomic, so two
/// requests at once cannot both get through.
export async function claimSend(db, uid, type, key, now = Date.now()) {
    const rule = EMAIL_RULES[type];
    const day = new Date(now).toISOString().slice(0, 10);
    const slot = (type + ':' + String(key || '-')).replace(/[.\/#$\[\]~*`]/g, '_').slice(0, 200);
    const ref = db.collection('emailLog').doc(uid);
    return db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        const log = snap.exists ? snap.data() : {};
        const counts = log.day === day ? (log.counts || {}) : {};
        const last = log.last || {};
        if (last[slot] && now - last[slot] < rule.quiet) return { ok: false, why: 'quiet' };
        if ((counts[rule.kind] || 0) >= DAILY_CAP[rule.kind]) return { ok: false, why: 'cap' };
        // Forget subjects older than two days, so the record stays small.
        const kept = {};
        for (const k of Object.keys(last)) if (now - last[k] < 48 * HOUR) kept[k] = last[k];
        kept[slot] = now;
        counts[rule.kind] = (counts[rule.kind] || 0) + 1;
        tx.set(ref, { day, counts, last: kept });
        return { ok: true };
    });
}

/// Send one of the templates to a member. Never throws: an email that cannot
/// go must not break the action that prompted it.
///   returns { sent: true } or { sent: false, why }
export async function sendMemberEmail({ toUid, type, data, key, trusted = false }) {
    try {
        const rule = EMAIL_RULES[type];
        if (!rule || !templates[type]) return { sent: false, why: 'unknown-template' };
        if (typeof toUid !== 'string' || !toUid || toUid.length > 128) return { sent: false, why: 'no-recipient' };
        ensureApp();
        const db = getFirestore();

        const user = await db.collection('users').doc(toUid).get();
        const prefs = (user.exists && user.data().emailPrefs) || {};
        if (prefs[rule.kind] === false) return { sent: false, why: 'switched-off' };

        const to = await emailForUid(toUid);
        if (!to) return { sent: false, why: 'no-address' };

        const claim = await claimSend(db, toUid, type, key);
        if (!claim.ok) return { sent: false, why: claim.why };

        // What a page supplies is escaped here. What the server's own jobs
        // supply is escaped by them where it came from a member.
        const { subject, html } = templates[type](trusted ? data : cleanData(data));
        const out = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_API_KEY}` },
            body: JSON.stringify({
                from: FROM, to, subject, html: html + footer(toUid, rule.kind),
                headers: { 'List-Unsubscribe': `<${unsubscribeUrl(toUid, rule.kind)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
            })
        });
        if (!out.ok) {
            console.error('Resend error:', JSON.stringify(await out.json().catch(() => ({}))));
            return { sent: false, why: 'provider' };
        }
        return { sent: true };
    } catch (e) {
        console.error('sendMemberEmail failed:', e.message);
        return { sent: false, why: 'error' };
    }
}

/// For the server's own jobs: email the text they have just written into a
/// member's notifications. `message` is plain text and is escaped here.
export function mailNotice(toUid, heading, message, key) {
    if (!toUid) return Promise.resolve({ sent: false, why: 'no-recipient' });
    return sendMemberEmail({ toUid, type: 'notice', key, trusted: true, data: { heading: escapeHtml(String(heading).slice(0, 140)), message: escapeHtml(String(message).slice(0, 1500)) } });
}

/// Raw send, for the platform's own alerts to its operators only.
export async function sendRaw({ to, subject, html }) {
    const out = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_API_KEY}` },
        body: JSON.stringify({ from: FROM, to, subject, html })
    });
    const result = await out.json().catch(() => ({}));
    if (!out.ok) { console.error('Resend error:', JSON.stringify(result)); return { ok: false }; }
    return { ok: true, id: result.id };
}

// ── Alerts to the people who run NQVate ─────────────────────────────────
// Sent by the server at the moment it sees the problem, so nothing depends on
// a member's browser passing the message on. Set OPS_ALERT_EMAIL in Vercel to
// send them somewhere else.
const OPS_ALERT_EMAIL = process.env.OPS_ALERT_EMAIL || 'james.ferraioli@gmail.com';
const OPS_WALLET = '0x2c6309Ed2e36222E7e0Ce3c1376941A0D6340F4D';

/// Tell the operators that an Operations-wallet transaction could not be paid
/// for. One email an hour per source, however many members run into it.
/// Never throws: the caller is already handling a failure.
export async function opsAlert(source, detail, context = {}) {
    try {
        ensureApp();
        const db = getFirestore(), ref = db.collection('emailLog').doc('_ops'), now = Date.now();
        const slot = String(source).replace(/[^a-z0-9-]/gi, '_').slice(0, 60);
        const go = await db.runTransaction(async tx => {
            const snap = await tx.get(ref);
            const last = (snap.exists && snap.data()[slot]) || 0;
            if (now - last < HOUR) return false;
            tx.set(ref, { [slot]: now }, { merge: true });
            return true;
        });
        if (!go) return { sent: false, why: 'quiet' };
        const rows = Object.entries(context).filter(([, v]) => v !== undefined && v !== null && v !== '')
            .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#71717a;">${escapeHtml(k)}</td><td style="padding:4px 0;">${escapeHtml(String(v).slice(0, 200))}</td></tr>`).join('');
        const out = await sendRaw({
            to: OPS_ALERT_EMAIL,
            subject: `🚨 NQVate: Operations wallet could not pay gas — ${slot} failed`,
            html: `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;color:#18181b;">
                <p><strong>${escapeHtml(slot)}</strong> failed because the Operations wallet could not pay for the transaction. It is most likely low on ETH.</p>
                <p>Top up on Arbitrum One:<br><code>${OPS_WALLET}</code></p>
                ${rows ? `<table style="font-size:13px;border-collapse:collapse;">${rows}</table>` : ''}
                <p style="color:#71717a;font-size:12px;">Error: ${escapeHtml(String(detail || '').slice(0, 400))}</p>
                <p style="color:#71717a;font-size:12px;">The member was told to try again shortly. At most one of these is sent per hour for each kind of action.</p>
            </div>`
        });
        return { sent: !!out.ok };
    } catch (e) {
        console.error('opsAlert failed:', e.message);
        return { sent: false, why: 'error' };
    }
}

const NOTICE_HEADINGS = {
    auto_release: 'Escrow released automatically',
    auto_refund:  'Escrow refunded automatically',
    dispute:      'Dispute resolved',
    subscription: 'You have a new paid member'
};
/// Write a notification and email the same words to the same member.
export async function notifyAndMail(db, n) {
    const ref = await db.collection('notifications').add(n);
    await mailNotice(n.recipientUid, NOTICE_HEADINGS[n.type] || 'An update on NQVate', n.message, (n.type || 'notice') + ':' + (n.projectId || ''));
    return ref;
}

export { templates };

// api/email-prefs.js
//
// The "stop these emails" link at the foot of every notification email.
//
// No sign-in: the link itself is the proof. It carries a code made from the
// member's id, the kind of email and a secret only the server holds, so it
// works for that one member and that one kind, and cannot be made up for
// anyone else. All it can do is switch that kind of email off; switching it
// back on is done signed in, from Profile -> Email notifications.

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import crypto from 'crypto';
import { unsubscribeToken, BASE_URL } from './_mail.js';

const KINDS = { updates: 'emails about activity on your own bounties', matches: 'emails about new listings that match your alerts and skills' };

function page(title, body) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · NQVate</title></head>
<body style="margin:0;background:#09090b;color:#f4f4f5;font-family:sans-serif;">
<main style="max-width:520px;margin:12vh auto;padding:32px;text-align:center;">
<h1 style="font-size:24px;margin:0 0 12px;">${title}</h1><p style="color:#a1a1aa;line-height:1.6;">${body}</p>
<p style="margin-top:28px;"><a href="${BASE_URL}" style="display:inline-block;background:#fff;color:#000;padding:12px 24px;border-radius:12px;font-weight:600;text-decoration:none;">Go to NQVate</a></p>
</main></body></html>`;
}

export default async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).send('Method not allowed');
    const uid = String((req.query && req.query.u) || ''), kind = String((req.query && req.query.k) || ''), token = String((req.query && req.query.t) || '');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const bad = () => res.status(400).send(page('This link is not valid', 'It may have been cut short when it was copied. You can change your email settings any time from Profile → Email notifications.'));
    if (!uid || uid.length > 128 || !KINDS[kind] || token.length !== 40) return bad();
    const want = Buffer.from(unsubscribeToken(uid, kind)), got = Buffer.from(token);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return bad();
    try {
        if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
        await getFirestore().collection('users').doc(uid).set({ emailPrefs: { [kind]: false } }, { merge: true });
        return res.status(200).send(page('Done', `You will no longer get ${KINDS[kind]}. Nothing else has changed, and your notifications on the site stay as they are. To turn these back on, go to Profile → Email notifications.`));
    } catch (e) {
        console.error('email-prefs failed:', e.message);
        return res.status(500).send(page('That did not work', 'Please try the link again in a moment, or change the setting from Profile → Email notifications.'));
    }
}

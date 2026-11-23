// api/scrub-user-emails.js
//
// One-time clean-up, admin only: remove the `email` field from every record
// in the public `users` collection.
//
// Those records are readable by anyone (profiles, the leaderboard and the
// NQVerse depend on that), and each one used to carry the member's email
// address. Nothing reads it from there any more — a member's address is taken
// from Firebase Authentication, which only the server and the member
// themselves can see. This deletes the copies that are already stored.
//
// Safe to run more than once: it reports how many records it changed, and a
// second run changes none.

export const config = { maxDuration: 60 };

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { verifyCaller } from './_auth.js';

const ADMIN_UIDS = ['5t0gD2wVnqXXPAQEzfoahx3EIPp2'];

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const caller = await verifyCaller(req, { allowService: false });
    if (!caller || !caller.uid) return res.status(401).json({ error: 'Unauthorized' });
    if (!ADMIN_UIDS.includes(caller.uid)) return res.status(403).json({ error: 'Admins only' });

    try {
        if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
        const db = getFirestore();
        const snap = await db.collection('users').get();
        const withEmail = snap.docs.filter(d => d.data().email !== undefined);

        for (let i = 0; i < withEmail.length; i += 400) {            // a batch holds at most 500 writes
            const batch = db.batch();
            withEmail.slice(i, i + 400).forEach(d => batch.update(d.ref, { email: FieldValue.delete() }));
            await batch.commit();
        }
        console.log('scrub-user-emails:', withEmail.length, 'of', snap.size, 'records cleaned by', caller.uid);
        return res.status(200).json({ success: true, total: snap.size, cleaned: withEmail.length });
    } catch (e) {
        console.error('scrub-user-emails failed:', e.message);
        return res.status(500).json({ error: 'Clean-up failed part-way — run it again' });
    }
}

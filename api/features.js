// api/features.js
//
// GET  — anyone. The current switches, so the page knows what to show.
// POST — admin only. Change one or more switches.
//
// The admin check is here, on the server, against the signed-in user's
// verified Firebase token. The check in index.html only decides whether the
// button is drawn; this one decides whether the change happens.

import { FieldValue } from 'firebase-admin/firestore';
import { verifyCaller } from './_auth.js';
import { FEATURE_KEYS, getFeatures, featuresDoc, forgetFeatures } from './_features.js';

/// Must match ADMIN_UID in admin.html and ADMIN_UIDS in index.html.
const ADMIN_UIDS = ['5t0gD2wVnqXXPAQEzfoahx3EIPp2'];

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'GET') {
        return res.status(200).json({ features: await getFeatures() });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // A person, not a server secret: a cron has no business flipping these.
    const caller = await verifyCaller(req, { allowService: false });
    if (!caller || !caller.uid) return res.status(401).json({ error: 'Unauthorized' });
    if (!ADMIN_UIDS.includes(caller.uid)) return res.status(403).json({ error: 'Admins only' });

    const body = req.body || {};
    const change = {};
    for (const k of Object.keys(body)) {
        if (!FEATURE_KEYS.includes(k)) return res.status(400).json({ error: `Unknown switch: ${k}` });
        if (typeof body[k] !== 'boolean') return res.status(400).json({ error: `${k} must be true or false` });
        change[k] = body[k];
    }
    if (!Object.keys(change).length) return res.status(400).json({ error: 'Nothing to change' });

    try {
        await featuresDoc().set(
            { ...change, updatedAt: FieldValue.serverTimestamp(), updatedBy: caller.uid },
            { merge: true });
        forgetFeatures();
        const features = await getFeatures({ fresh: true });
        console.log('Feature switches changed by', caller.uid, JSON.stringify(change));
        return res.status(200).json({ success: true, features });
    } catch (e) {
        console.error('features update failed:', e.message);
        return res.status(500).json({ error: 'Could not save the change' });
    }
}

// api/_auth.js
// Shared caller verification for all NQVate API routes.
//
// Accepts either:
//   1. A Firebase ID token from a logged-in user  → returns { uid, service: false }
//   2. A server secret from a cron or internal job → returns { uid: null, service: true }
//
// Returns null if neither is valid.

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

function ensureApp() {
    if (!getApps().length) {
        initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    }
}

export async function verifyCaller(req, opts = {}) {
    const { allowService = true } = opts;
    const header = req.headers['authorization'] || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) return null;

    // Server-to-server secrets (crons, internal jobs)
    if (allowService) {
        if (token === process.env.INTERNAL_API_SECRET) return { uid: null, service: true };
        if (token === process.env.CRON_SECRET)         return { uid: null, service: true };
    }

    // Firebase ID token from a signed-in user
    try {
        ensureApp();
        const decoded = await getAuth().verifyIdToken(token);
        return { uid: decoded.uid, service: false };
    } catch (e) {
        console.warn('Token verification failed:', e.message);
        return null;
    }
}

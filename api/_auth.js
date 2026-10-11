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
import { getFirestore } from 'firebase-admin/firestore';

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

// Confirms the caller owns the company before acting on its equity.
// Service callers (crons, internal jobs) bypass the check.
// Returns null when authorized, or { status, error } to send back.
// Fails CLOSED — any error denies rather than allows.
export async function assertCompanyOwner(caller, companyId) {
    if (!caller)        return { status: 401, error: 'Unauthorized' };
    if (caller.service) return null;
    if (!caller.uid)    return { status: 403, error: 'Forbidden' };
    if (!companyId)     return { status: 400, error: 'Missing companyId' };

    try {
        ensureApp();
        const doc = await getFirestore().collection('companies').doc(companyId).get();
        if (!doc.exists) return { status: 404, error: 'Company not found' };
        if (doc.data().ownerUid !== caller.uid) {
            return { status: 403, error: 'Only the company owner can perform this action' };
        }
        return null;
    } catch (e) {
        console.error('Ownership check failed:', e.message);
        return { status: 500, error: 'Could not verify company ownership' };
    }
}

// api/_auth-edge.js
// Firebase ID token verification for EDGE runtime routes.
//
// firebase-admin requires Node APIs and cannot run on Edge, so this verifies
// the token directly: RS256 signature checked against Google's public JWKS
// using WebCrypto, then full claim validation.
//
// Use this ONLY in files that declare: export const config = { runtime: 'edge' };
// Node-runtime routes should import verifyCaller from './_auth.js' instead.

const FIREBASE_PROJECT_ID = 'nqv8-9092f';
const JWKS_URL   = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const ISSUER     = `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`;
const CLOCK_SKEW = 60; // seconds of tolerance for clock drift

// Google rotates signing keys roughly daily. Cache per isolate.
let _jwksCache   = null;
let _jwksExpires = 0;

async function getKey(kid) {
    const now = Date.now();
    if (!_jwksCache || now >= _jwksExpires) {
        const res = await fetch(JWKS_URL);
        if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
        const body = await res.json();

        // Honour Cache-Control from Google, default 1 hour, clamp to 24h
        let maxAge = 3600;
        const cc = res.headers.get('cache-control') || '';
        const m  = cc.match(/max-age=(\d+)/);
        if (m) maxAge = Math.min(parseInt(m[1], 10), 86400);

        _jwksCache   = body.keys || [];
        _jwksExpires = now + (maxAge * 1000);
    }
    return _jwksCache.find(k => k.kid === kid) || null;
}

function b64urlToBytes(s) {
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function b64urlToJson(s) {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

/**
 * Verify the caller of an Edge route.
 * @returns {Promise<{uid: string|null, service: boolean}|null>} null if invalid
 */
export async function verifyCallerEdge(req, opts = {}) {
    const { allowService = true } = opts;

    const header = req.headers.get('authorization') || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) return null;

    // Server-to-server secrets (crons, internal jobs)
    if (allowService) {
        if (process.env.INTERNAL_API_SECRET && token === process.env.INTERNAL_API_SECRET) {
            return { uid: null, service: true };
        }
        if (process.env.CRON_SECRET && token === process.env.CRON_SECRET) {
            return { uid: null, service: true };
        }
    }

    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const [headerB64, payloadB64, sigB64] = parts;

        const jwtHeader = b64urlToJson(headerB64);
        if (jwtHeader.alg !== 'RS256') return null;
        if (!jwtHeader.kid) return null;

        const jwk = await getKey(jwtHeader.kid);
        if (!jwk) return null; // unknown signing key

        const key = await crypto.subtle.importKey(
            'jwk',
            { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['verify']
        );

        const valid = await crypto.subtle.verify(
            'RSASSA-PKCS1-v1_5',
            key,
            b64urlToBytes(sigB64),
            new TextEncoder().encode(`${headerB64}.${payloadB64}`)
        );
        if (!valid) return null;

        // ── Claim validation — a valid signature alone is not enough ──────
        const p   = b64urlToJson(payloadB64);
        const now = Math.floor(Date.now() / 1000);

        if (p.aud !== FIREBASE_PROJECT_ID) return null;  // token from another project
        if (p.iss !== ISSUER)              return null;
        if (!p.sub || typeof p.sub !== 'string') return null;
        if (typeof p.exp !== 'number' || p.exp <= now - CLOCK_SKEW) return null;  // expired
        if (typeof p.iat !== 'number' || p.iat >  now + CLOCK_SKEW) return null;  // issued in future
        if (typeof p.auth_time === 'number' && p.auth_time > now + CLOCK_SKEW) return null;

        return { uid: p.sub, service: false };

    } catch (e) {
        console.warn('Edge token verification failed:', e.message);
        return null;
    }
}

/** Standard 401 for Edge routes. */
export function unauthorizedEdge() {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
    });
}

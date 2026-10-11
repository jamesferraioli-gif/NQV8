// api/_voucher.js
// HMAC-signed, single-use, short-lived proof that a user paid for a paid feature.
//
// Uses WebCrypto only, so the same module works on both Node and Edge runtimes.
// Issued by claim-voucher.js (Node — can read the chain and Firestore).
// Verified by the paid Edge endpoints, which can do neither.
//
// Format:  base64url(JSON payload) + "." + base64url(HMAC-SHA256)
// Payload: { uid, purpose, txHash, exp }

const ENC = new TextEncoder();

function b64urlEncode(bytes) {
    let bin = '';
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(s) {
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
}

function b64urlDecodeToString(s) {
    return new TextDecoder().decode(b64urlToBytes(s));
}

async function hmacKey() {
    const secret = process.env.VOUCHER_SECRET;
    if (!secret) throw new Error('VOUCHER_SECRET not configured');
    return crypto.subtle.importKey(
        'raw', ENC.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false, ['sign', 'verify']
    );
}

/** Mint a voucher. ttlSeconds defaults to 10 minutes. */
export async function issueVoucher({ uid, purpose, txHash, ttlSeconds = 600 }) {
    const payload = {
        uid,
        purpose,
        txHash,
        exp: Math.floor(Date.now() / 1000) + ttlSeconds
    };
    const payloadB64 = b64urlEncode(ENC.encode(JSON.stringify(payload)));
    const key        = await hmacKey();
    const sig        = await crypto.subtle.sign('HMAC', key, ENC.encode(payloadB64));
    return `${payloadB64}.${b64urlEncode(sig)}`;
}

/**
 * Verify a voucher against an expected purpose, and optionally a uid.
 * @returns {Promise<{uid,purpose,txHash,exp}|null>} null if invalid
 */
export async function verifyVoucher(voucher, expectedPurpose, expectedUid = null) {
    try {
        if (!voucher || typeof voucher !== 'string') return null;
        const [payloadB64, sigB64] = voucher.split('.');
        if (!payloadB64 || !sigB64) return null;

        const key = await hmacKey();
        const ok  = await crypto.subtle.verify(
            'HMAC', key,
            b64urlToBytes(sigB64),
            ENC.encode(payloadB64)
        );
        if (!ok) return null;

        const p = JSON.parse(b64urlDecodeToString(payloadB64));

        if (p.purpose !== expectedPurpose) return null;
        if (expectedUid && p.uid !== expectedUid) return null;
        if (typeof p.exp !== 'number' || p.exp <= Math.floor(Date.now() / 1000)) return null;

        return p;
    } catch (e) {
        console.warn('Voucher verification failed:', e.message);
        return null;
    }
}

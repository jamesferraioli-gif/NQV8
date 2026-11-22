// api/_features.js
//
// The platform switches set from Studio → Grow → NQVate → Platform Features.
//
// They live in one Firestore document, platformConfig/features, which only
// the server reads and writes (through the Admin SDK), so no security rule
// has to be opened for it. The page asks /api/features for the current
// values; the money-moving endpoints ask getFeatures() directly, because
// hiding a button is not the same as turning a feature off.
//
//   fundingRequests  post a funding request, make or accept an investment offer
//   equityExchange   list a stake for sale, make or accept an offer on one
//   equityFeeFlat    true  = NQVate takes no units when an equity bounty pays
//                            out; its fee is the flat NQV8 posting fee
//                    false = NQVate takes 3.5% of the units
//
// FAILS CLOSED. If the document is missing or cannot be read, every switch
// takes the restrictive value below. An outage must never be what turns a
// gated feature on.

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

export const FEATURE_DEFAULTS = Object.freeze({
    fundingRequests: false,
    equityExchange:  false,
    equityFeeFlat:   true
});
export const FEATURE_KEYS = Object.keys(FEATURE_DEFAULTS);

/// A warm function instance reuses its last read for this long, so a change
/// made there reaches every endpoint within about ten seconds.
const CACHE_MS = 10_000;
let _cache = null, _cachedAt = 0;

function db() {
    if (!getApps().length) {
        initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    }
    return getFirestore();
}

export function featuresDoc() {
    return db().collection('platformConfig').doc('features');
}

/// Only real booleans count. Anything else in the document is ignored and
/// the restrictive default stands.
export function cleanFeatures(data) {
    const out = { ...FEATURE_DEFAULTS };
    for (const k of FEATURE_KEYS) {
        if (data && typeof data[k] === 'boolean') out[k] = data[k];
    }
    return out;
}

export async function getFeatures({ fresh = false } = {}) {
    if (!fresh && _cache && Date.now() - _cachedAt < CACHE_MS) return _cache;
    try {
        const snap = await featuresDoc().get();
        _cache = cleanFeatures(snap.exists ? snap.data() : null);
        _cachedAt = Date.now();
        return _cache;
    } catch (e) {
        console.error('getFeatures failed — using restrictive defaults:', e.message);
        return { ...FEATURE_DEFAULTS };
    }
}

export function forgetFeatures() { _cache = null; _cachedAt = 0; }

/// For the listing and offer endpoints, which funding requests and the equity
/// exchange share. Returns true (and has already answered) when both are off.
export async function equitySalesOff(res) {
    const f = await getFeatures();
    if (f.fundingRequests || f.equityExchange) return false;
    res.status(503).json({
        error: 'coming_soon',
        message: 'Funding requests and the equity exchange are not open yet.'
    });
    return true;
}

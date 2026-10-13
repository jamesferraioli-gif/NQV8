// api/valuate-equity.js
//
// Converted from Edge to Node. Two reasons:
//   1. Edge caps the initial response at 25s, the same cliff that broke
//      generate-flowmap. This endpoint also feeds the nightly
//      revaluate-equity cron, so a timeout here failed silently every night.
//   2. Edge cannot run firebase-admin, which is why this file carried ~45
//      lines of hand-rolled RS256 JWT signing to reach Firestore over REST.
//      On Node that is one import.
//
// The HTTP contract is unchanged — three frontend call sites and the
// revaluate-equity cron depend on it.

export const config = { maxDuration: 300 };

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { verifyCaller } from './_auth.js';
import { callAnthropicJSON } from './_ai.js';

if (!getApps().length) {
    initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
const db = getFirestore();

export default async function handler(req, res) {
    if (req.method !== 'POST' && req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const caller = await verifyCaller(req);
    if (!caller) return res.status(401).json({ error: 'Unauthorized' });

    const body       = req.body || {};
    const projectId  = body.projectId  ?? req.query?.projectId;

    if (!projectId) return res.status(400).json({ error: 'projectId required' });

    try {
        const f = await fetchCompany(projectId);

        const result = await callAnthropicJSON({
            maxTokens: 1500,
            messages: [{ role: 'user', content: buildPrompt(projectId, f) }]
        });

        // The previous version caught a parse failure and substituted an
        // invented valuation — $0.005/unit, $50 implied — returned with HTTP
        // 200 and no indication it was fabricated. Someone could have priced a
        // real equity sale off a number the model never produced. A failure is
        // now a failure.
        if (!result?.valuationRange || typeof result.suggestedAskPerUnit !== 'number') {
            throw new Error('Valuation response was missing its range or suggested ask');
        }

        return res.status(200).json({
            ...result,
            projectId,
            projectName: f.name || projectId,
            cachedAt:    Date.now(),
            fromCache:   false
        });

    } catch (e) {
        console.error('valuate-equity failed:', e.message);
        return res.status(502).json({ error: e.message });
    }
}

async function fetchCompany(projectId) {
    try {
        const doc = await db.collection('companies').doc(projectId).get();
        if (!doc.exists) return {};
        const d = doc.data() || {};
        return {
            name:            d.name            || '',
            category:        d.category        || '',
            entityType:      d.entityType      || '',
            description:     d.description     || '',
            revenue:         d.revenue         || '',
            userCount:       d.userCount       || '',
            growthRate:      d.growthRate      || '',
            fundingRaised:   d.fundingRaised    || '',
            website:         d.website         || '',
            isActive:        !!d.isActive,
            metricsVerified: !!d.metricsVerified,
            revenueBucket:   d.revenueBucket   || '',
            usersBucket:     d.usersBucket     || '',
            statsUpdatedAt:  d.statsUpdatedAt  || null
        };
    } catch (e) {
        // A missing company is not fatal — the prompt handles sparse data and
        // says so in its confidence rating.
        console.warn('company fetch failed:', e.message);
        return {};
    }
}

function buildPrompt(projectId, f) {
    return `You are an equity valuation analyst for NQVate, a decentralized marketplace where micro-startups tokenize equity as on-chain stakes (10,000 units = 100% of company).

Produce a fair value range for equity units in this project. Be realistic — these are early-stage micro-startups.

=== PROJECT DATA ===
Name: ${f.name || projectId}
Category: ${f.category || 'Unknown'}
Entity Type: ${f.entityType || 'Unknown'}
Description: ${f.description || 'Not provided'}
Active: ${f.isActive ? 'Yes (live product)' : 'No / In development'}
Website: ${f.website || 'None'}

=== METRICS ===
${f.metricsVerified ? `Claude AI Verified:
  Revenue: ${f.revenueBucket || 'Not disclosed'}
  Users: ${f.usersBucket || 'Not disclosed'}` : `Self-reported (unverified):
  Revenue: ${f.revenue || 'Not disclosed'}
  Users: ${f.userCount || 'Not disclosed'}
  Growth: ${f.growthRate || 'Not disclosed'}
  Funding Raised: ${f.fundingRaised || 'None'}`}

Metrics last updated: ${f.statsUpdatedAt || 'Never'}

=== VALUATION GUIDANCE ===
- Pre-revenue/pre-product: $100-$2,000 total implied valuation
- Early revenue ($1-$500/mo): $2,000-$10,000 implied
- Growing ($500-$2,000/mo): $10,000-$50,000 implied
- Established ($2,000-$10,000/mo): $50,000-$200,000 implied
- Apply 20-40% discount for no disclosed metrics or unverified
- Apply 15-25% liquidity discount (illiquid private stakes)
- Claude-verified metrics should be weighted more than self-reported

Respond ONLY with valid JSON, no markdown:
{
  "valuationRange": { "low": 0.00, "mid": 0.00, "high": 0.00 },
  "impliedValuation": { "low": 0, "mid": 0, "high": 0 },
  "suggestedAskPerUnit": 0.00,
  "methodology": "2-3 sentence explanation",
  "keyFactors": [
    { "factor": "description", "impact": "positive" },
    { "factor": "description", "impact": "negative" }
  ],
  "comparablesUsed": [],
  "confidence": "low",
  "warnings": ["any caveats for buyers"]
}

Values: valuationRange in USDC per unit (e.g. 0.05 = $0.05/unit = $500 total), impliedValuation = range × 10,000, confidence: "high"|"medium"|"low"`;
}

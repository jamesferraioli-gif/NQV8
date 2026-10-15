// api/improve-posting.js
//
// Claude's review of a posting before it goes live. Returns three things:
//   - improved  : a tighter description
//   - changes   : what it changed, for the diff modal
//   - timeframe : how long the work should realistically take
//
// The timeframe used to live in api/estimate-timeframe.js, called AFTER the
// posting was written. That meant the founder — the one person who sets the
// target — never saw it, and it cost a second Anthropic call per posting. It
// belongs here: one call, at the moment the founder is deciding.
//
// estimate-timeframe.js stays as the fallback for postings made before this
// change, and for a founder who somehow reaches submit without a review.
//
// Converted from CommonJS and off hand-rolled fetch onto _ai.js, which brings
// retries on transient failures, status-aware error classification, and an
// explicit throw on max_tokens truncation instead of a silent half-answer.

export const config = { maxDuration: 60 };

import { verifyCaller } from './_auth.js';
import { callAnthropicJSON } from './_ai.js';

// Must stay in step with TIMEFRAME_OPTIONS in index.html and VALID in
// estimate-timeframe.js. These are the only durations the escrow can express.
const VALID = ['1day', '3days', '1week', '2weeks', '1month', '2months', '3months'];

// The only bond rates Claude can select between. Keep in step with
// BOND_RATE_BPS in index.html — the frontend quotes the amount to the bidder
// and the server locks it, so a mismatch would show one number and charge
// another.
const BOND_RATE_BPS = { low: 1000, standard: 1500, high: 2500 };

/**
 * Pull a usable timeframe out of the model's answer, or null.
 *
 * Returning null rather than throwing is deliberate: a posting that has
 * already been paid for must never fail because the estimator was wrong about
 * a duration string. The founder simply sees no estimate.
 */
function sanitizeTimeframe(t) {
    if (!t || typeof t !== 'object') return null;

    for (const k of ['low', 'recommended', 'high']) {
        if (!VALID.includes(t[k])) return null;
    }
    // A range that runs backwards is nonsense, not a conservative guess.
    if (VALID.indexOf(t.low) > VALID.indexOf(t.recommended) ||
        VALID.indexOf(t.recommended) > VALID.indexOf(t.high)) {
        return null;
    }

    return {
        low:         t.low,
        recommended: t.recommended,
        high:        t.high,
        confidence:  ['high', 'medium', 'low'].includes(t.confidence) ? t.confidence : 'low',
        reasoning:   String(t.reasoning || '').slice(0, 400),
        scopeRisks:  Array.isArray(t.scopeRisks)
                       ? t.scopeRisks.slice(0, 3).map(s => String(s).slice(0, 160))
                       : [],
        estimatedAt: new Date().toISOString(),
        source:      'improve-posting'
    };
}

const SYSTEM_PROMPT = `You are a marketplace posting editor for NQVate, a decentralized marketplace for builders and ideas.

You do two jobs in one pass:

1. IMPROVE THE DESCRIPTION so it is clear, concrete, and attracts quality bids.

A great posting must include:
- Specific, measurable deliverables (not vague goals)
- Clear scope boundaries (what is and isn't included)
- Technical requirements or stack preferences if relevant
- Success criteria — how will the poster know it's done?

Rules:
- Keep the same intent and tone as the original
- Do NOT invent requirements that weren't implied
- Do NOT change the compensation or category
- Keep it concise — no fluff, no filler sentences
- Do NOT write a timeline into the description; the timeframe is a separate
  structured field below and the platform handles it

2. ESTIMATE THE TIMEFRAME the work should realistically take.

This estimate is shown to the founder as they set their target, and to every
builder who bids. A builder who misses the agreed deadline forfeits a staked
bond, so an unrealistically short estimate does real financial harm. Err
toward what a competent professional would actually need, including review and
revision cycles — not a best case with nothing going wrong.

Judge the ORIGINAL description's scope, not how well it is written. Pick from
exactly these options, the only durations the platform supports:
1day, 3days, 1week, 2weeks, 1month, 2months, 3months

- "low" is the fastest a strong, focused builder could finish it properly
- "recommended" is what you would advise both parties agree to
- "high" is a safe allowance if the scope is vaguer than it looks

Consider: how much is genuinely specified versus left open, whether it needs
design as well as build, integration with systems the builder cannot control,
and review or feedback rounds. A vague description deserves a LONGER estimate,
not a shorter one, and the reasoning should say so. If the description is too
thin to judge, set "confidence" to "low", say so in "reasoning", and still
give your best range.

3. RATE THE DELIVERY RISK, which sets how much collateral a builder must stake.

The builder posts a bond worth a percentage of the bounty. You choose only the
PERCENTAGE BAND, never an amount — the platform converts it using a price you
do not have:

- "low"      (10%) well-specified, self-contained, easy to redo if it goes wrong
- "standard" (15%) the normal case
- "high"     (25%) vague scope, touches live or production systems, depends on
                   third parties, or a failure is expensive to recover from

Rate the WORK, not the money: a large bounty is not automatically high risk, and
a small one is not automatically low. Judge the original description's scope, and
when genuinely unsure choose "standard".

Return ONLY a JSON object, no markdown, no explanation:
{
  "improved": "the improved description text here",
  "changes": ["change 1", "change 2", "change 3"],
  "timeframe": {
    "low": "one of the options",
    "recommended": "one of the options",
    "high": "one of the options",
    "confidence": "high" | "medium" | "low",
    "reasoning": "1-2 sentences a non-technical founder would understand",
    "scopeRisks": ["up to 3 short notes on what could make this take longer"]
  },
  "riskTier": "low" | "standard" | "high",
  "riskReason": "one sentence on why this tier"
}`;

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

    const caller = await verifyCaller(req);
    if (!caller) return res.status(401).json({ error: 'Unauthorized' });

    const { title, description, category, compensation, compensationType, postingType } = req.body || {};

    if (!description || description.trim().length < 10) {
        return res.status(400).json({ error: 'Description too short' });
    }

    const userPrompt = `Improve this ${postingType === 'fund' ? 'funding request' : 'build request'} posting and estimate its timeframe.

Title: ${title || 'Untitled'}
Category: ${category || 'General'}
Compensation Type: ${compensationType || 'cash'}
Compensation offered: ${compensation || 'Not specified'}

Original Description:
${description}

Return only the JSON object.`;

    try {
        const parsed = await callAnthropicJSON({
            maxTokens: 2000,
            system:    SYSTEM_PROMPT,
            messages:  [{ role: 'user', content: userPrompt }],
            // Must stay UNDER maxDuration above. _ai.js defaults to 240s, which
            // is longer than the function is allowed to live: Vercel would kill
            // it at 60s and the browser would get an opaque 504 instead of the
            // real reason. Aborting at 50s leaves room to return a 502 that
            // says what happened — the same mistake that made the flowmap
            // timeout so hard to diagnose.
            timeoutMs: 50000
        });

        // The description half is the contract the posting flow depends on.
        if (!parsed.improved || !Array.isArray(parsed.changes)) {
            return res.status(502).json({ error: 'Claude did not return a usable posting review' });
        }

        return res.status(200).json({
            improved:  String(parsed.improved).trim(),
            changes:   parsed.changes.slice(0, 8).map(c => String(c).slice(0, 240)),
            // null when the model returned something unusable — the caller
            // shows no estimate rather than a fabricated one.
            timeframe: sanitizeTimeframe(parsed.timeframe),

            // The bond RATE only. The NQV8 amount is computed by the caller,
            // clamped to a floor and cap, so even a fully successful prompt
            // injection moves the bond between 10% and 25% and no further.
            riskTier:    BOND_RATE_BPS[parsed.riskTier] ? parsed.riskTier : 'standard',
            bondRateBps: BOND_RATE_BPS[parsed.riskTier] || BOND_RATE_BPS.standard,
            riskReason:  String(parsed.riskReason || '').slice(0, 300)
        });

    } catch (e) {
        console.error('improve-posting failed:', e.message);
        return res.status(502).json({ error: e.message });
    }
}

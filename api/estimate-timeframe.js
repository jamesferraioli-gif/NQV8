// api/estimate-timeframe.js
//
// Claude's view of how long a bounty should realistically take.
//
// Advisory only, and that shapes the whole design:
//   - It runs once at post time and the result is cached on the project, so
//     every bidder sees the SAME figure. An estimate that varied per bidder
//     would be unfair input into a negotiation.
//   - A failure returns 200 with { unavailable: true } rather than an error,
//     because a dead estimator must never stop someone posting a bounty.
//
// Note the difference from verify-docs, which used to return 200 with
// "approved: false" on failure: that was a *verdict* the service never
// reached, shown to the user as fact. Saying "no estimate available" is
// honest. Saying "rejected" when nothing was checked is not.

export const config = { maxDuration: 60 };

import { verifyCaller } from './_auth.js';
import { callAnthropicJSON } from './_ai.js';

// Must stay in step with TIMEFRAME_OPTIONS in index.html.
const VALID = ['1day', '3days', '1week', '2weeks', '1month', '2months', '3months'];

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const caller = await verifyCaller(req);
    if (!caller) return res.status(401).json({ error: 'Unauthorized' });

    const { title, description, category, compensation, compensationType } = req.body || {};

    if (!description || !String(description).trim()) {
        return res.status(400).json({ error: 'A task description is required' });
    }

    try {
        const r = await callAnthropicJSON({
            maxTokens: 800,
            messages: [{
                role: 'user',
                content: `You are estimating how long a freelance software/creative task will realistically take, for NQVate — a marketplace where founders post bounties and builders bid on them.

Your estimate is shown to BOTH sides before they agree terms. The founder uses it to set a fair target; the builder uses it to avoid promising something they cannot deliver. A builder who misses the agreed deadline forfeits a staked bond, so an unrealistically short estimate does real financial harm. Err toward what a competent professional would actually need, including review and revision cycles — not a best case with nothing going wrong.

=== THE TASK ===
Title: ${title || 'Not provided'}
Category: ${category || 'Not specified'}
Compensation offered: ${compensation || 'Not specified'}${compensationType ? ` (${compensationType})` : ''}

Description:
${description}

=== HOW TO CHOOSE ===
Pick from exactly these options, which are the only durations the platform supports:
1day, 3days, 1week, 2weeks, 1month, 2months, 3months

- "low" is the fastest a strong, focused builder could finish it properly
- "recommended" is what you would advise both parties agree to
- "high" is a safe allowance if the scope is vaguer than it looks

Consider: how much is genuinely specified versus left open, whether it needs design as well as build, integration with systems the builder cannot control, and review or feedback rounds. A vague description deserves a LONGER estimate, not a shorter one, and the reasoning should say so.

If the description is too thin to judge, say so in "reasoning", set "confidence" to "low", and still give your best range.

Respond ONLY with valid JSON, no markdown:
{
  "low": "one of the options",
  "recommended": "one of the options",
  "high": "one of the options",
  "confidence": "high" | "medium" | "low",
  "reasoning": "1-2 sentences a non-technical founder would understand",
  "scopeRisks": ["up to 3 short notes on what could make this take longer"]
}`
            }]
        });

        // The model must choose from the platform's own durations — anything
        // else cannot be turned into an escrow deadline.
        for (const k of ['low', 'recommended', 'high']) {
            if (!VALID.includes(r?.[k])) {
                throw new Error(`Estimator returned "${r?.[k]}" for ${k}, which is not a supported duration`);
            }
        }
        // Guard against a nonsensical range.
        if (VALID.indexOf(r.low) > VALID.indexOf(r.recommended) ||
            VALID.indexOf(r.recommended) > VALID.indexOf(r.high)) {
            throw new Error('Estimator returned a range that is not in order');
        }

        return res.status(200).json({
            low:         r.low,
            recommended: r.recommended,
            high:        r.high,
            confidence:  ['high', 'medium', 'low'].includes(r.confidence) ? r.confidence : 'low',
            reasoning:   String(r.reasoning || '').slice(0, 400),
            scopeRisks:  Array.isArray(r.scopeRisks) ? r.scopeRisks.slice(0, 3).map(s => String(s).slice(0, 160)) : [],
            estimatedAt: new Date().toISOString()
        });

    } catch (e) {
        // Honest "no estimate", not a fabricated one. The caller shows nothing.
        console.warn('estimate-timeframe unavailable:', e.message);
        return res.status(200).json({ unavailable: true, reason: e.message });
    }
}

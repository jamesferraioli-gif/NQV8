// api/_aikinds.js
// The registry of paid AI jobs. One entry per purpose: what it costs, whether
// its input is small enough to persist for a retry, and how to run it.
//
// This is also the single source of truth for NQV8 prices on the server side —
// claim-voucher.js imports it rather than keeping a second copy that could
// drift out of sync.

import { callAnthropicJSON } from './_ai.js';
import { runFlowmap } from './_plan.js';
import { runDeck } from './_deck.js';

export const AI_KINDS = {

    'generate-flowmap': {
        priceNQV8: 500,
        // Small JSON input — safe to store on the job doc, so a dead worker
        // can be retried by the sweep without the user paying again.
        storeInput: true,
        label: 'development plan',
        // Two passes: an outline of the whole plan, then every part written
        // up in full, in parallel. See _plan.js.
        run: (input) => runFlowmap(input)
    },

    'verify-metrics': {
        priceNQV8: 100,
        // The input can carry three base64 documents, far past what a job
        // document can hold, so it is never stored. The runner retries a busy
        // upstream itself; a failure it cannot get past refunds the fee.
        storeInput: false,
        label: 'metrics verification and investor deck',
        // Reads the company's site, checks the claimed figures against any
        // documents, and writes the deck. See _deck.js.
        run: (input) => runDeck(input)
    },

    'verify-docs': {
        priceNQV8: 1000,
        // Input is three base64 documents — far past Firestore's ~1MB document
        // ceiling, so it is never persisted. A dead worker therefore cannot be
        // retried and the sweep refunds instead. The money is still safe,
        // which is the property that matters.
        storeInput: false,
        label: 'entity verification',

        async run({ incorporationBase64, incorporationMediaType,
                    einBase64, einMediaType, idBase64, idMediaType,
                    companyName, entityType }) {

            if (!incorporationBase64 || !einBase64 || !idBase64) {
                throw new Error('All three documents are required');
            }

            const makeBlock = (base64, mediaType) => (
                mediaType === 'application/pdf'
                    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
                    : { type: 'image',    source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: base64 } }
            );

            const result = await callAnthropicJSON({
                // The old 500 could truncate a verbose rejection mid-array,
                // which then read as a parse failure.
                maxTokens: 1500,
                messages: [{
                    role: 'user',
                    content: [
                        makeBlock(incorporationBase64, incorporationMediaType),
                        makeBlock(einBase64, einMediaType),
                        makeBlock(idBase64, idMediaType),
                        { type: 'text', text: `You are a business document verifier for NQVate, a Web3 marketplace platform.

A user is submitting documents to verify their business entity for equity features.
Company name claimed: "${companyName}"
Entity type claimed: "${entityType}"

The three documents provided are:
1. Articles of Incorporation / Formation document
2. EIN / Tax ID document
3. Government-issued ID of the authorized representative

IMPORTANT NAME MATCHING RULES:
- Name matching is case-insensitive ("NQVate" = "NQVATE" = "nqvate")
- Ignore entity suffixes when comparing ("NQVate" matches "NQVATE LLC" or "NQVate LLC")
- Partial matches are acceptable if the core business name is present

Approve if:
- The core company name appears on the formation document (case-insensitive, ignoring LLC/Inc/Corp)
- An EIN or Tax ID number is visible on the tax document
- A government ID is present and appears legitimate
- No obvious signs of tampering or fraud

Only reject if documents are completely unreadable, clearly fraudulent, or a completely different company name appears.

Respond ONLY with valid JSON:
{
  "approved": true or false,
  "confidence": "high", "medium", or "low",
  "companyNameMatch": true or false,
  "entityTypeMatch": true or false,
  "idPresent": true or false,
  "issues": ["specific issue 1"],
  "missingDocuments": [],
  "recommendation": "specific actionable advice if rejected",
  "summary": "one sentence summary"
}
Respond with JSON only, no other text.` }
                    ]
                }]
            });

            // A verdict must actually be a verdict. The old endpoint returned
            // HTTP 200 with { approved: false, summary: "API error: ..." } for
            // every failure, so a service outage was shown to the user as a
            // document rejection — after they had paid 1,000 NQV8 for it.
            // Throwing instead routes it to the refund path.
            if (typeof result?.approved !== 'boolean') {
                throw new Error('Verifier did not return an approval decision');
            }
            return result;
        }
    }
};

export function getKind(kind) {
    return AI_KINDS[kind] || null;
}

/** Server-side price table. Mirrors NQV8_FEE in index.html. */
export const PURPOSE_PRICE_NQV8 = Object.fromEntries(
    Object.entries(AI_KINDS).map(([k, v]) => [k, v.priceNQV8])
);

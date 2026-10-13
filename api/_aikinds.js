// api/_aikinds.js
// The registry of paid AI jobs. One entry per purpose: what it costs, whether
// its input is small enough to persist for a retry, and how to run it.
//
// This is also the single source of truth for NQV8 prices on the server side —
// claim-voucher.js imports it rather than keeping a second copy that could
// drift out of sync.

import { callAnthropicJSON } from './_ai.js';

export const AI_KINDS = {

    'generate-flowmap': {
        priceNQV8: 500,
        // Small JSON input — safe to store on the job doc, so a dead worker
        // can be retried by the sweep without the user paying again.
        storeInput: true,
        label: 'development flow map',

        async run({ name, description, stack }) {
            if (!description || !String(description).trim()) {
                throw new Error('A project description is required');
            }

            const parsed = await callAnthropicJSON({
                // Each node carries a description, multi-sentence instructions,
                // 3-5 best practices, 2-4 pitfalls and a tools list — roughly
                // 350 tokens. Sixteen of those needs far more than the 4000
                // this started with, which truncated mid-node.
                maxTokens: 16000,
                messages: [{
                    role: 'user',
                    content: `You are a senior software architect and product manager. Generate a detailed development flow map for the following project.

Project Name: ${name || 'Untitled project'}
Tech Stack: ${stack || 'Not specified'}
Description: ${description}

Return ONLY a JSON object with this exact structure (no markdown, no explanation):
{
  "nodes": [
    {
      "title": "Short node title",
      "description": "2-3 sentence description of what this step involves",
      "category": "one of: Frontend, Backend, Database, Auth, API, Infrastructure, Testing, Design, Marketing, Legal, Other",
      "priority": "high or normal",
      "estimatedHours": number or null,
      "dependencies": ["titles of nodes this depends on"],
      "instructions": "Detailed step-by-step instructions for completing this node. Be specific and technical. 3-6 sentences.",
      "bestPractices": ["array of 3-5 specific best practices for this step"],
      "pitfalls": ["array of 2-4 common mistakes to avoid"],
      "tools": ["array of recommended libraries, tools, or services"],
      "status": "todo"
    }
  ]
}

Generate 8-16 nodes ordered logically from foundation to launch. Each node should be a discrete, buildable unit of work. Be specific to the tech stack and project type described.`
                }]
            });

            if (!Array.isArray(parsed?.nodes) || parsed.nodes.length === 0) {
                throw new Error('Model returned no flow map nodes');
            }
            return parsed;
        }
    },

    'verify-metrics': {
        priceNQV8: 100,
        storeInput: true,
        label: 'metrics verification'
        // run() is supplied by verify-metrics.js, which needs Firestore and
        // chain reads this module deliberately does not import.
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

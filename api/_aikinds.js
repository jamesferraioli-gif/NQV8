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
        // Input is three base64 document images — far past Firestore's ~1MB
        // document ceiling, so it is never persisted. A dead worker therefore
        // cannot be retried and the sweep refunds instead. The user's money is
        // still safe, which is the property that matters.
        storeInput: false,
        label: 'entity verification'
    }
};

export function getKind(kind) {
    return AI_KINDS[kind] || null;
}

/** Server-side price table. Mirrors NQV8_FEE in index.html. */
export const PURPOSE_PRICE_NQV8 = Object.fromEntries(
    Object.entries(AI_KINDS).map(([k, v]) => [k, v.priceNQV8])
);

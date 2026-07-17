export const config = { runtime: 'edge' };

export default async function handler(req) {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    try {
        const {
            revenueBase64, revenueMediaType,
            usersBase64, usersMediaType,
            optionalBase64, optionalMediaType,
            companyName, entityType, description, website,
            claimedRevenue, claimedUsers
        } = await req.json();

        const apiKey = process.env.ANTHROPIC_API_KEY;
        const hasDocuments = !!(revenueBase64 || usersBase64);

        const makeBlock = (base64, mediaType) => {
            if (!base64) return null;
            if (mediaType === 'application/pdf') {
                return { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } };
            }
            return { type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: base64 } };
        };

        const docBlocks = [
            makeBlock(revenueBase64, revenueMediaType),
            makeBlock(usersBase64, usersMediaType),
            optionalBase64 ? makeBlock(optionalBase64, optionalMediaType) : null,
        ].filter(Boolean);

        // ── Step 1: Fetch website HTML directly ───────────────────────────
        let websiteContent = '';
        if (website) {
            try {
                const url = website.startsWith('http') ? website : `https://${website}`;
                const siteResp = await fetch(url, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NQVate/1.0)' },
                    signal: AbortSignal.timeout(8000)
                });
                const html = await siteResp.text();

                // Strip HTML tags and extract readable text
                websiteContent = html
                    .replace(/<script[\s\S]*?<\/script>/gi, '')
                    .replace(/<style[\s\S]*?<\/style>/gi, '')
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .substring(0, 3000); // First 3000 chars of readable text

            } catch(e) {
                console.warn('Website fetch failed:', e.message);
                websiteContent = '';
            }
        }

        // ── Step 2: Generate deck ─────────────────────────────────────────
        const contextSection = websiteContent
            ? `WEBSITE CONTENT (fetched directly from ${website}):\n${websiteContent}\n\nUse this website content as the primary source for the deck. It reflects what the company actually is.`
            : `No website content available. Use the founder description below as the primary source.`;

        const textBlock = {
            type: "text",
            text: `You are a startup analyst writing an investor deck. Return ONLY valid JSON — no preamble, no explanation, no markdown.

COMPANY: "${companyName}" (${entityType})
Founder description: "${description}"

${contextSection}

Claimed revenue: "${claimedRevenue}"
Claimed users: "${claimedUsers}"
Has proof documents: ${hasDocuments}

${!hasDocuments ? 'No documents provided — valid for pre-launch. Set metricsVerified=true, issues=[], revenueMatch=true, usersMatch=true, confidence="high".' : 'Review the attached documents and verify the claimed metrics.'}

Write a compelling, accurate investor deck based on what the company actually does. Do not invent features, revenue streams, or statistics not found in the website content or description.

Revenue buckets: "Pre-revenue","$1-$500/mo","$500-$2,000/mo","$2,000-$5,000/mo","$5,000-$10,000/mo","$10,000-$25,000/mo","$25,000+/mo"
User buckets: "Pre-launch","1-50 users","50-250 users","250-1,000 users","1,000-5,000 users","5,000-25,000 users","25,000+ users"

Return ONLY this JSON structure with all fields filled in:
{"metricsVerified":true,"confidence":"high","revenueBucket":"Pre-revenue","usersBucket":"Pre-launch","revenueMatch":true,"usersMatch":true,"issues":[],"summary":"Metrics accepted","deck":{"tagline":"","problem":"","solution":"","traction":"","marketOpportunity":"","businessModel":"","whyNow":"","useOfFunds":"","highlights":["","","","",""]}}`
        };

        // ── Step 3: Call Claude for deck (no tools) ───────────────────────
        let data;
        for (let attempt = 1; attempt <= 3; attempt++) {
            const deckResp = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": apiKey,
                    "anthropic-version": "2023-06-01"
                },
                body: JSON.stringify({
                    model: "claude-sonnet-4-6",
                    max_tokens: 2000,
                    messages: [{ role: "user", content: [...docBlocks, textBlock] }]
                })
            });

            const rawDeck = await deckResp.text();

            try {
                data = JSON.parse(rawDeck);
            } catch(e) {
                return new Response(JSON.stringify({
                    metricsVerified: false,
                    summary: "API returned non-JSON: " + rawDeck.substring(0, 200)
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }

            if (data.error?.type === 'overloaded_error' && attempt < 3) {
                await new Promise(r => setTimeout(r, 3000 * attempt));
                continue;
            }
            break;
        }

        if (data.error) {
            return new Response(JSON.stringify({
                metricsVerified: false,
                summary: "API error: " + data.error.type + ' — ' + data.error.message
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        const textContent = (data.content || []).find(b => b.type === 'text');
        if (!textContent) {
            return new Response(JSON.stringify({
                metricsVerified: false,
                summary: "No text in response. Types: " + (data.content || []).map(b => b.type).join(', ')
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        let resultText = textContent.text.trim()
            .replace(/```json\n?/g, '')
            .replace(/```\n?/g, '')
            .trim();

        const jsonMatch = resultText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return new Response(JSON.stringify({
                metricsVerified: false,
                summary: "Response not JSON: " + resultText.substring(0, 200)
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        const parsed = JSON.parse(jsonMatch[0]);

        if (!hasDocuments) {
            parsed.metricsVerified = true;
            parsed.issues = [];
            parsed.revenueMatch = true;
            parsed.usersMatch = true;
            parsed.confidence = 'high';
        }

        return new Response(JSON.stringify(parsed), {
            status: 200, headers: { 'Content-Type': 'application/json' }
        });

    } catch(e) {
        return new Response(JSON.stringify({
            metricsVerified: false,
            summary: "Service error: " + e.message
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
}

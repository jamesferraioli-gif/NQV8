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

        const makeBlock = (base64, mediaType) => {
            if (!base64) return null;
            if (mediaType === 'application/pdf') {
                return { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } };
            }
            return { type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: base64 } };
        };

        const hasDocuments = !!(revenueBase64 || usersBase64);

        const contentBlocks = [
            makeBlock(revenueBase64, revenueMediaType),
            makeBlock(usersBase64, usersMediaType),
            optionalBase64 ? makeBlock(optionalBase64, optionalMediaType) : null,
        ].filter(Boolean);

        const noDocsInstructions = `No proof documents were provided. The founder has self-declared "${claimedRevenue}" revenue and "${claimedUsers}" user status. This is VALID and acceptable for pre-revenue or pre-launch companies. Set metricsVerified to true, issues to [], revenueMatch to true, usersMatch to true, confidence to "high".`;

        const withDocsInstructions = `The documents provided are proof of revenue and/or user metrics. Review them and assign the company to the correct buckets.`;

        contentBlocks.push({
            type: "text",
            text: `You are a startup analyst and investor deck writer. Your task has two parts:

PART 1 — RESEARCH THE COMPANY
You have been given the following information about a company:
- Name: "${companyName}"
- Entity Type: "${entityType}"  
- Website: "${website || 'Not provided'}"
- Description provided by founder: "${description}"
- Founder claims monthly revenue: "${claimedRevenue}"
- Founder claims user count: "${claimedUsers}"

${website ? `IMPORTANT: Use the web_search tool to visit "${website}" and any other relevant pages to understand what the company actually does. Read the real product, features, pricing, and value proposition directly from their website. Do not rely solely on the founder's description — verify it against what the website actually shows. If the website and description conflict, trust what the website shows.` : 'No website provided — base the deck on the founder description only, and note this in the deck.'}

PART 2 — VERIFY METRICS
${hasDocuments ? withDocsInstructions : noDocsInstructions}

Revenue buckets: "Pre-revenue", "$1-$500/mo", "$500-$2,000/mo", "$2,000-$5,000/mo", "$5,000-$10,000/mo", "$10,000-$25,000/mo", "$25,000+/mo"
User buckets: "Pre-launch", "1-50 users", "50-250 users", "250-1,000 users", "1,000-5,000 users", "5,000-25,000 users", "25,000+ users"

PART 3 — WRITE THE INVESTOR DECK
Based on your research of the actual company (website + description), write a compelling investor deck.

Rules:
- Every claim must be grounded in what you actually found — do not invent features, revenue streams, or statistics
- Write in a confident, direct investor voice
- For pre-launch companies, focus on what has actually been built, not speculative momentum
- Highlights must be specific and concrete, not generic startup buzzwords
- The tagline must accurately describe what the company actually does

Respond ONLY with valid JSON:
{
  "metricsVerified": true or false,
  "confidence": "high", "medium", or "low",
  "revenueBucket": one of the revenue buckets above,
  "usersBucket": one of the user buckets above,
  "revenueMatch": true or false,
  "usersMatch": true or false,
  "issues": [],
  "summary": "one sentence verification summary",
  "deck": {
    "tagline": "one punchy accurate sentence describing exactly what the company does",
    "problem": "2-3 sentences describing the specific problem this company solves",
    "solution": "2-3 sentences describing what the product actually does, using specific features you found",
    "traction": "2-3 sentences about what has actually been built or achieved",
    "marketOpportunity": "2-3 sentences about the relevant market opportunity",
    "businessModel": "2-3 sentences describing only the revenue streams you confirmed exist",
    "whyNow": "1-2 sentences about why this moment is right for this specific product",
    "useOfFunds": "2-3 sentences about what funding will be used for",
    "highlights": ["5-7 specific concrete highlights drawn from your research"]
  }
}
Respond with JSON only, no other text.`
        });

        // ── Call Claude API with web search tool + auto-retry ─────────────
        let data;
        const MAX_RETRIES = 3;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            const response = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": process.env.ANTHROPIC_API_KEY,
                    "anthropic-version": "2023-06-01"
                },
                body: JSON.stringify({
                    model: "claude-sonnet-4-6",
                    max_tokens: 4000,
                    tools: [
                        {
                            type: "web_search_20250305",
                            name: "web_search"
                        }
                    ],
                    messages: [{ role: "user", content: contentBlocks }]
                })
            });

            data = await response.json();

            if (data.error?.type === 'overloaded_error' && attempt < MAX_RETRIES) {
                const delay = 3000 * attempt;
                await new Promise(r => setTimeout(r, delay));
                continue;
            }

            break;
        }

        if (!data.content) {
            return new Response(JSON.stringify({ 
                metricsVerified: false, 
                summary: "API error: " + JSON.stringify(data) 
            }), {
                status: 200, headers: { 'Content-Type': 'application/json' }
            });
        }

        // ── Extract final text response (after tool use) ──────────────────
        // Claude may use web_search tool first, then respond with text
        // We need the last text block which contains the JSON
        const textBlocks = data.content.filter(b => b.type === 'text');
        const resultText = (textBlocks[textBlocks.length - 1]?.text?.trim() || '')
            .replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

        // If Claude used tools but stopped (stop_reason: 'tool_use'), 
        // we need to continue the conversation to get the final answer
        if (data.stop_reason === 'tool_use') {
            // Build follow-up with tool results
            const toolUseBlocks = data.content.filter(b => b.type === 'tool_use');
            const toolResults = [];

            for (const toolUse of toolUseBlocks) {
                // web_search returns results in the tool_result
                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: toolUse.id,
                    content: 'Search completed. Please now write the investor deck JSON based on what you found.'
                });
            }

            // Continue conversation to get final JSON
            const followUp = await fetch("https://api.anthropic.com/v1/messages", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": process.env.ANTHROPIC_API_KEY,
                    "anthropic-version": "2023-06-01"
                },
                body: JSON.stringify({
                    model: "claude-sonnet-4-6",
                    max_tokens: 4000,
                    tools: [{ type: "web_search_20250305", name: "web_search" }],
                    messages: [
                        { role: "user", content: contentBlocks },
                        { role: "assistant", content: data.content },
                        { role: "user", content: toolResults }
                    ]
                })
            });

            const followUpData = await followUp.json();
            const followUpText = (followUpData.content?.filter(b => b.type === 'text') || []);
            const finalText = (followUpText[followUpText.length - 1]?.text?.trim() || '')
                .replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

            try {
                const parsed = JSON.parse(finalText);
                if (!hasDocuments) {
                    parsed.metricsVerified = true;
                    parsed.issues = [];
                    parsed.revenueMatch = true;
                    parsed.usersMatch = true;
                    parsed.confidence = parsed.confidence || 'high';
                }
                return new Response(JSON.stringify(parsed), {
                    status: 200, headers: { 'Content-Type': 'application/json' }
                });
            } catch {
                return new Response(JSON.stringify({ 
                    metricsVerified: false, 
                    summary: "Could not parse follow-up response" 
                }), {
                    status: 200, headers: { 'Content-Type': 'application/json' }
                });
            }
        }

        try {
            const parsed = JSON.parse(resultText);
            if (!hasDocuments) {
                parsed.metricsVerified = true;
                parsed.issues = [];
                parsed.revenueMatch = true;
                parsed.usersMatch = true;
                parsed.confidence = parsed.confidence || 'high';
            }
            return new Response(JSON.stringify(parsed), {
                status: 200, headers: { 'Content-Type': 'application/json' }
            });
        } catch {
            return new Response(JSON.stringify({ 
                metricsVerified: false, 
                summary: "Could not parse response: " + resultText.substring(0, 100)
            }), {
                status: 200, headers: { 'Content-Type': 'application/json' }
            });
        }

    } catch(e) {
        return new Response(JSON.stringify({ 
            metricsVerified: false, 
            summary: "Service error: " + e.message 
        }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
        });
    }
}

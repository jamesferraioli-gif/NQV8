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

        const noDocsInstructions = `No proof documents were provided. The founder has self-declared "${claimedRevenue}" revenue and "${claimedUsers}" user status. This is VALID — set metricsVerified to true, issues to [], revenueMatch to true, usersMatch to true, confidence to "high".`;
        const withDocsInstructions = `The documents provided are proof of revenue and/or user metrics. Review them and assign the company to the correct buckets.`;

        // ── Step 1: Use web search to research the company ────────────────
        // Run a separate web search call first, then use results in deck generation
        let websiteContext = '';

        if (website) {
            try {
                const searchResponse = await fetch("https://api.anthropic.com/v1/messages", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "x-api-key": process.env.ANTHROPIC_API_KEY,
                        "anthropic-version": "2023-06-01"
                    },
                    body: JSON.stringify({
                        model: "claude-sonnet-4-6",
                        max_tokens: 1500,
                        tools: [{ type: "web_search_20250305", name: "web_search" }],
                        messages: [{
                            role: "user",
                            content: `Please visit ${website} and summarize in 3-5 sentences: what does this company actually do, what are its main features, how does it make money, and who are its target customers. Be factual and specific — only describe what you actually find on the site.`
                        }]
                    })
                });

                const searchData = await searchResponse.json();
                
                // Extract text from response (handles tool_use intermediate steps)
                if (searchData.content) {
                    const textContent = searchData.content
                        .filter(b => b.type === 'text')
                        .map(b => b.text)
                        .join(' ');
                    if (textContent.length > 50) {
                        websiteContext = textContent;
                    }
                }
            } catch(searchErr) {
                // Web search failed — continue without it
                console.error('Web search failed:', searchErr.message);
            }
        }

        // ── Step 2: Generate deck with research context ───────────────────
        contentBlocks.push({
            type: "text",
            text: `You are a startup analyst writing an investor deck for a company on NQVate marketplace.

COMPANY INFORMATION:
Name: "${companyName}"
Entity Type: "${entityType}"
Website: "${website || 'Not provided'}"
Founder description: "${description}"
Claimed monthly revenue: "${claimedRevenue}"
Claimed user count: "${claimedUsers}"
${websiteContext ? `\nWEBSITE RESEARCH:\n${websiteContext}` : ''}

METRICS VERIFICATION:
${hasDocuments ? withDocsInstructions : noDocsInstructions}

Revenue buckets: "Pre-revenue", "$1-$500/mo", "$500-$2,000/mo", "$2,000-$5,000/mo", "$5,000-$10,000/mo", "$10,000-$25,000/mo", "$25,000+/mo"
User buckets: "Pre-launch", "1-50 users", "50-250 users", "250-1,000 users", "1,000-5,000 users", "5,000-25,000 users", "25,000+ users"

DECK WRITING RULES:
- Base the deck on the website research if available, otherwise use the founder description
- Every claim must be grounded in what was actually found — do not invent features or statistics
- Write in a confident, direct investor voice — no fluff or generic buzzwords
- For pre-launch companies, describe what has been built, not speculative momentum
- Highlights must be specific and concrete

Respond ONLY with this exact JSON format and nothing else:
{
  "metricsVerified": true,
  "confidence": "high",
  "revenueBucket": "Pre-revenue",
  "usersBucket": "Pre-launch",
  "revenueMatch": true,
  "usersMatch": true,
  "issues": [],
  "summary": "one sentence verification summary",
  "deck": {
    "tagline": "one punchy accurate sentence describing exactly what the company does",
    "problem": "2-3 sentences describing the specific problem this company solves",
    "solution": "2-3 sentences describing what the product actually does using specific features",
    "traction": "2-3 sentences about what has actually been built or achieved",
    "marketOpportunity": "2-3 sentences about the relevant market opportunity",
    "businessModel": "2-3 sentences describing confirmed revenue streams only",
    "whyNow": "1-2 sentences about why this moment is right for this product",
    "useOfFunds": "2-3 sentences about what funding will be used for",
    "highlights": ["5-7 specific concrete highlights from your research"]
  }
}`
        });

        // ── Step 3: Generate deck (no tools — just text response) ─────────
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
                    max_tokens: 2000,
                    messages: [{ role: "user", content: contentBlocks }]
                })
            });

            data = await response.json();

            if (data.error?.type === 'overloaded_error' && attempt < MAX_RETRIES) {
                await new Promise(r => setTimeout(r, 3000 * attempt));
                continue;
            }
            break;
        }

        if (!data.content) {
            return new Response(JSON.stringify({ 
                metricsVerified: false, 
                summary: "API error: " + JSON.stringify(data) 
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        const resultText = (data.content[0]?.text?.trim() || '')
            .replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

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
        } catch(parseErr) {
            // Try to extract JSON from anywhere in the response
            const jsonMatch = resultText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    const parsed = JSON.parse(jsonMatch[0]);
                    if (!hasDocuments) {
                        parsed.metricsVerified = true;
                        parsed.issues = [];
                        parsed.revenueMatch = true;
                        parsed.usersMatch = true;
                    }
                    return new Response(JSON.stringify(parsed), {
                        status: 200, headers: { 'Content-Type': 'application/json' }
                    });
                } catch {}
            }

            return new Response(JSON.stringify({ 
                metricsVerified: false, 
                summary: "Could not parse response" 
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

    } catch(e) {
        return new Response(JSON.stringify({ 
            metricsVerified: false, 
            summary: "Service error: " + e.message 
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
}

export const config = { runtime: 'edge' };

async function callClaude(apiKey, body) {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(body)
    });
    return response.json();
}

async function webSearchSummary(apiKey, website) {
    if (!website) return '';
    
    let messages = [{
        role: "user",
        content: `Visit ${website} and summarize in 3-5 sentences: what does this company actually do, what are its main features, how does it make money, and who are its target customers. Be factual — only describe what you find.`
    }];

    for (let i = 0; i < 6; i++) {
        const data = await callClaude(apiKey, {
            model: "claude-sonnet-4-6",
            max_tokens: 800,
            tools: [{ type: "web_search_20250305", name: "web_search" }],
            messages
        });

        if (data.error) {
            console.error('Web search error:', data.error);
            return '';
        }

        if (data.stop_reason === 'end_turn') {
            const textBlocks = (data.content || []).filter(b => b.type === 'text');
            return textBlocks.map(b => b.text).join(' ').trim();
        }

        if (data.stop_reason === 'tool_use') {
            const toolUse = data.content.find(b => b.type === 'tool_use');
            messages.push({ role: "assistant", content: data.content });
            messages.push({
                role: "user",
                content: [{
                    type: "tool_result",
                    tool_use_id: toolUse.id,
                    content: ""
                }]
            });
            continue;
        }

        break;
    }

    return '';
}

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

        // ── Step 1: Research the website ─────────────────────────────────
        let websiteResearch = '';
        if (website) {
            try {
                websiteResearch = await webSearchSummary(apiKey, website);
            } catch(e) {
                console.warn('Website research failed:', e.message);
            }
        }

        // ── Step 2: Generate deck with research context ───────────────────
        const contextText = websiteResearch
            ? `WEBSITE RESEARCH (read directly from ${website}):\n${websiteResearch}`
            : `No website research available. Use the founder description below.`;

        const textBlock = {
            type: "text",
            text: `You are a startup analyst writing an investor deck. Return ONLY valid JSON, no other text.

COMPANY: "${companyName}" (${entityType})
Website: "${website || 'Not provided'}"
Founder description: "${description}"
${contextText}
Claimed revenue: "${claimedRevenue}"
Claimed users: "${claimedUsers}"
Has proof documents: ${hasDocuments}

${!hasDocuments ? 'No documents — valid for pre-launch. Set metricsVerified=true, issues=[], revenueMatch=true, usersMatch=true, confidence="high".' : 'Review documents and verify claimed metrics.'}

IMPORTANT: Base the deck on the WEBSITE RESEARCH if available — it reflects what the company actually does. If research conflicts with the founder description, trust the research. Do not invent features or statistics. Be specific and concrete.

Revenue buckets: "Pre-revenue","$1-$500/mo","$500-$2,000/mo","$2,000-$5,000/mo","$5,000-$10,000/mo","$10,000-$25,000/mo","$25,000+/mo"
User buckets: "Pre-launch","1-50 users","50-250 users","250-1,000 users","1,000-5,000 users","5,000-25,000 users","25,000+ users"

Return this JSON:
{"metricsVerified":true,"confidence":"high","revenueBucket":"Pre-revenue","usersBucket":"Pre-launch","revenueMatch":true,"usersMatch":true,"issues":[],"summary":"","deck":{"tagline":"","problem":"","solution":"","traction":"","marketOpportunity":"","businessModel":"","whyNow":"","useOfFunds":"","highlights":[""]}}`
        };

        // ── Step 3: Call Claude for deck generation (no tools) ────────────
        let data;
        for (let attempt = 1; attempt <= 3; attempt++) {
            data = await callClaude(apiKey, {
                model: "claude-sonnet-4-6",
                max_tokens: 2000,
                messages: [{ role: "user", content: [...docBlocks, textBlock] }]
            });

            if (data.error?.type === 'overloaded_error' && attempt < 3) {
                await new Promise(r => setTimeout(r, 3000 * attempt));
                continue;
            }
            break;
        }

        if (data.error) {
            return new Response(JSON.stringify({
                metricsVerified: false,
                summary: "API error: " + data.error.type + ' - ' + data.error.message
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
            .replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

        const jsonMatch = resultText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return new Response(JSON.stringify({
                metricsVerified: false,
                summary: "Response was not JSON: " + resultText.substring(0, 200)
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

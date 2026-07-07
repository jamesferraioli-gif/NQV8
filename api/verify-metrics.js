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

        contentBlocks.push({
            type: "text",
            text: `You are a startup analyst writing an investor deck. Respond ONLY with valid JSON — no preamble, no explanation, no markdown fences.

COMPANY:
Name: "${companyName}"
Type: "${entityType}"
Website: "${website || 'Not provided'}"
Description: "${description}"
Claimed revenue: "${claimedRevenue}"
Claimed users: "${claimedUsers}"
Has proof documents: ${hasDocuments}

${hasDocuments 
    ? 'Review the attached documents and verify the claimed metrics.'
    : 'No documents provided. Set metricsVerified=true, issues=[], revenueMatch=true, usersMatch=true, confidence="high".'}

Write a compelling investor deck based on what the company actually does per the description. Do not invent features. Be specific and concrete.

Revenue buckets: "Pre-revenue","$1-$500/mo","$500-$2,000/mo","$2,000-$5,000/mo","$5,000-$10,000/mo","$10,000-$25,000/mo","$25,000+/mo"
User buckets: "Pre-launch","1-50 users","50-250 users","250-1,000 users","1,000-5,000 users","5,000-25,000 users","25,000+ users"

Return this exact JSON structure:
{"metricsVerified":true,"confidence":"high","revenueBucket":"Pre-revenue","usersBucket":"Pre-launch","revenueMatch":true,"usersMatch":true,"issues":[],"summary":"Metrics accepted for pre-launch company","deck":{"tagline":"","problem":"","solution":"","traction":"","marketOpportunity":"","businessModel":"","whyNow":"","useOfFunds":"","highlights":[]}}`
        });

        let data;
        for (let attempt = 1; attempt <= 3; attempt++) {
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

            if (data.error?.type === 'overloaded_error' && attempt < 3) {
                await new Promise(r => setTimeout(r, 3000 * attempt));
                continue;
            }
            break;
        }

        if (!data.content || !data.content[0]) {
            return new Response(JSON.stringify({ 
                metricsVerified: false, 
                summary: "API error: " + JSON.stringify(data).substring(0, 200)
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        let resultText = data.content[0].text || '';
        
        // Strip any markdown fences
        resultText = resultText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        
        // Extract JSON object if there's surrounding text
        const jsonMatch = resultText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return new Response(JSON.stringify({ 
                metricsVerified: false, 
                summary: "No JSON found in response"
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        const parsed = JSON.parse(jsonMatch[0]);

        // Safety net for no-doc submissions
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

export const config = { runtime: 'edge' };

export default async function handler(req) {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    try {
        const body = await req.json();
        const { 
            revenueBase64, revenueMediaType,
            usersBase64, usersMediaType,
            optionalBase64, optionalMediaType,
            companyName, entityType, description, website,
            claimedRevenue, claimedUsers
        } = body;

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

        const textBlock = {
            type: "text",
            text: `You are a startup analyst. Return ONLY a JSON object, no other text.

Company: "${companyName}", Type: "${entityType}", Website: "${website || 'N/A'}"
Description: "${description}"
Revenue claim: "${claimedRevenue}", Users claim: "${claimedUsers}"
Has documents: ${hasDocuments}

${!hasDocuments ? 'No docs provided - this is valid for pre-launch. metricsVerified must be true.' : 'Review documents and verify claims.'}

Return this JSON (fill in the deck fields):
{"metricsVerified":true,"confidence":"high","revenueBucket":"${claimedRevenue}","usersBucket":"${claimedUsers}","revenueMatch":true,"usersMatch":true,"issues":[],"summary":"Verified","deck":{"tagline":"FILL","problem":"FILL","solution":"FILL","traction":"FILL","marketOpportunity":"FILL","businessModel":"FILL","whyNow":"FILL","useOfFunds":"FILL","highlights":["FILL","FILL","FILL"]}}`
        };

        const messages = [{ role: "user", content: [...docBlocks, textBlock] }];

        let rawResponse = '';
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
                    messages
                })
            });

            rawResponse = await response.text();
            
            try {
                data = JSON.parse(rawResponse);
            } catch(e) {
                return new Response(JSON.stringify({
                    metricsVerified: false,
                    summary: "API returned non-JSON: " + rawResponse.substring(0, 200)
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }

            if (data.error?.type === 'overloaded_error' && attempt < 3) {
                await new Promise(r => setTimeout(r, 3000 * attempt));
                continue;
            }
            break;
        }

        // Log what we got for debugging
        console.log('Claude response type:', data.type, 'stop_reason:', data.stop_reason);
        console.log('Content blocks:', JSON.stringify(data.content?.map(b => ({ type: b.type, textLen: b.text?.length }))));

        if (data.error) {
            return new Response(JSON.stringify({
                metricsVerified: false,
                summary: "API error: " + data.error.type + ' - ' + data.error.message
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        if (!data.content || !data.content.length) {
            return new Response(JSON.stringify({
                metricsVerified: false,
                summary: "Empty response from API"
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        const textContent = data.content.find(b => b.type === 'text');
        if (!textContent) {
            return new Response(JSON.stringify({
                metricsVerified: false,
                summary: "No text block in response. Content types: " + data.content.map(b => b.type).join(', ')
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        let resultText = textContent.text.trim();
        resultText = resultText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

        const jsonMatch = resultText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return new Response(JSON.stringify({
                metricsVerified: false,
                summary: "Claude response was not JSON: " + resultText.substring(0, 200)
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

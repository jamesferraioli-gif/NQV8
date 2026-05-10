export const config = { runtime: 'edge' };

export default async function handler(req) {
    if (req.method === 'OPTIONS') {
        return new Response(null, {
            status: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
            }
        });
    }

    if (req.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
    }

    try {
        const { text, contentType } = await req.json();

        const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": process.env.ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01"
            },
            body: JSON.stringify({
                model: "claude-sonnet-4-5",
                max_tokens: 200,
                messages: [{
                    role: "user",
                    content: `You are a content moderator. Reply with only JSON: {"approved": true} or {"approved": false, "reason": "reason"}`
                }]
            })
        });

        const rawText = await response.text();

        return new Response(JSON.stringify({
            approved: false,
            reason: `Debug - Status: ${response.status}, Body: ${rawText.substring(0, 500)}`
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch(e) {
        return new Response(JSON.stringify({
            approved: false,
            reason: 'Exception: ' + e.message
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

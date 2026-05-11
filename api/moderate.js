export const config = {
    runtime: 'edge',
};

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
                model: "claude-haiku-4-5-20251001",
                max_tokens: 200,
                messages: [{
                    role: "user",
                    content: `You are a content moderator for NQVate, a professional Web3 marketplace.

Review this ${contentType} and respond ONLY with valid JSON:
{"approved": true} or {"approved": false, "reason": "brief explanation"}

Reject: political, racist, sexual, hateful, illegal, spam content.
Approve: legitimate business, tech, Web3 content.

Content: "${String(text).replace(/"/g, '\\"').substring(0, 2000)}"

JSON only, no other text.`
                }]
            })
        });

        const data = await response.json();
        const resultText = data.content?.[0]?.text?.trim() || '{"approved": true}';

        return new Response(JSON.stringify(JSON.parse(resultText)), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            }
        });

    } catch(e) {
        return new Response(JSON.stringify({ approved: true }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            }
        });
    }
}

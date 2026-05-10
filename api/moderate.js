export const config = {
    runtime: 'edge',
};

export default async function handler(req) {
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
                model: "claude-sonnet-4-20250514",
                max_tokens: 200,
                messages: [{
                    role: "user",
                    content: `You are a content moderator for NQVate, a professional Web3 marketplace for builders and founders.

Review this ${contentType} and respond ONLY with valid JSON in this exact format:
{"approved": true} or {"approved": false, "reason": "brief explanation"}

Reject content that is political, racist, sexual, hateful, illegal, or spam.
Approve legitimate business, tech, and Web3 content.

Content to review:
"${String(text).replace(/"/g, '\\"').substring(0, 2000)}"

Respond with JSON only, no other text.`
                }]
            })
        });

        const data = await response.json();
        const resultText = data.content?.[0]?.text?.trim() || '{"approved": true}';

        try {
            return new Response(JSON.stringify(JSON.parse(resultText)), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        } catch {
            return new Response(JSON.stringify({ approved: true }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    } catch(e) {
        return new Response(JSON.stringify({ approved: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

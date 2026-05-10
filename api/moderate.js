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

Reject content that is:
- Political opinions, propaganda, or partisan content
- Racist, sexist, or discriminatory language
- Sexual or adult content
- Hate speech or harassment
- Illegal activities (fraud, scams, drug sales, etc.)
- Spam or gibberish
- Unrelated to business, technology, or building

Approve content that is:
- Marketplace postings for legitimate projects or tasks
- Ideas, news, or project updates related to tech/business/startups
- Professional comments and discussion
- Web3, crypto, AI, software, or business topics

Content to review:
"${text.replace(/"/g, '\\"').substring(0, 2000)}"

Respond with JSON only, no other text.`
                }]
            })
        });

        const data = await response.json();
        const resultText = data.content?.[0]?.text?.trim() || '{"approved": true}';

        try {
            const result = JSON.parse(resultText);
            return new Response(JSON.stringify(result), {
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

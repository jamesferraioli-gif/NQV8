module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { text, contentType } = req.body;

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
                    content: `You are a content moderator for NQVate, a professional Web3 marketplace. Review this ${contentType} and respond ONLY with valid JSON: {"approved": true} or {"approved": false, "reason": "brief explanation"}. Reject political, racist, sexual, hateful, illegal, or spam content. Approve legitimate business and tech content. Content: "${String(text || '').replace(/"/g, '\\"').substring(0, 2000)}" JSON only.`
                }]
            })
        });

        const data = await response.json();
        const resultText = data.content?.[0]?.text?.trim() || '{"approved": true}';

        try {
            return res.status(200).json(JSON.parse(resultText));
        } catch {
            return res.status(200).json({ approved: true });
        }

    } catch(e) {
        return res.status(200).json({ approved: true });
    }
};

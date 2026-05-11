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
                max_tokens: 100,
                messages: [{
                    role: "user",
                    content: `You are a content moderator. Respond with JSON only.

IMMEDIATELY REJECT (approved: false) if content contains ANY of:
- Violence or threats ("kill", "hurt", "attack", "murder", "shoot", "bomb")
- Illegal drugs ("cocaine", "heroin", "meth", "fentanyl", "buy drugs")
- Racial slurs or hate speech
- Sexual content
- Scams or fraud
- Political content

APPROVE (approved: true) only for legitimate business, tech, or Web3 content.

Content: "${String(text || '').replace(/"/g, '\\"').substring(0, 500)}"

Respond ONLY with: {"approved": true} or {"approved": false, "reason": "..."}`
                }]
            })
        });

        const data = await response.json();
        const resultText = data.content?.[0]?.text?.trim() || '{"approved": false, "reason": "Moderation error"}';

        try {
            return res.status(200).json(JSON.parse(resultText));
        } catch {
            return res.status(200).json({ approved: false, reason: 'Could not parse moderation result' });
        }

    } catch(e) {
        return res.status(200).json({ approved: false, reason: 'Moderation service error' });
    }
};

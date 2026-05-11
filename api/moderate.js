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
                    content: `You are a content moderator. You must respond with ONLY a JSON object, nothing else, no explanation, no markdown.

Does this content contain violence, threats, drugs, hate speech, sexual content, scams, or politics?

Content: "${String(text || '').replace(/"/g, '\\"').substring(0, 500)}"

If yes: {"approved":false,"reason":"brief reason"}
If no: {"approved":true}

ONLY output the JSON object.`
                }]
            })
        });

        const data = await response.json();
        let resultText = data.content?.[0]?.text?.trim() || '';
        
        // Strip any markdown code blocks if Claude added them
        resultText = resultText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

        try {
            return res.status(200).json(JSON.parse(resultText));
        } catch {
            // If still can't parse, check if it contains approved/rejected keywords
            if (resultText.toLowerCase().includes('false')) {
                return res.status(200).json({ approved: false, reason: 'Content rejected by moderation' });
            }
            return res.status(200).json({ approved: true });
        }

    } catch(e) {
        return res.status(200).json({ approved: false, reason: 'Moderation service error: ' + e.message });
    }
};

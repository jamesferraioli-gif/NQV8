module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { title, description, category, compensationType, postingType } = req.body;

    if (!description || description.trim().length < 10) {
        return res.status(400).json({ error: 'Description too short' });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

    const systemPrompt = `You are a marketplace posting editor for NQVate, a decentralized marketplace for builders and ideas. 
Your job is to improve project posting descriptions so they are clear, concrete, and attract quality bids.

A great posting must include:
- Specific, measurable deliverables (not vague goals)
- Clear scope boundaries (what is and isn't included)
- Technical requirements or stack preferences if relevant
- Success criteria — how will the poster know it's done?
- Timeline expectation if possible

Rules:
- Keep the same intent and tone as the original
- Do NOT invent requirements that weren't implied
- Do NOT change the compensation or category
- Keep it concise — no fluff, no filler sentences
- Return ONLY a JSON object, no markdown, no explanation

Return this exact JSON structure:
{
  "improved": "the improved description text here",
  "changes": ["change 1", "change 2", "change 3"]
}`;

    const userPrompt = `Improve this ${postingType === 'fund' ? 'funding request' : 'build request'} posting description.

Title: ${title || 'Untitled'}
Category: ${category || 'General'}
Compensation Type: ${compensationType || 'cash'}

Original Description:
${description}

Return only the JSON object.`;

    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 1000,
                system: systemPrompt,
                messages: [{ role: 'user', content: userPrompt }]
            })
        });

        if (!response.ok) {
            const err = await response.text();
            console.error('Claude API error:', err);
            return res.status(500).json({ error: 'Claude API failed' });
        }

        const data = await response.json();
        const text = data.content?.[0]?.text || '';
        const clean = text.replace(/```json|```/g, '').trim();

        let parsed;
        try {
            parsed = JSON.parse(clean);
        } catch (e) {
            return res.status(500).json({ error: 'Failed to parse Claude response' });
        }

        if (!parsed.improved || !Array.isArray(parsed.changes)) {
            return res.status(500).json({ error: 'Unexpected response format' });
        }

        return res.status(200).json({
            improved: parsed.improved.trim(),
            changes: parsed.changes
        });

    } catch (e) {
        console.error('improve-posting error:', e.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
};

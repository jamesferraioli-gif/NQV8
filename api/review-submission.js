module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { projectTitle, projectDescription, acceptedBidAmount, submissionDescription, submissionLink } = req.body;

    if (!projectDescription || !submissionDescription) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

    const systemPrompt = `You are a neutral submission reviewer for NQVate, a decentralized marketplace for builders and ideas.
Your job is to evaluate whether a builder's submission meets the scope of the original project posting.

You must be fair to both parties:
- Don't require things that weren't explicitly stated in the original posting
- Don't accept submissions that clearly miss the core deliverables
- Consider that submissions may describe work without fully detailing every component

Evaluate on these criteria:
1. Core deliverables — does the submission address what was asked for?
2. Completeness — does it appear to cover the full scope or just part of it?
3. Clarity — is the submission description clear enough to verify?
4. Red flags — any signs the work wasn't done or is incomplete?

Return ONLY a JSON object, no markdown, no explanation.

Return this exact JSON structure:
{
  "meetsScope": true or false,
  "confidence": "high", "medium", or "low",
  "summary": "2-3 sentence neutral summary of your assessment",
  "metItems": ["deliverable 1 appears met", "deliverable 2 appears met"],
  "missingItems": ["item that appears missing or unclear"],
  "recommendation": "approve", "request_changes", or "flag_for_review"
}

recommendation meanings:
- "approve" — submission clearly meets scope, poster should accept
- "request_changes" — submission is incomplete or unclear, poster should request more
- "flag_for_review" — unclear or conflicting information, needs human judgment`;

    const userPrompt = `Review this submission against the original project scope.

PROJECT TITLE: ${projectTitle || 'Untitled'}
PROJECT DESCRIPTION (original scope):
${projectDescription}

AGREED COMPENSATION: ${acceptedBidAmount || 'Not specified'}

BUILDER'S SUBMISSION:
${submissionDescription}

${submissionLink ? `SUBMISSION LINK: ${submissionLink}` : ''}

Does this submission meet the original scope? Return only the JSON object.`;

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
            console.error('JSON parse failed:', clean);
            return res.status(500).json({ error: 'Failed to parse Claude response' });
        }

        if (typeof parsed.meetsScope !== 'boolean' || !parsed.recommendation) {
            return res.status(500).json({ error: 'Unexpected response format' });
        }

        return res.status(200).json({
            meetsScope: parsed.meetsScope,
            confidence: parsed.confidence || 'medium',
            summary: parsed.summary || '',
            metItems: parsed.metItems || [],
            missingItems: parsed.missingItems || [],
            recommendation: parsed.recommendation
        });

    } catch (e) {
        console.error('review-submission error:', e.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
};

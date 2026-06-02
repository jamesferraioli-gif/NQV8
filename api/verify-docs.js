export const config = { runtime: 'nodejs' };

export default async function handler(req) {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    try {
        const { incorporationBase64, incorporationMediaType, einBase64, einMediaType, idBase64, idMediaType, companyName, entityType } = await req.json();

        const makeBlock = (base64, mediaType) => {
            if (mediaType === 'application/pdf') {
                return {
                    type: "document",
                    source: {
                        type: "base64",
                        media_type: "application/pdf",
                        data: base64
                    }
                };
            }
            return {
                type: "image",
                source: {
                    type: "base64",
                    media_type: mediaType || "image/jpeg",
                    data: base64
                }
            };
        };

        const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": process.env.ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01"
            },
            body: JSON.stringify({
                model: "claude-sonnet-4-20250514",
                max_tokens: 500,
                messages: [{
                    role: "user",
                    content: [
                        makeBlock(incorporationBase64, incorporationMediaType),
                        makeBlock(einBase64, einMediaType),
                        makeBlock(idBase64, idMediaType),
                        {
                            type: "text",
                            text: `You are a business document verifier for NQVate, a Web3 marketplace platform.

A user is submitting documents to verify their business entity for equity features.
Company name claimed: "${companyName}"
Entity type claimed: "${entityType}"

The three documents provided are:
1. Articles of Incorporation / Formation document
2. EIN / Tax ID document  
3. Government-issued ID of the authorized representative

Review all three documents and respond ONLY with valid JSON in this exact format:
{
  "approved": true or false,
  "confidence": "high", "medium", or "low",
  "companyNameMatch": true or false,
  "entityTypeMatch": true or false,
  "idPresent": true or false,
  "issues": ["specific issue 1", "specific issue 2"],
  "missingDocuments": ["any document that is missing or unreadable"],
  "recommendation": "specific actionable advice on what to fix and resubmit if rejected",
  "summary": "one sentence summary of the verification result"
}
Check for:
- Does the company name on the formation document match the claimed name "${companyName}"?
- Does the entity type match the claimed "${entityType}"?
- Is the EIN document present and showing a valid tax ID format?
- Is the government ID present and appears legitimate?
- Are there any obvious signs of tampering, inconsistency, or fraud?
- Do names on the ID match the authorized representative on formation documents if visible?
- Are all documents clearly legible and unobstructed?
Be strict but fair. Reject if critical fields are missing, names don't match, or documents appear tampered.
If rejecting, be specific in "issues" and "recommendation" about exactly what was wrong and what the user needs to fix — they paid a non-refundable fee and deserve a clear explanation.
Respond with JSON only, no other text.`
                        }
                    ]
                }]
            })
        });

        const data = await response.json();
        const resultText = data.content?.[0]?.text?.trim() || '{"approved": false, "summary": "Verification failed"}';

        try {
            return new Response(JSON.stringify(JSON.parse(resultText)), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        } catch {
            return new Response(JSON.stringify({ approved: false, summary: "Could not parse verification result" }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    } catch(e) {
        return new Response(JSON.stringify({ approved: false, summary: "Verification service error: " + e.message }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

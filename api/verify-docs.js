export const config = { runtime: 'edge' };
 
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
                            
                            IMPORTANT NAME MATCHING RULES:
                            - Name matching is case-insensitive ("NQVate" = "NQVATE" = "nqvate")
                            - Ignore entity suffixes when comparing ("NQVate" matches "NQVATE LLC" or "NQVate LLC")
                            - Partial matches are acceptable if the core business name is present
                            
                            Approve if:
                            - The core company name appears on the formation document (case-insensitive, ignoring LLC/Inc/Corp)
                            - An EIN or Tax ID number is visible on the tax document
                            - A government ID is present and appears legitimate
                            - No obvious signs of tampering or fraud
                            
                            Only reject if documents are completely unreadable, clearly fraudulent, or a completely different company name appears.
                            
                            Respond ONLY with valid JSON:
                            {
                              "approved": true or false,
                              "confidence": "high", "medium", or "low",
                              "companyNameMatch": true or false,
                              "entityTypeMatch": true or false,
                              "idPresent": true or false,
                              "issues": ["specific issue 1"],
                              "missingDocuments": [],
                              "recommendation": "specific actionable advice if rejected",
                              "summary": "one sentence summary"
                            }
                            Respond with JSON only, no other text.`
                        }
                    ]
                }]
            })
        });
 
        const data = await response.json();
        const resultText = data.content?.[0]?.text?.trim() || '{"approved": false, "summary": "Verification failed"}';
        console.log('RAW CLAUDE RESPONSE:', resultText);
        console.log('ANTHROPIC DATA:', JSON.stringify(data));
 
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

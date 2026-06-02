export const config = { runtime: 'edge' };

export default async function handler(req) {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    try {
        const { 
            revenueBase64, revenueMediaType,
            usersBase64, usersMediaType,
            optionalBase64, optionalMediaType,
            companyName, entityType, description, website,
            claimedRevenue, claimedUsers
        } = await req.json();

        const makeBlock = (base64, mediaType) => {
            if (!base64) return null;
            if (mediaType === 'application/pdf') {
                return { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } };
            }
            return { type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: base64 } };
        };

        const contentBlocks = [
            makeBlock(revenueBase64, revenueMediaType),
            makeBlock(usersBase64, usersMediaType),
            optionalBase64 ? makeBlock(optionalBase64, optionalMediaType) : null,
        ].filter(Boolean);

        contentBlocks.push({
            type: "text",
            text: `You are a startup metrics verifier and investor deck generator for NQVate, a Web3 marketplace.

Company: "${companyName}"
Type: "${entityType}"
Description: "${description}"
Website: "${website || 'Not provided'}"
Founder claims revenue: "${claimedRevenue}"
Founder claims users: "${claimedUsers}"

The documents provided are proof of revenue and/or user metrics (e.g. Stripe dashboard, Google Analytics, App Store Connect, bank statements).

PART 1 - VERIFY METRICS:
Review the documents and assign the company to the correct buckets.

Revenue buckets: "Pre-revenue", "$1-$500/mo", "$500-$2,000/mo", "$2,000-$5,000/mo", "$5,000-$10,000/mo", "$10,000-$25,000/mo", "$25,000+/mo"
User buckets: "Pre-launch", "1-50 users", "50-250 users", "250-1,000 users", "1,000-5,000 users", "5,000-25,000 users", "25,000+ users"

PART 2 - GENERATE INVESTOR DECK:
Based on the company info and verified metrics, generate compelling investor deck content.

Respond ONLY with valid JSON:
{
  "metricsVerified": true or false,
  "confidence": "high", "medium", or "low",
  "revenueBucket": one of the revenue buckets above,
  "usersBucket": one of the user buckets above,
  "revenueMatch": true or false (does proof match claimed revenue?),
  "usersMatch": true or false (does proof match claimed users?),
  "issues": ["any issues found"],
  "summary": "one sentence verification summary",
  "deck": {
    "tagline": "one punchy sentence describing what the company does",
    "problem": "2-3 sentences describing the problem being solved",
    "solution": "2-3 sentences describing the product/solution",
    "traction": "2-3 sentences about traction using only the verified metric buckets, not exact numbers",
    "marketOpportunity": "2-3 sentences about the market opportunity",
    "businessModel": "2-3 sentences about how the company makes money",
    "whyNow": "1-2 sentences about why this is the right time",
    "useOfFunds": "2-3 sentences about what the equity raise will fund",
    "highlights": ["3-5 bullet point highlights for investors"]
  }
}
Respond with JSON only, no other text.`
        });

        const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": process.env.ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01"
            },
            body: JSON.stringify({
                model: "claude-sonnet-4-5",
                max_tokens: 2000,
                messages: [{ role: "user", content: contentBlocks }]
            })
        });

        const data = await response.json();

        if (!data.content) {
            return new Response(JSON.stringify({ metricsVerified: false, summary: "API error: " + JSON.stringify(data) }), {
                status: 200, headers: { 'Content-Type': 'application/json' }
            });
        }

        const resultText = (data.content[0]?.text?.trim() || '')
            .replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

        try {
            const parsed = JSON.parse(resultText);
            return new Response(JSON.stringify(parsed), {
                status: 200, headers: { 'Content-Type': 'application/json' }
            });
        } catch {
            return new Response(JSON.stringify({ metricsVerified: false, summary: "Could not parse response" }), {
                status: 200, headers: { 'Content-Type': 'application/json' }
            });
        }

    } catch(e) {
        return new Response(JSON.stringify({ metricsVerified: false, summary: "Service error: " + e.message }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
        });
    }
}

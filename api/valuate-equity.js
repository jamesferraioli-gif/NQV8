export const config = { runtime: 'edge' };

const EQUITY_REGISTRY_ADDRESS = '0xb4085b1eDd626cc401FB87784b73E23D5c4eb909';
const ARBITRUM_RPC = 'https://arb1.arbitrum.io/rpc';
const TOTAL_UNITS = 10_000;

export default async function handler(req) {
    if (req.method !== 'POST' && req.method !== 'GET') {
        return new Response('Method not allowed', { status: 405 });
    }

    let projectId, forceRefresh;
    try {
        const body = await req.json();
        projectId = body.projectId;
        forceRefresh = body.forceRefresh;
    } catch(e) {
        const url = new URL(req.url);
        projectId = url.searchParams.get('projectId');
        forceRefresh = url.searchParams.get('forceRefresh') === 'true';
    }

    if (!projectId) {
        return new Response(JSON.stringify({ error: 'projectId required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    try {
        // Fetch Firestore data via REST API
        const firestoreData = await fetchFirestoreData(projectId);

        // Build valuation prompt with available data
        const prompt = buildPrompt(projectId, firestoreData);

        // Call Claude
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 1500,
                messages: [{ role: 'user', content: prompt }]
            })
        });

        const data = await response.json();
        const rawText = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
        const clean = rawText.replace(/```json|```/g, '').trim();

        let result;
        try {
            result = JSON.parse(clean);
        } catch(e) {
            result = {
                valuationRange: { low: 0.001, mid: 0.005, high: 0.01 },
                impliedValuation: { low: 10, mid: 50, high: 100 },
                suggestedAskPerUnit: 0.005,
                methodology: 'Insufficient data for precise valuation. Defaulting to minimal early-stage range.',
                keyFactors: [{ factor: 'Limited on-chain and platform data available', impact: 'negative' }],
                comparablesUsed: [],
                confidence: 'low',
                warnings: ['Very limited data available for this project']
            };
        }

        const final = {
            ...result,
            projectId,
            projectName: firestoreData.name || projectId,
            cachedAt: Date.now(),
            fromCache: false
        };

        return new Response(JSON.stringify(final), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch(e) {
        console.error('valuate-equity error:', e.message);
        return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

async function fetchFirestoreData(projectId) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        const projectIdFirebase = serviceAccount.project_id;
        const token = await getFirebaseToken(serviceAccount);

        const url = `https://firestore.googleapis.com/v1/projects/${projectIdFirebase}/databases/(default)/documents/companies/${projectId}`;
        const res = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!res.ok) return {};

        const doc = await res.json();
        const fields = doc.fields || {};

        return {
            name: fields.name?.stringValue || '',
            category: fields.category?.stringValue || '',
            entityType: fields.entityType?.stringValue || '',
            description: fields.description?.stringValue || '',
            revenue: fields.revenue?.stringValue || '',
            userCount: fields.userCount?.stringValue || '',
            growthRate: fields.growthRate?.stringValue || '',
            fundingRaised: fields.fundingRaised?.stringValue || '',
            website: fields.website?.stringValue || '',
            isActive: fields.isActive?.booleanValue || false,
            metricsVerified: fields.metricsVerified?.booleanValue || false,
            revenueBucket: fields.revenueBucket?.stringValue || '',
            usersBucket: fields.usersBucket?.stringValue || '',
            verifiedAt: fields.verifiedAt?.timestampValue || null,
            statsUpdatedAt: fields.statsUpdatedAt?.stringValue || null,
        };
    } catch(e) {
        console.warn('Firestore fetch failed:', e.message);
        return {};
    }
}

async function getFirebaseToken(serviceAccount) {
    const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const now = Math.floor(Date.now() / 1000);
    const payload = btoa(JSON.stringify({
        iss: serviceAccount.client_email,
        scope: 'https://www.googleapis.com/auth/datastore',
        aud: 'https://oauth2.googleapis.com/token',
        exp: now + 3600,
        iat: now
    }));

    const signingInput = `${header}.${payload}`;
    const privateKey = serviceAccount.private_key;

    // Import key and sign
    const keyData = privateKey
        .replace('-----BEGIN PRIVATE KEY-----', '')
        .replace('-----END PRIVATE KEY-----', '')
        .replace(/\s/g, '');
    const binaryKey = Uint8Array.from(atob(keyData), c => c.charCodeAt(0));

    const cryptoKey = await crypto.subtle.importKey(
        'pkcs8', binaryKey.buffer,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false, ['sign']
    );

    const encoder = new TextEncoder();
    const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5', cryptoKey,
        encoder.encode(signingInput)
    );

    const sig = btoa(String.fromCharCode(...new Uint8Array(signature)));
    const jwt = `${signingInput}.${sig}`;

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
    });

    const tokenData = await tokenRes.json();
    return tokenData.access_token;
}

function buildPrompt(projectId, f) {
    return `You are an equity valuation analyst for NQVate, a decentralized marketplace where micro-startups tokenize equity as on-chain stakes (10,000 units = 100% of company).

Produce a fair value range for equity units in this project. Be realistic — these are early-stage micro-startups.

=== PROJECT DATA ===
Name: ${f.name || projectId}
Category: ${f.category || 'Unknown'}
Entity Type: ${f.entityType || 'Unknown'}
Description: ${f.description || 'Not provided'}
Active: ${f.isActive ? 'Yes (live product)' : 'No / In development'}
Website: ${f.website || 'None'}

=== METRICS ===
${f.metricsVerified ? `Claude AI Verified:
  Revenue: ${f.revenueBucket || 'Not disclosed'}
  Users: ${f.usersBucket || 'Not disclosed'}` : `Self-reported (unverified):
  Revenue: ${f.revenue || 'Not disclosed'}
  Users: ${f.userCount || 'Not disclosed'}
  Growth: ${f.growthRate || 'Not disclosed'}
  Funding Raised: ${f.fundingRaised || 'None'}`}

Metrics last updated: ${f.statsUpdatedAt || 'Never'}

=== VALUATION GUIDANCE ===
- Pre-revenue/pre-product: $100-$2,000 total implied valuation
- Early revenue ($1-$500/mo): $2,000-$10,000 implied
- Growing ($500-$2,000/mo): $10,000-$50,000 implied
- Established ($2,000-$10,000/mo): $50,000-$200,000 implied
- Apply 20-40% discount for no disclosed metrics or unverified
- Apply 15-25% liquidity discount (illiquid private stakes)
- Claude-verified metrics should be weighted more than self-reported

Respond ONLY with valid JSON, no markdown:
{
  "valuationRange": { "low": 0.00, "mid": 0.00, "high": 0.00 },
  "impliedValuation": { "low": 0, "mid": 0, "high": 0 },
  "suggestedAskPerUnit": 0.00,
  "methodology": "2-3 sentence explanation",
  "keyFactors": [
    { "factor": "description", "impact": "positive" },
    { "factor": "description", "impact": "negative" }
  ],
  "comparablesUsed": [],
  "confidence": "low",
  "warnings": ["any caveats for buyers"]
}

Values: valuationRange in USDC per unit (e.g. 0.05 = $0.05/unit = $500 total), impliedValuation = range × 10,000, confidence: "high"|"medium"|"low"`;
}

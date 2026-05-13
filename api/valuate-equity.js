// api/valuate-equity.js
// Computes a fair value range for an equity stake in a NQVate project.
// Called on-demand (with 24hr Firestore cache) and on trade/funding triggers.
//
// Inputs:
//   - projectId: Firestore company ID (same as equity registry project ID)
//   - forceRefresh: boolean — skip cache and recompute
//
// Output:
//   - valuationRange: { low, mid, high } in USDC per unit
//   - impliedValuation: { low, mid, high } total company valuation in USDC
//   - suggestedAskPerUnit: recommended listing price per unit
//   - methodology: explanation of how the valuation was derived
//   - keyFactors: array of bullish/bearish signals
//   - comparables: similar projects used for comparison
//   - confidence: 'high' | 'medium' | 'low'
//   - cachedAt: timestamp

import { ethers }   from 'ethers';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore }           from 'firebase-admin/firestore';
import { credential }             from 'firebase-admin';

// ── Firebase Admin init ───────────────────────────────────────────────────────
if (!getApps().length) {
    initializeApp({
        credential: credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
}
const db = getFirestore();

// ── Constants ─────────────────────────────────────────────────────────────────
const EQUITY_REGISTRY_ADDRESS = '0xb4085b1eDd626cc401FB87784b73E23D5c4eb909';
const NQV8_TOKEN_ADDRESS      = '0x02b3EF81d6577507114BB26F91F1a8d0A7bB1B67';
const ARBITRUM_RPC            = 'https://arb1.arbitrum.io/rpc';
const CACHE_TTL_MS            = 24 * 60 * 60 * 1000; // 24 hours
const TOTAL_UNITS             = 10_000;

const EQUITY_REGISTRY_ABI = [
    "function getProject(string projectId) external view returns (tuple(string projectId, string name, address founder, bool exists, uint256 createdAt, uint256 lastSalePricePerUnit, uint256 lastSaleAt, uint256 totalTradeVolume, bytes32 metricsHash, uint256 metricsUpdatedAt))",
    "function getAllListingIds() external view returns (bytes32[])",
    "function getListing(bytes32 listingId) external view returns (tuple(bytes32 listingId, string projectId, address seller, uint256 units, uint256 askPricePerUnit, uint8 status, uint256 createdAt))",
    "function getStats() external view returns (uint256 projectsRegistered, uint256 tradesExecuted, uint256 platformFees, uint256 equityTransferred)",
    "event BoughtNow(bytes32 indexed listingId, address buyer, uint256 units, uint256 totalPrice, uint256 platformFee)",
    "event CounterAccepted(bytes32 indexed offerId, uint256 totalPrice, uint256 platformFee)"
];

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
    if (req.method !== 'POST' && req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const projectId    = req.body?.projectId || req.query?.projectId;
    const forceRefresh = req.body?.forceRefresh || req.query?.forceRefresh === 'true';

    if (!projectId) {
        return res.status(400).json({ error: 'projectId required' });
    }

    try {
        // ── 1. Check cache ────────────────────────────────────────────────
        if (!forceRefresh) {
            const cached = await getCachedValuation(projectId);
            if (cached) {
                return res.json({ ...cached, fromCache: true });
            }
        }

        // ── 2. Gather all data in parallel ────────────────────────────────
        const [onChainData, firestoreData, comparables, nqv8Price] = await Promise.all([
            fetchOnChainData(projectId),
            fetchFirestoreData(projectId),
            fetchComparables(projectId),
            fetchNQV8Price()
        ]);

        if (!onChainData.exists) {
            return res.status(404).json({ error: 'Project not registered in equity registry' });
        }

        // ── 3. Run Claude valuation ───────────────────────────────────────
        const valuation = await runClaudeValuation({
            projectId,
            onChainData,
            firestoreData,
            comparables,
            nqv8Price
        });

        // ── 4. Cache result ───────────────────────────────────────────────
        await cacheValuation(projectId, valuation);

        return res.json({ ...valuation, fromCache: false });

    } catch(e) {
        console.error('valuate-equity error:', e.message);
        return res.status(500).json({ error: e.message });
    }
}

// ── Fetch on-chain data ───────────────────────────────────────────────────────
async function fetchOnChainData(projectId) {
    const provider       = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
    const equityReadOnly = new ethers.Contract(EQUITY_REGISTRY_ADDRESS, EQUITY_REGISTRY_ABI, provider);

    const project = await equityReadOnly.getProject(projectId);

    if (!project.exists) return { exists: false };

    // Get recent trade history from events
    const latestBlock = await provider.getBlockNumber();
    const fromBlock   = Math.max(0, latestBlock - 2000000); // ~6 months

    let recentTrades = [];
    try {
        const buyFilter    = equityReadOnly.filters.BoughtNow();
        const counterFilter = equityReadOnly.filters.CounterAccepted();

        const [buyEvents, counterEvents] = await Promise.all([
            equityReadOnly.queryFilter(buyFilter, fromBlock, latestBlock),
            equityReadOnly.queryFilter(counterFilter, fromBlock, latestBlock)
        ]);

        // Get blocks for timestamps
        const allEvents = [...buyEvents, ...counterEvents]
            .sort((a, b) => b.blockNumber - a.blockNumber)
            .slice(0, 10); // last 10 trades

        recentTrades = await Promise.all(allEvents.map(async event => {
            const block = await provider.getBlock(event.blockNumber);
            return {
                totalPrice:  parseFloat(ethers.utils.formatUnits(event.args.totalPrice, 6)),
                timestamp:   block.timestamp,
                date:        new Date(block.timestamp * 1000).toISOString().split('T')[0],
                type:        event.event
            };
        }));
    } catch(e) {
        console.warn('Could not fetch trade events:', e.message);
    }

    // Get active listings for this project
    let activeListings = [];
    try {
        const listingIds = await equityReadOnly.getAllListingIds();
        const listings   = await Promise.all(
            listingIds.map(id => equityReadOnly.getListing(id).then(l => ({ id, ...l })))
        );
        activeListings = listings
            .filter(l => l.projectId === projectId && l.status === 0)
            .map(l => ({
                units:           l.units.toNumber(),
                askPricePerUnit: parseFloat(ethers.utils.formatUnits(l.askPricePerUnit, 6)),
                totalAsk:        parseFloat(ethers.utils.formatUnits(l.askPricePerUnit, 6)) * l.units.toNumber(),
                percentage:      (l.units.toNumber() / TOTAL_UNITS * 100).toFixed(2)
            }));
    } catch(e) {
        console.warn('Could not fetch listings:', e.message);
    }

    return {
        exists:              true,
        name:                project.name,
        founder:             project.founder,
        createdAt:           project.createdAt.toNumber(),
        lastSalePricePerUnit: project.lastSalePricePerUnit.gt(0)
            ? parseFloat(ethers.utils.formatUnits(project.lastSalePricePerUnit, 6))
            : null,
        lastSaleAt:          project.lastSaleAt.toNumber(),
        totalTradeVolume:    parseFloat(ethers.utils.formatUnits(project.totalTradeVolume, 6)),
        metricsUpdatedAt:    project.metricsUpdatedAt.toNumber(),
        recentTrades,
        activeListings,
        impliedValuationFromLastSale: project.lastSalePricePerUnit.gt(0)
            ? parseFloat(ethers.utils.formatUnits(project.lastSalePricePerUnit, 6)) * TOTAL_UNITS
            : null
    };
}

// ── Fetch Firestore data ──────────────────────────────────────────────────────
async function fetchFirestoreData(projectId) {
    try {
        const companyDoc = await db.collection('companies').doc(projectId).get();
        if (!companyDoc.exists) return {};

        const company = companyDoc.data();

        // Also fetch completed funding requests for this project
        const fundingSnap = await db.collection('subprojects')
            .where('projectId', '==', projectId)
            .where('type', '==', 'fund')
            .where('status', '==', 'completed')
            .get();

        const fundingRounds = fundingSnap.docs.map(doc => {
            const d = doc.data();
            return {
                amount:      d.acceptedBid?.amount || d.compensation,
                completedAt: d.completedAt?.toDate?.()?.toISOString() || null
            };
        });

        // Count active bounties (signals development activity)
        const bountiesSnap = await db.collection('subprojects')
            .where('companyId', '==', projectId)
            .get();

        const bountyStats = {
            total:     bountiesSnap.size,
            completed: bountiesSnap.docs.filter(d => d.data().status === 'completed').length,
            active:    bountiesSnap.docs.filter(d => d.data().status === 'in-progress').length
        };

        return {
            name:            company.name,
            category:        company.category,
            entityType:      company.entityType,
            description:     company.description,
            revenue:         company.revenue,
            userCount:       company.userCount,
            growthRate:      company.growthRate,
            fundingRaised:   company.fundingRaised,
            website:         company.website,
            isActive:        company.isActive,
            verifiedAt:      company.verifiedAt?.toDate?.()?.toISOString() || null,
            statsUpdatedAt:  company.statsUpdatedAt,
            fundingRounds,
            bountyStats
        };
    } catch(e) {
        console.warn('Firestore fetch failed:', e.message);
        return {};
    }
}

// ── Fetch comparable projects ─────────────────────────────────────────────────
async function fetchComparables(projectId) {
    try {
        // Get verified projects in the same category that have had trades
        const companyDoc = await db.collection('companies').doc(projectId).get();
        if (!companyDoc.exists) return [];

        const category = companyDoc.data().category;

        const comparablesSnap = await db.collection('companies')
            .where('verificationStatus', '==', 'verified')
            .where('category', '==', category)
            .limit(10)
            .get();

        const provider       = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
        const equityReadOnly = new ethers.Contract(EQUITY_REGISTRY_ADDRESS, EQUITY_REGISTRY_ABI, provider);

        const comparables = [];
        for (const doc of comparablesSnap.docs) {
            if (doc.id === projectId) continue;

            try {
                const project = await equityReadOnly.getProject(doc.id);
                if (!project.exists || project.lastSalePricePerUnit.eq(0)) continue;

                const company = doc.data();
                comparables.push({
                    name:                 company.name,
                    category:             company.category,
                    lastSalePricePerUnit: parseFloat(ethers.utils.formatUnits(project.lastSalePricePerUnit, 6)),
                    impliedValuation:     parseFloat(ethers.utils.formatUnits(project.lastSalePricePerUnit, 6)) * TOTAL_UNITS,
                    totalTradeVolume:     parseFloat(ethers.utils.formatUnits(project.totalTradeVolume, 6)),
                    revenue:              company.revenue || 'Not disclosed',
                    userCount:            company.userCount || 'Not disclosed'
                });
            } catch(e) {
                // Skip projects that error
            }
        }

        return comparables.slice(0, 5); // max 5 comparables
    } catch(e) {
        console.warn('Comparables fetch failed:', e.message);
        return [];
    }
}

// ── Fetch NQV8 price ──────────────────────────────────────────────────────────
async function fetchNQV8Price() {
    try {
        const res  = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${NQV8_TOKEN_ADDRESS}`);
        const data = await res.json();
        return parseFloat(data.pairs?.[0]?.priceUsd || '0.01');
    } catch(e) {
        return 0.01; // default to peg price
    }
}

// ── Run Claude valuation ──────────────────────────────────────────────────────
async function runClaudeValuation({ projectId, onChainData, firestoreData, comparables, nqv8Price }) {
    const now = new Date();

    const prompt = `You are an equity valuation analyst for NQVate, a decentralized marketplace where micro-startups tokenize their equity as on-chain stakes (10,000 units = 100% of the company).

Your job is to produce a fair value range for equity units in this project. Be analytical but realistic — these are early-stage micro-startups, not Series A companies.

=== PROJECT DATA ===

Name: ${onChainData.name}
Category: ${firestoreData.category || 'Unknown'}
Entity Type: ${firestoreData.entityType || 'Unknown'}
Description: ${firestoreData.description || 'Not provided'}
Verified on NQVate: ${firestoreData.verifiedAt ? new Date(firestoreData.verifiedAt).toLocaleDateString() : 'Unknown'}
Active: ${firestoreData.isActive ? 'Yes' : 'No / In development'}
Website: ${firestoreData.website || 'None'}

=== FOUNDER-REPORTED METRICS ===
(Self-reported — weight accordingly. Metrics hash timestamped on Arbitrum.)
Revenue: ${firestoreData.revenue || 'Not disclosed'}
Users/Customers: ${firestoreData.userCount || 'Not disclosed'}
MoM Growth: ${firestoreData.growthRate || 'Not disclosed'}
Total Funding Raised: ${firestoreData.fundingRaised || 'None'}
Metrics last updated: ${firestoreData.statsUpdatedAt ? new Date(firestoreData.statsUpdatedAt).toLocaleDateString() : 'Never'}

=== ON-CHAIN TRADING DATA ===
Last sale price per unit: ${onChainData.lastSalePricePerUnit ? `$${onChainData.lastSalePricePerUnit.toFixed(4)} USDC` : 'No trades yet'}
Last sale date: ${onChainData.lastSaleAt ? new Date(onChainData.lastSaleAt * 1000).toLocaleDateString() : 'N/A'}
Implied valuation from last sale: ${onChainData.impliedValuationFromLastSale ? `$${onChainData.impliedValuationFromLastSale.toLocaleString()} USDC` : 'N/A'}
Total on-chain trade volume: $${onChainData.totalTradeVolume.toFixed(2)} USDC

Recent trades (last 10):
${onChainData.recentTrades.length > 0
    ? onChainData.recentTrades.map(t => `- ${t.date}: $${t.totalPrice.toFixed(2)} USDC (${t.type})`).join('\n')
    : 'No trades yet'}

Active listings:
${onChainData.activeListings.length > 0
    ? onChainData.activeListings.map(l => `- ${l.percentage}% (${l.units} units) asking $${l.askPricePerUnit.toFixed(4)}/unit ($${l.totalAsk.toFixed(2)} total)`).join('\n')
    : 'No active listings'}

=== PLATFORM ACTIVITY ===
Total bounties posted: ${firestoreData.bountyStats?.total || 0}
Bounties completed: ${firestoreData.bountyStats?.completed || 0}
Bounties in progress: ${firestoreData.bountyStats?.active || 0}

Funding rounds completed on NQVate:
${firestoreData.fundingRounds?.length > 0
    ? firestoreData.fundingRounds.map(f => `- ${f.amount} (${f.completedAt ? new Date(f.completedAt).toLocaleDateString() : 'date unknown'})`).join('\n')
    : 'None'}

=== COMPARABLE PROJECTS (same category, with trades) ===
${comparables.length > 0
    ? comparables.map(c => `- ${c.name}: last sale $${c.lastSalePricePerUnit.toFixed(4)}/unit (implied valuation $${c.impliedValuation.toLocaleString()}), revenue: ${c.revenue}, users: ${c.userCount}`).join('\n')
    : 'No comparable projects with trading history yet'}

=== CONTEXT ===
Current NQV8 price: $${nqv8Price.toFixed(4)} USDC
Valuation date: ${now.toISOString().split('T')[0]}
Total equity units: 10,000 (1 unit = 0.01%)

=== VALUATION METHODOLOGY GUIDANCE ===

Use a blended approach:
1. **Secondary market anchor**: If there are recent trades, weight the last sale price heavily (60-70% weight if < 30 days old, less if older)
2. **Revenue multiple**: For companies with disclosed revenue, apply 2-5x ARR for early stage (lower for pre-revenue)
3. **Comparable transactions**: Weight comparable project trades in the same category
4. **Activity discount**: Apply a 20-40% discount for no disclosed metrics, inactive projects, or no website
5. **Liquidity discount**: Apply 15-25% discount vs comparable public markets — these are illiquid private stakes
6. **Time decay**: Last sale prices > 90 days old should be weighted less

For pre-revenue, pre-product projects: base value should be very low ($100-$2,000 total implied valuation range) unless there is strong evidence of traction.

Respond ONLY with valid JSON, no markdown:
{
  "valuationRange": {
    "low": 0.00,
    "mid": 0.00,
    "high": 0.00
  },
  "impliedValuation": {
    "low": 0,
    "mid": 0,
    "high": 0
  },
  "suggestedAskPerUnit": 0.00,
  "methodology": "2-3 sentence explanation of how you arrived at this range",
  "keyFactors": [
    { "factor": "description", "impact": "positive" },
    { "factor": "description", "impact": "negative" },
    { "factor": "description", "impact": "neutral" }
  ],
  "comparablesUsed": ["project name 1", "project name 2"],
  "confidence": "high",
  "warnings": ["any important caveats for buyers"]
}

Values:
- valuationRange: USDC per unit (e.g. 0.05 means $0.05 per unit = $500 total company valuation)
- impliedValuation: total company valuation in USDC (valuationRange × 10,000)
- suggestedAskPerUnit: recommended listing price per unit for sellers
- confidence: "high" (recent trades + metrics), "medium" (some data), "low" (minimal data)
- impact: "positive" | "negative" | "neutral"`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1500,
            messages: [{ role: 'user', content: prompt }]
        })
    });

    const data    = await response.json();
    const rawText = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const clean   = rawText.replace(/```json|```/g, '').trim();
    const result  = JSON.parse(clean);

    return {
        ...result,
        projectId,
        projectName:  onChainData.name,
        cachedAt:     Date.now(),
        dataPoints: {
            hasLastSale:    !!onChainData.lastSalePricePerUnit,
            hasMetrics:     !!(firestoreData.revenue || firestoreData.userCount),
            hasComparables: comparables.length > 0,
            tradeCount:     onChainData.recentTrades.length
        }
    };
}

// ── Cache helpers ─────────────────────────────────────────────────────────────
async function getCachedValuation(projectId) {
    try {
        const doc = await db.collection('equityValuations').doc(projectId).get();
        if (!doc.exists) return null;

        const cached = doc.data();
        const age    = Date.now() - cached.cachedAt;

        if (age > CACHE_TTL_MS) return null; // expired

        return cached;
    } catch(e) {
        return null;
    }
}

async function cacheValuation(projectId, valuation) {
    try {
        await db.collection('equityValuations').doc(projectId).set(valuation);
    } catch(e) {
        console.warn('Failed to cache valuation:', e.message);
    }
}

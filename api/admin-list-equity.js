// api/admin-list-equity.js
// Called when a user wants to list equity for sale on the secondary market.
// Uses Operations wallet to call adminListEquity() on V4, bypassing
// MetaMask Delegation Manager interference.

import { ethers } from 'ethers';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { verifyCaller } from './_auth.js';
import { gasOverrides } from './_gas.js';

if (!getApps().length) {
    initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
const db = getFirestore();

const EQUITY_REGISTRY_ADDRESS = '0xc640185Dab975D2D3dAEE360Bd3599B7eC45A4f2';
const ARBITRUM_RPC            = 'https://arb1.arbitrum.io/rpc';

const EQUITY_ABI = [
    "function adminListEquity(bytes32 listingId, bytes32 companyId, address seller, uint256 units, uint256 pricePerUnit) external",
    "function balances(bytes32 companyId, address wallet) external view returns (uint256)",
    "function availableBalance(bytes32 companyId, address holder) external view returns (uint256)",
    "function listings(bytes32 listingId) external view returns (bytes32 companyId, address seller, uint128 units, uint128 pricePerUnit, bool active)"
];
];

function toBytes32(str) {
    return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(str));
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const caller = await verifyCaller(req);
    if (!caller) return res.status(401).json({ error: 'Unauthorized' });

    const { listingId, companyId, seller, units, pricePerUnit } = req.body;

    if (!listingId || !companyId || !seller || !units || !pricePerUnit) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!ethers.utils.isAddress(seller)) {
        return res.status(400).json({ error: 'Invalid seller address' });
    }

    try {
        const provider       = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
        const opsWallet      = new ethers.Wallet(process.env.OPERATIONS_PRIVATE_KEY, provider);
        const equity         = new ethers.Contract(EQUITY_REGISTRY_ADDRESS, EQUITY_ABI, opsWallet);

        const listingIdBytes = toBytes32(listingId);
        const companyIdBytes = toBytes32(companyId);
        const priceRaw       = ethers.utils.parseUnits(parseFloat(pricePerUnit).toFixed(6), 6);

        // Verify seller has enough available balance
        const available = await equity.availableBalance(companyIdBytes, seller);
        if (available.lt(ethers.BigNumber.from(units))) {
            return res.status(400).json({
                error: `Insufficient available equity. Seller has ${available.toNumber()} units available, requested ${units}.`
            });
        }

        // V4 does NOT encumber a balance when equity is listed — availableBalance
        // and the contract's own _availableForListing both subtract reservations
        // only, and nothing tracks listed units. Without this check the same units
        // can be listed repeatedly; each extra buyer's USDC then sits locked in the
        // contract until the 7-day expiry, because acceptOffer reverts on
        // "Insufficient equity" once the first sale drains the balance.
        const activeSnap = await db.collection('equityListings')
            .where('companyId', '==', companyId)
            .where('seller', '==', seller.toLowerCase())
            .where('active', '==', true)
            .get();

        let alreadyListed = 0;
        for (const d of activeSnap.docs) {
            const row = d.data();
            try {
                const onChain = await equity.listings(toBytes32(row.listingId || d.id));
                if (onChain.active) alreadyListed += onChain.units.toNumber();
            } catch (e) { /* unreadable row — do not count it */ }
        }

        const sellable = available.toNumber() - alreadyListed;
        if (sellable < Number(units)) {
            return res.status(400).json({
                error: `Only ${sellable} units can be listed. You hold ${available.toNumber()} and already have ${alreadyListed} listed.`
            });
        }

        const tx = await equity.adminListEquity(listingIdBytes, companyIdBytes, seller, units, priceRaw, await gasOverrides(provider));
        await tx.wait();

        console.log(`✅ Listed ${units} units of ${companyId} for seller ${seller}`);
        console.log(`   Listing ID: ${listingId}`);
        console.log(`   Price: ${pricePerUnit} USDC/unit`);
        console.log(`   Tx: ${tx.hash}`);

        return res.status(200).json({
            success: true,
            txHash: tx.hash,
            listingId,
            units,
            pricePerUnit
        });

    } catch(e) {
        console.error('admin-list-equity error:', e.message);

        let userMessage = e.message;
        if (e.message.includes('UNPREDICTABLE_GAS_LIMIT') ||
            e.message.includes('gas required exceeds allowance') ||
            e.message.includes('insufficient funds')) {
            userMessage = 'PLATFORM_GAS_ERROR';
        } else if (e.message.includes('Listing exists')) {
            userMessage = 'A listing with this ID already exists.';
        } else if (e.message.includes('Insufficient available equity')) {
            userMessage = 'Insufficient available equity to create this listing.';
        } else if (e.message.includes('Company not registered')) {
            userMessage = 'This company is not registered on the Equity Registry.';
        } else if (e.message.includes('Company equity paused')) {
            userMessage = 'This company\'s equity is currently paused.';
        }

        return res.status(500).json({ error: userMessage });
    }
}

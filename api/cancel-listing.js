// api/cancel-listing.js
// Called when a seller wants to cancel an equity listing.
// Uses Operations wallet (owner) to call cancelListing() on V4,
// bypassing MetaMask Delegation Manager interference.

import { ethers } from 'ethers';

const EQUITY_REGISTRY_ADDRESS = '0xc640185Dab975D2D3dAEE360Bd3599B7eC45A4f2';
const ARBITRUM_RPC            = 'https://arb1.arbitrum.io/rpc';

const EQUITY_ABI = [
    "function cancelListing(bytes32 listingId) external",
    "function listings(bytes32 listingId) external view returns (bytes32 companyId, address seller, uint128 units, uint128 pricePerUnit, bool active)"
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

    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${process.env.INTERNAL_API_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { listingId, callerAddress } = req.body;
    if (!listingId) return res.status(400).json({ error: 'Missing listingId' });

    try {
        const provider  = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
        const opsWallet = new ethers.Wallet(process.env.OPERATIONS_PRIVATE_KEY, provider);
        const equity    = new ethers.Contract(EQUITY_REGISTRY_ADDRESS, EQUITY_ABI, opsWallet);

        const listingIdBytes = toBytes32(listingId);

        // Verify listing exists and caller is the seller
        const listing = await equity.listings(listingIdBytes);
        if (!listing.active) {
            return res.status(400).json({ error: 'Listing is not active' });
        }
        if (callerAddress && listing.seller.toLowerCase() !== callerAddress.toLowerCase()) {
            return res.status(403).json({ error: 'Only the seller can cancel this listing' });
        }

        const tx = await equity.cancelListing(listingIdBytes);
        await tx.wait();

        console.log(`✅ Listing cancelled: ${listingId} | Tx: ${tx.hash}`);

        return res.status(200).json({ success: true, txHash: tx.hash });

    } catch(e) {
        console.error('cancel-listing error:', e.message);

        let userMessage = e.message;
        if (e.message.includes('UNPREDICTABLE_GAS_LIMIT') ||
            e.message.includes('insufficient funds')) {
            userMessage = 'PLATFORM_GAS_ERROR';
        } else if (e.message.includes('Not active')) {
            userMessage = 'This listing is no longer active.';
        } else if (e.message.includes('Not authorized')) {
            userMessage = 'Only the seller can cancel this listing.';
        }

        return res.status(500).json({ error: userMessage });
    }
}

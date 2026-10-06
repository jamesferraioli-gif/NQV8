// api/accept-offer.js
// Called immediately after buyer makes an offer at asking price.
// Ops wallet accepts on behalf of seller — completing the trade atomically.

import { ethers } from 'ethers';

const EQUITY_REGISTRY_ADDRESS = '0xc640185Dab975D2D3dAEE360Bd3599B7eC45A4f2';
const ARBITRUM_RPC            = 'https://arb1.arbitrum.io/rpc';

const EQUITY_ABI = [
    "function acceptOffer(bytes32 offerId) external"
];

function toBytes32(str) {
    return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(str));
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${process.env.INTERNAL_API_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { offerId } = req.body;
    if (!offerId) return res.status(400).json({ error: 'Missing offerId' });

    try {
        const provider  = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
        const opsWallet = new ethers.Wallet(process.env.OPERATIONS_PRIVATE_KEY, provider);
        const equity    = new ethers.Contract(EQUITY_REGISTRY_ADDRESS, EQUITY_ABI, opsWallet);

        const tx = await equity.acceptOffer(toBytes32(offerId));
        await tx.wait();

        console.log(`✅ Offer accepted: ${offerId} | Tx: ${tx.hash}`);

        return res.status(200).json({ success: true, txHash: tx.hash });

    } catch(e) {
        console.error('accept-offer error:', e.message);

        let userMessage = e.message;
        if (e.message.includes('UNPREDICTABLE_GAS_LIMIT') ||
            e.message.includes('insufficient funds')) {
            userMessage = 'PLATFORM_GAS_ERROR';
        } else if (e.message.includes('Offer not active')) {
            userMessage = 'This offer is no longer active.';
        } else if (e.message.includes('Listing not active')) {
            userMessage = 'This listing is no longer active.';
        }

        return res.status(500).json({ error: userMessage });
    }
}

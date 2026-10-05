// api/admin-make-offer.js
// Called when a user wants to make an offer on an equity listing.
// Uses Operations wallet to call adminMakeOffer() on V4, bypassing
// MetaMask Delegation Manager interference.
// Buyer must have pre-approved USDC to the V4 contract address.

import { ethers } from 'ethers';

const EQUITY_REGISTRY_ADDRESS = '0xc640185Dab975D2D3dAEE360Bd3599B7eC45A4f2';
const ARBITRUM_RPC            = 'https://arb1.arbitrum.io/rpc';
const USDC_ADDRESS            = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const PLATFORM_FEE_BPS        = 350;

const EQUITY_ABI = [
    "function adminMakeOffer(bytes32 offerId, bytes32 listingId, address buyer, uint256 units, uint256 pricePerUnit) external",
    "function listings(bytes32 listingId) external view returns (bytes32 companyId, address seller, uint128 units, uint128 pricePerUnit, bool active)"
];

const ERC20_ABI = [
    "function allowance(address owner, address spender) external view returns (uint256)",
    "function balanceOf(address account) external view returns (uint256)"
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

    const { offerId, listingId, buyer, units, pricePerUnit } = req.body;

    if (!offerId || !listingId || !buyer || !units || !pricePerUnit) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!ethers.utils.isAddress(buyer)) {
        return res.status(400).json({ error: 'Invalid buyer address' });
    }

    try {
        const provider   = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
        const opsWallet  = new ethers.Wallet(process.env.OPERATIONS_PRIVATE_KEY, provider);
        const equity     = new ethers.Contract(EQUITY_REGISTRY_ADDRESS, EQUITY_ABI, opsWallet);
        const usdc       = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);

        const offerIdBytes   = toBytes32(offerId);
        const listingIdBytes = toBytes32(listingId);
        const priceRaw       = ethers.utils.parseUnits(parseFloat(pricePerUnit).toFixed(6), 6);
        const totalPrice     = priceRaw.mul(units);
        const fee            = totalPrice.mul(PLATFORM_FEE_BPS).div(10000);
        const totalRequired  = totalPrice.add(fee);

        // Check buyer's USDC allowance to the V4 contract
        const allowance = await usdc.allowance(buyer, EQUITY_REGISTRY_ADDRESS);
        if (allowance.lt(totalRequired)) {
            return res.status(400).json({
                error: `Insufficient USDC allowance. Please approve ${ethers.utils.formatUnits(totalRequired, 6)} USDC to the equity contract first.`,
                required: ethers.utils.formatUnits(totalRequired, 6),
                approved: ethers.utils.formatUnits(allowance, 6)
            });
        }

        // Check buyer's USDC balance
        const balance = await usdc.balanceOf(buyer);
        if (balance.lt(totalRequired)) {
            return res.status(400).json({
                error: `Insufficient USDC balance. Required: $${ethers.utils.formatUnits(totalRequired, 6)}.`
            });
        }

        const tx = await equity.adminMakeOffer(offerIdBytes, listingIdBytes, buyer, units, priceRaw);
        await tx.wait();

        console.log(`✅ Offer made: ${units} units at ${pricePerUnit} USDC/unit`);
        console.log(`   Offer ID: ${offerId}, Listing: ${listingId}`);
        console.log(`   Buyer: ${buyer}`);
        console.log(`   Tx: ${tx.hash}`);

        return res.status(200).json({
            success: true,
            txHash: tx.hash,
            offerId,
            listingId,
            units,
            pricePerUnit,
            totalPrice: ethers.utils.formatUnits(totalPrice, 6)
        });

    } catch(e) {
        console.error('admin-make-offer error:', e.message);

        let userMessage = e.message;
        if (e.message.includes('UNPREDICTABLE_GAS_LIMIT') ||
            e.message.includes('gas required exceeds allowance') ||
            e.message.includes('insufficient funds')) {
            userMessage = 'PLATFORM_GAS_ERROR';
        } else if (e.message.includes('Listing not active')) {
            userMessage = 'This listing is no longer active.';
        } else if (e.message.includes('Offer exists')) {
            userMessage = 'An offer with this ID already exists.';
        } else if (e.message.includes('USDC transfer failed')) {
            userMessage = 'USDC transfer failed. Please ensure you have approved enough USDC.';
        }

        return res.status(500).json({ error: userMessage });
    }
}

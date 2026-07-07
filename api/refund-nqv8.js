// api/refund-nqv8.js
// Refunds NQV8 fees from the Operations wallet back to a user
// when a service fails through no fault of the user (API overload,
// technical error, etc.). NOT used for user-initiated reversals.

import { ethers } from 'ethers';

const NQV8_ADDRESS    = '0x02b3EF81d6577507114BB26F91F1a8d0A7bB1B67';
const ARBITRUM_RPC    = 'https://arb1.arbitrum.io/rpc';

const ERC20_ABI = [
    "function transfer(address to, uint256 amount) returns (bool)",
    "function balanceOf(address owner) view returns (uint256)"
];

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${process.env.INTERNAL_API_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { recipientAddress, nqv8Amount, reason } = req.body;

    if (!recipientAddress || !nqv8Amount || nqv8Amount <= 0) {
        return res.status(400).json({ error: 'recipientAddress and nqv8Amount required' });
    }

    if (!ethers.utils.isAddress(recipientAddress)) {
        return res.status(400).json({ error: 'Invalid recipient address' });
    }

    try {
        const provider = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
        const wallet   = new ethers.Wallet(process.env.OPERATIONS_PRIVATE_KEY, provider);
        const nqv8     = new ethers.Contract(NQV8_ADDRESS, ERC20_ABI, wallet);

        const amountRaw = ethers.utils.parseUnits(String(nqv8Amount), 18);

        // Check Operations wallet has enough NQV8 to refund
        const balance = await nqv8.balanceOf(wallet.address);
        if (balance.lt(amountRaw)) {
            return res.status(400).json({
                error: 'Insufficient NQV8 in Operations wallet for refund',
                required: nqv8Amount,
                available: ethers.utils.formatUnits(balance, 18)
            });
        }

        const tx = await nqv8.transfer(recipientAddress, amountRaw);
        await tx.wait();

        console.log(`✅ Refunded ${nqv8Amount} NQV8 to ${recipientAddress}`);
        console.log(`   Reason: ${reason || 'Not specified'}`);
        console.log(`   Tx: ${tx.hash}`);

        return res.status(200).json({
            success: true,
            txHash: tx.hash,
            nqv8Amount,
            recipientAddress
        });

    } catch(e) {
        console.error('refund-nqv8 error:', e.message);
        return res.status(500).json({ error: e.message });
    }
}

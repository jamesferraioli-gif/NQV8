// api/escrow-release.js
// Called when a founder approves submitted work on a USDC bounty.
// Calls releaseEscrow() from the Operations wallet server-side —
// no MetaMask interaction needed for the founder.
// The escrow contract splits automatically: 96.5% to worker, 3.5% to platform.

import { ethers } from 'ethers';

const ESCROW_CONTRACT_ADDRESS = '0xE484561B8D1c4274853CDE01d397294CBa5dEaCa';
const ARBITRUM_RPC            = 'https://arb1.arbitrum.io/rpc';

const ESCROW_ABI = [
    "function adminRelease(bytes32 escrowId) external",
    "function projectToEscrow(string projectId) external view returns (bytes32)",
    "function escrows(bytes32 escrowId) external view returns (address poster, address worker, uint256 amount, uint8 currency, uint256 deadline, uint8 status)"
];

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

    const { projectId } = req.body;
    if (!projectId) return res.status(400).json({ error: 'Missing projectId' });

    try {
        const provider      = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
        const opsWallet     = new ethers.Wallet(process.env.OPERATIONS_PRIVATE_KEY, provider);
        const escrowContract = new ethers.Contract(ESCROW_CONTRACT_ADDRESS, ESCROW_ABI, opsWallet);

        // Get escrow ID for this project
        const escrowId = await escrowContract.projectToEscrow(projectId);
        if (escrowId === '0x0000000000000000000000000000000000000000000000000000000000000000') {
            return res.status(400).json({ error: 'No escrow found for this project' });
        }

        console.log(`💰 Releasing escrow for project ${projectId}`);

        // Release escrow — contract splits 96.5% to worker, 3.5% to platform
        const tx = await escrowContract.adminRelease(escrowId, { gasLimit: 300000 });
        await tx.wait();

        console.log(`✅ Escrow released. Tx: ${tx.hash}`);

        return res.status(200).json({
            success: true,
            txHash: tx.hash
        });

    } catch(e) {
        console.error('escrow-release error:', e.message);

        let userMessage = e.message;
        if (e.message.includes('UNPREDICTABLE_GAS_LIMIT') || e.message.includes('gas required exceeds allowance')) {
            userMessage = 'Platform wallet has insufficient ETH for gas. Please contact NQVate support.';
        } else if (e.message.includes('Not poster')) {
            userMessage = 'Only the posting founder can release escrow.';
        } else if (e.message.includes('Already released') || e.message.includes('Invalid status')) {
            userMessage = 'This escrow has already been released.';
        }

        return res.status(500).json({ error: userMessage });
    }
}

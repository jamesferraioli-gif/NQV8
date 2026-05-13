// api/transfer-equity.js
// Called when a poster accepts a submission on an equity-compensated bounty.
// Uses the Operations wallet (owner of EquityRegistry) to call adminTransferEquity().
// This is the only way to transfer equity automatically — the contract requires onlyOwner.

import { ethers } from 'ethers';

const EQUITY_REGISTRY_ADDRESS = '0xb4085b1eDd626cc401FB87784b73E23D5c4eb909';
const ARBITRUM_RPC            = 'https://arb1.arbitrum.io/rpc';

const EQUITY_REGISTRY_ABI = [
    "function adminTransferEquity(string projectId, address from, address to, uint256 units, string reason) external",
    "function getBalance(string projectId, address wallet) external view returns (uint256 units, uint256 percentageBps)",
    "function getProject(string projectId) external view returns (tuple(string projectId, string name, address founder, bool exists, uint256 createdAt, uint256 lastSalePricePerUnit, uint256 lastSaleAt, uint256 totalTradeVolume, bytes32 metricsHash, uint256 metricsUpdatedAt))"
];

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const {
        projectId,      // Firestore company/project ID (used as equity registry project ID)
        founderWallet,  // address to transfer FROM (founder holds 100% initially)
        workerWallet,   // address to transfer TO (worker who completed the bounty)
        units,          // number of equity units to transfer (1 unit = 0.01%)
        reason,         // human readable reason stored on-chain
        bountyTitle,    // for logging only
        callerUid       // Firebase UID of the poster — for basic auth
    } = req.body;

    // ── Basic validation ──────────────────────────────────────────────────
    if (!projectId || !founderWallet || !workerWallet || !units || !reason) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!ethers.utils.isAddress(founderWallet)) {
        return res.status(400).json({ error: 'Invalid founder wallet address' });
    }

    if (!ethers.utils.isAddress(workerWallet)) {
        return res.status(400).json({ error: 'Invalid worker wallet address' });
    }

    const unitsNum = parseInt(units);
    if (isNaN(unitsNum) || unitsNum <= 0 || unitsNum > 10000) {
        return res.status(400).json({ error: 'Invalid units — must be between 1 and 10000' });
    }

    if (!process.env.OPERATIONS_PRIVATE_KEY) {
        return res.status(500).json({ error: 'Operations key not configured' });
    }

    try {
        const provider       = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
        const opsWallet      = new ethers.Wallet(process.env.OPERATIONS_PRIVATE_KEY, provider);
        const equityContract = new ethers.Contract(EQUITY_REGISTRY_ADDRESS, EQUITY_REGISTRY_ABI, opsWallet);

        // ── 1. Verify project exists in registry ──────────────────────────
        const project = await equityContract.getProject(projectId);
        if (!project.exists) {
            return res.status(400).json({
                error: 'Project not registered in equity registry. Has the business been verified?'
            });
        }

        // ── 2. Verify founder has enough units ────────────────────────────
        const [founderUnits] = await equityContract.getBalance(projectId, founderWallet);
        if (founderUnits.lt(unitsNum)) {
            return res.status(400).json({
                error: `Founder only has ${founderUnits.toString()} units but transfer requires ${unitsNum} units.`
            });
        }

        // ── 3. Execute on-chain transfer ──────────────────────────────────
        const tx = await equityContract.adminTransferEquity(
            projectId,
            founderWallet,
            workerWallet,
            unitsNum,
            reason
        );

        await tx.wait();

        const percentage = (unitsNum / 10000 * 100).toFixed(2);

        console.log(`✅ Equity transferred: ${unitsNum} units (${percentage}%) in ${project.name}`);
        console.log(`   From: ${founderWallet}`);
        console.log(`   To:   ${workerWallet}`);
        console.log(`   Reason: ${reason}`);
        console.log(`   Tx: ${tx.hash}`);

        return res.json({
            success:    true,
            txHash:     tx.hash,
            projectId,
            projectName: project.name,
            units:      unitsNum,
            percentage,
            from:       founderWallet,
            to:         workerWallet,
            reason,
            arbiscanUrl: `https://arbiscan.io/tx/${tx.hash}`
        });

    } catch(e) {
        console.error('transfer-equity failed:', e.message);

        // Return meaningful errors
        const msg = e.message || '';
        if (msg.includes('Insufficient balance')) {
            return res.status(400).json({ error: 'Insufficient equity balance for transfer.' });
        }
        if (msg.includes('Project not registered')) {
            return res.status(400).json({ error: 'Project not found in equity registry.' });
        }

        return res.status(500).json({ error: e.message });
    }
}

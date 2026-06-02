import { ethers } from 'ethers';

const ARBITRUM_RPC = 'https://arb1.arbitrum.io/rpc';
const EQUITY_REGISTRY_ADDRESS = '0xb4085b1eDd626cc401FB87784b73E23D5c4eb909';

const EQUITY_REGISTRY_ABI = [
    "function registerProject(string projectId, string name, address founder) external"
];

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { projectId, companyName, founderWallet, callerUid } = req.body;

    if (!projectId || !companyName || !founderWallet) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!process.env.OPERATIONS_PRIVATE_KEY) {
        return res.status(500).json({ error: 'Operations key not configured' });
    }

    try {
        const provider = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
        const operationsWallet = new ethers.Wallet(process.env.OPERATIONS_PRIVATE_KEY, provider);
        const equityContract = new ethers.Contract(EQUITY_REGISTRY_ADDRESS, EQUITY_REGISTRY_ABI, operationsWallet);

        const tx = await equityContract.registerProject(projectId, companyName, founderWallet);
        const receipt = await tx.wait();

        console.log(`✅ Equity registered: ${projectId} → ${founderWallet} | tx: ${receipt.transactionHash}`);

        return res.status(200).json({
            success: true,
            txHash: receipt.transactionHash,
            projectId,
            founderWallet
        });

    } catch (e) {
        console.error('register-equity error:', e.message);
        return res.status(500).json({ error: e.message });
    }
}

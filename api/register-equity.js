import { ethers } from 'ethers';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { credential } from 'firebase-admin';

const ARBITRUM_RPC = 'https://arb1.arbitrum.io/rpc';
const EQUITY_REGISTRY_ADDRESS = '0x74aA0020E84d485AeE9eEAE9bd584A8A12276a9D';

const EQUITY_REGISTRY_ABI = [
    "function registerProject(string projectId, string name, address founder) external"
];

if (!getApps().length) {
    initializeApp({
        credential: credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
}
const db = getFirestore();

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

        // Index founder as initial 100% (10000 bps units) holder for cap table
        try {
            await db.collection('equityHolders').doc(`${projectId}_${founderWallet.toLowerCase()}`).set({
                projectId,
                wallet: founderWallet.toLowerCase(),
                units: 10000,
                isFounder: true,
                lastTxHash: receipt.transactionHash,
                updatedAt: FieldValue.serverTimestamp()
            }, { merge: true });
        } catch(indexErr) {
            console.warn('Cap table founder indexing failed (non-fatal):', indexErr.message);
        }

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

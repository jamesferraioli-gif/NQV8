// api/register-equity.js
// Called when a company is verified — registers it on V4 equity registry
// and assigns 10,000 units to the founder wallet.

import { ethers } from 'ethers';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { credential } from 'firebase-admin';

const ARBITRUM_RPC            = 'https://arb1.arbitrum.io/rpc';
const EQUITY_REGISTRY_ADDRESS = '0xc640185Dab975D2D3dAEE360Bd3599B7eC45A4f2';

const EQUITY_REGISTRY_ABI = [
    "function registerCompany(bytes32 companyId, address founder) external",
    "function companies(bytes32 companyId) external view returns (address founder, uint64 registeredAt, bool registered, bool paused)"
];

function toBytes32(str) {
    return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(str));
}

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

    if (!ethers.utils.isAddress(founderWallet)) {
        return res.status(400).json({ error: 'Invalid founder wallet address' });
    }

    if (!process.env.OPERATIONS_PRIVATE_KEY) {
        return res.status(500).json({ error: 'Operations key not configured' });
    }

    try {
        const provider        = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
        const opsWallet       = new ethers.Wallet(process.env.OPERATIONS_PRIVATE_KEY, provider);
        const equityContract  = new ethers.Contract(EQUITY_REGISTRY_ADDRESS, EQUITY_REGISTRY_ABI, opsWallet);

        const companyIdBytes = toBytes32(projectId);

        // Check if already registered
        const existing = await equityContract.companies(companyIdBytes).catch(() => null);
        if (existing && existing.registered) {
            console.log(`⚠️ Company ${projectId} already registered on V4`);
            return res.status(200).json({
                success: true,
                alreadyRegistered: true,
                txHash: null,
                projectId,
                founderWallet
            });
        }

        const tx      = await equityContract.registerCompany(companyIdBytes, founderWallet);
        const receipt = await tx.wait();

        console.log(`✅ Company registered on V4: ${projectId} → ${founderWallet}`);
        console.log(`   Tx: ${receipt.transactionHash}`);

        // Index founder as 100% holder for cap table
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

    } catch(e) {
        console.error('register-equity error:', e.message);

        let userMessage = e.message;
        if (e.message.includes('Already registered')) {
            userMessage = 'This company is already registered on the equity registry.';
        } else if (e.message.includes('UNPREDICTABLE_GAS_LIMIT') ||
                   e.message.includes('insufficient funds')) {
            userMessage = 'PLATFORM_GAS_ERROR';
        }

        return res.status(500).json({ error: userMessage });
    }
}

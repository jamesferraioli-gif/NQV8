// api/transfer-equity.js
// Manual / fallback equity transfer. Uses the Operations wallet (owner of
// NQVateEquityRegistryV4) to call transferEquity() — the contract requires onlyOwner.
//
// Normal bounty payouts go through equity-reserve.js → equity-complete.js.
// This endpoint is the direct-transfer path used for corrections and manual
// founder-initiated grants from the Studio cap table.
//
// V4 notes:
//   - All IDs are bytes32 — keccak256 of the Firestore document ID
//   - transferEquity(bytes32 companyId, address from, address to, uint256 units)
//   - V4 takes no on-chain `reason`; it is stored in Firestore only
//   - Company lookup is companies(bytes32) → (founder, registeredAt, registered, paused)

import { ethers } from 'ethers';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { verifyCaller } from './_auth.js';
import { gasOverrides } from './_gas.js';

const EQUITY_REGISTRY_ADDRESS = '0x726a5EEa94C6d3117bbCd05336A0Cfdaf3c9327a'; // V4
const ARBITRUM_RPC            = 'https://arb1.arbitrum.io/rpc';

const EQUITY_REGISTRY_ABI = [
    "function transferEquity(bytes32 companyId, address from, address to, uint256 units) external",
    "function balances(bytes32 companyId, address holder) external view returns (uint256)",
    "function availableBalance(bytes32 companyId, address holder) external view returns (uint256)",
    "function companies(bytes32 companyId) external view returns (address founder, uint64 registeredAt, bool registered, bool paused)"
];

if (!getApps().length) {
    initializeApp({
        credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
}
const db = getFirestore();

function toBytes32(str) {
    return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(str));
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const caller = await verifyCaller(req);
    if (!caller) return res.status(401).json({ error: 'Unauthorized' });

    const {
        projectId,      // Firestore company document ID
        founderWallet,  // address to transfer FROM
        workerWallet,   // address to transfer TO
        units,          // equity units (1 unit = 0.01%)
        reason,         // stored in Firestore only — V4 has no on-chain reason
        bountyTitle     // for logging and the Firestore audit record
    } = req.body;

    // Trust the verified token uid over anything in the body
    const effectiveUid = caller.uid || req.body.callerUid || null;

    // ── Validation ────────────────────────────────────────────────────────
    if (!projectId || !founderWallet || !workerWallet || !units || !reason) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!ethers.utils.isAddress(founderWallet)) {
        return res.status(400).json({ error: 'Invalid founder wallet address' });
    }
    if (!ethers.utils.isAddress(workerWallet)) {
        return res.status(400).json({ error: 'Invalid worker wallet address' });
    }
    if (founderWallet.toLowerCase() === workerWallet.toLowerCase()) {
        return res.status(400).json({ error: 'Sender and recipient must be different wallets' });
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

        const companyIdBytes = toBytes32(projectId);

        // ── 1. Company must be registered and not paused ──────────────────
        const company = await equityContract.companies(companyIdBytes);
        if (!company.registered) {
            return res.status(400).json({
                error: 'Company not registered in the equity registry. Has the business been verified?'
            });
        }
        if (company.paused) {
            return res.status(400).json({
                error: 'This company is paused — equity transfers are frozen pending dispute resolution.'
            });
        }

        // ── 2. Caller must own the company, unless this is a service call ──
        if (!caller.service && effectiveUid) {
            const companyDoc = await db.collection('companies').doc(projectId).get();
            if (!companyDoc.exists) {
                return res.status(404).json({ error: 'Company not found' });
            }
            if (companyDoc.data().ownerUid !== effectiveUid) {
                return res.status(403).json({ error: 'Only the company owner can transfer equity' });
            }
        }

        // ── 3. Sender must hold enough unreserved equity ───────────────────
        // availableBalance excludes units locked in reservations or listings
        const available = await equityContract.availableBalance(companyIdBytes, founderWallet);
        if (available.lt(unitsNum)) {
            return res.status(400).json({
                error: `Only ${available.toString()} units available but ${unitsNum} requested. Some equity may be reserved for active bounties or listings.`
            });
        }

        // ── 4. Execute on-chain transfer ───────────────────────────────────
        const tx = await equityContract.transferEquity(
            companyIdBytes,
            founderWallet,
            workerWallet,
            unitsNum,
            await gasOverrides(provider)
        );
        await tx.wait();

        const percentage = (unitsNum / 10000 * 100).toFixed(2);

        // ── 5. Index to Firestore for cap table reconstruction ─────────────
        try {
            await db.collection('equityTransfers').add({
                projectId,
                companyIdBytes,
                from:        founderWallet.toLowerCase(),
                to:          workerWallet.toLowerCase(),
                initiatedBy: effectiveUid,
                units:       unitsNum,
                reason,
                bountyTitle: bountyTitle || null,
                txHash:      tx.hash,
                createdAt:   FieldValue.serverTimestamp()
            });

            const holderRef = db.collection('equityHolders').doc(`${projectId}_${workerWallet.toLowerCase()}`);
            await holderRef.set({
                projectId,
                wallet:     workerWallet.toLowerCase(),
                units:      FieldValue.increment(unitsNum),
                lastTxHash: tx.hash,
                updatedAt:  FieldValue.serverTimestamp()
            }, { merge: true });

            const founderRef = db.collection('equityHolders').doc(`${projectId}_${founderWallet.toLowerCase()}`);
            await founderRef.set({
                projectId,
                wallet:     founderWallet.toLowerCase(),
                units:      FieldValue.increment(-unitsNum),
                lastTxHash: tx.hash,
                updatedAt:  FieldValue.serverTimestamp()
            }, { merge: true });
        } catch(indexErr) {
            console.warn('Cap table indexing failed (non-fatal):', indexErr.message);
        }

        console.log(`✅ Equity transferred: ${unitsNum} units (${percentage}%) for company ${projectId}`);
        console.log(`   From: ${founderWallet}`);
        console.log(`   To:   ${workerWallet}`);
        console.log(`   Reason: ${reason}`);
        console.log(`   Tx: ${tx.hash}`);

        return res.json({
            success:     true,
            txHash:      tx.hash,
            projectId,
            units:       unitsNum,
            percentage,
            from:        founderWallet,
            to:          workerWallet,
            reason,
            arbiscanUrl: `https://arbiscan.io/tx/${tx.hash}`
        });

    } catch(e) {
        console.error('transfer-equity failed:', e.message);

        const msg = e.message || '';
        if (msg.includes('UNPREDICTABLE_GAS_LIMIT') ||
            msg.includes('insufficient funds') ||
            msg.includes('gas required exceeds allowance')) {
            return res.status(500).json({ error: 'PLATFORM_GAS_ERROR' });
        }
        if (msg.includes('Insufficient balance')) {
            return res.status(400).json({ error: 'Insufficient equity balance for transfer.' });
        }
        if (msg.includes('Company not registered')) {
            return res.status(400).json({ error: 'Company not found in the equity registry.' });
        }
        if (msg.includes('Company paused')) {
            return res.status(400).json({ error: 'Equity transfers are frozen for this company.' });
        }
        if (msg.includes('Invalid recipient')) {
            return res.status(400).json({ error: 'Invalid recipient address.' });
        }

        return res.status(500).json({ error: e.message });
    }
}

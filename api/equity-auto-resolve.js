// api/equity-auto-resolve.js
// Runs daily via Vercel cron.
// Finds equity bounties where:
//   - Work was submitted (latest submission status = 'pending')
//   - Founder has not responded in 7+ days
//   - Equity is still reserved on V4
// Auto-completes the reservation in the builder's favor.

import { ethers } from 'ethers';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (!getApps().length) {
    initializeApp({
        credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
}
const db = getFirestore();

const EQUITY_REGISTRY_ADDRESS = '0xc640185Dab975D2D3dAEE360Bd3599B7eC45A4f2';
const PLATFORM_WALLET         = '0x2c6309Ed2e36222E7e0Ce3c1376941A0D6340F4D';
const PLATFORM_FEE_BPS        = 350;
const ARBITRUM_RPC            = 'https://arb1.arbitrum.io/rpc';
const AUTO_RELEASE_DAYS       = parseInt(process.env.AUTO_RELEASE_DAYS || '7');

const EQUITY_ABI = [
    "function completeReservation(bytes32 companyId, bytes32 bountyId, address platformWallet, uint256 feeBps) external",
    "function reservations(bytes32 companyId, bytes32 bountyId) external view returns (address founder, address beneficiary, uint128 units, bool active)",
    "function balances(bytes32 companyId, address wallet) external view returns (uint256)"
];

function toBytes32(str) {
    return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(str));
}

export default async function handler(req, res) {
    if (req.method !== 'POST' && req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}` &&
        authHeader !== `Bearer ${process.env.INTERNAL_API_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - AUTO_RELEASE_DAYS);

    console.log(`🕐 equity-auto-resolve: checking for stale equity bounties submitted before ${cutoff.toISOString()}`);

    try {
        const snap = await db.collection('subprojects')
            .where('status', '==', 'in-progress')
            .where('equityReserved', '==', true)
            .get();

        const provider       = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
        const opsWallet      = new ethers.Wallet(process.env.OPERATIONS_PRIVATE_KEY, provider);
        const equityContract = new ethers.Contract(EQUITY_REGISTRY_ADDRESS, EQUITY_ABI, opsWallet);

        const results = [];

        for (const doc of snap.docs) {
            const project   = doc.data();
            const projectId = doc.id;

            try {
                // Skip if already transferred
                if (project.equityTransferred === true) continue;

                const submissions = project.submissions || [];
                if (submissions.length === 0) continue;

                const latest = submissions[submissions.length - 1];
                if (latest.status !== 'pending') continue;

                const submittedAt = latest.submittedAt?.toDate
                    ? latest.submittedAt.toDate()
                    : new Date(latest.submittedAt);

                if (submittedAt > cutoff) continue;

                // Verify reservation is still active on V4
                const companyIdBytes = toBytes32(project.companyId);
                const bountyIdBytes  = toBytes32(projectId);
                const reservation    = await equityContract.reservations(companyIdBytes, bountyIdBytes);

                if (!reservation.active) {
                    console.log(`⚠️ ${projectId}: reservation not active, skipping`);
                    continue;
                }

                const equityUnits   = reservation.units.toNumber();
                const workerUnits   = Math.round(equityUnits * (10000 - PLATFORM_FEE_BPS) / 10000);
                const platformUnits = equityUnits - workerUnits;

                console.log(`🔓 Auto-releasing equity for ${projectId}: ${equityUnits} units → builder`);

                const tx = await equityContract.completeReservation(
                    companyIdBytes,
                    bountyIdBytes,
                    PLATFORM_WALLET,
                    PLATFORM_FEE_BPS
                );
                await tx.wait();

                console.log(`✅ Auto-released ${projectId}. Tx: ${tx.hash}`);

                // Update Firestore
                await db.collection('subprojects').doc(projectId).update({
                    status:                 'completed',
                    completedAt:            new Date(),
                    equityTransferred:      true,
                    equityUnitsTransferred: equityUnits,
                    equityTransferTxHash:   tx.hash,
                    autoReleased:           true,
                    autoReleasedAt:         new Date(),
                    autoReleaseReason:      `Founder did not respond within ${AUTO_RELEASE_DAYS} days of submission`
                });

                // Sync equityHolders from chain. Absolute balances, never
                // increments, so this is idempotent and repairs prior drift.
                const workerWallet = reservation.beneficiary;
                try {
                    const _founderLc = (reservation.founder || '').toLowerCase();
                    const _workerLc  = (workerWallet || '').toLowerCase();
                    const _opsLc     = PLATFORM_WALLET.toLowerCase();

                    const _addrs = [...new Set(
                        [_founderLc, _workerLc, _opsLc]
                            .filter(a => a && a.length === 42 && a !== ethers.constants.AddressZero.toLowerCase())
                    )];

                    for (const _a of _addrs) {
                        const _units = (await equityContract.balances(companyIdBytes, _a)).toNumber();
                        const _rec = {
                            projectId: project.companyId,
                            wallet: _a,
                            units: _units,
                            isFounder: _a === _founderLc,
                            lastSyncedAt: new Date()
                        };
                        if (_a === _workerLc) { _rec.earnedViaBuilding = true; _rec.autoReleased = true; }
                        if (_a === _opsLc)      _rec.isPlatformFee     = true;

                        await db.collection('equityHolders')
                            .doc(`${project.companyId}_${_a}`)
                            .set(_rec, { merge: true });
                    }
                } catch (capErr) {
                    console.warn('Cap table sync failed (non-fatal, chain is authoritative):', capErr.message);
                }

                // Notify both parties
                await db.collection('notifications').add({
                    recipientUid: project.acceptedBidderUid,
                    type: 'auto_release',
                    message: `✅ Equity auto-released for "${project.title}". The founder did not respond within ${AUTO_RELEASE_DAYS} days. ${workerUnits / 100}% transferred to your wallet. Tx: https://arbiscan.io/tx/${tx.hash}`,
                    projectId,
                    read: false,
                    createdAt: new Date()
                });

                await db.collection('notifications').add({
                    recipientUid: project.ownerUid || project.posterUid,
                    type: 'auto_release',
                    message: `⚠️ Equity auto-released for "${project.title}". You did not review the submission within ${AUTO_RELEASE_DAYS} days. ${workerUnits / 100}% equity transferred to the builder per NQVate policy.`,
                    projectId,
                    read: false,
                    createdAt: new Date()
                });

                results.push({ projectId, txHash: tx.hash, equityUnits, status: 'released' });

            } catch(e) {
                if (e.message.includes('UNPREDICTABLE_GAS_LIMIT') ||
                    e.message.includes('gas required exceeds allowance') ||
                    e.message.includes('insufficient funds')) {
                    console.error(`⚠️ PLATFORM GAS LOW — top up Operations wallet. Failed to auto-release ${projectId}:`, e.message);
                } else {
                    console.error(`Failed to auto-release ${projectId}:`, e.message);
                }
                results.push({ projectId, status: 'error', error: e.message });
            }
        }

        console.log(`✅ equity-auto-resolve complete. Processed ${results.length} projects.`);
        return res.json({ success: true, processed: results.length, results });

    } catch(e) {
        if (e.message.includes('UNPREDICTABLE_GAS_LIMIT') ||
            e.message.includes('gas required exceeds allowance') ||
            e.message.includes('insufficient funds')) {
            console.error('⚠️ PLATFORM GAS LOW — top up Operations wallet:', e.message);
        } else {
            console.error('equity-auto-resolve fatal error:', e.message);
        }
        return res.status(500).json({ error: e.message });
    }
}

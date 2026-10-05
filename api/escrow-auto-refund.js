// api/escrow-auto-refund.js
// Runs daily via Vercel cron.
// Finds USDC bounties where:
//   - Status is 'in-progress'
//   - Deadline has passed
//   - No submission has been made (or no accepted submission)
// Auto-refunds the poster's escrow — no manual action needed.

import { ethers } from 'ethers';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { credential } from 'firebase-admin';

if (!getApps().length) {
    initializeApp({
        credential: credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
}
const db = getFirestore();

const ESCROW_CONTRACT_ADDRESS = '0xE484561B8D1c4274853CDE01d397294CBa5dEaCa';
const ARBITRUM_RPC            = 'https://arb1.arbitrum.io/rpc';

const ESCROW_ABI = [
    "function adminRefund(bytes32 escrowId) external",
    "function projectToEscrow(string projectId) external view returns (bytes32)",
    "function escrowCore(bytes32 escrowId) external view returns (address poster, address worker, uint256 amount, uint8 currency, uint256 deadline, uint8 status)"
];

// Deadline string to days mapping
const DEADLINE_DAYS = {
    '1day':    1,
    '1week':   7,
    '1month':  30,
    '3months': 90,
    '1 Day':   1,
    '1 Week':  7,
    '1 Month': 30,
    '3 Months':90
};

function deadlineExpired(project) {
    if (!project.acceptedAt) return false;
    const acceptedAt = project.acceptedAt.toDate ? project.acceptedAt.toDate() : new Date(project.acceptedAt);
    const deadlineStr = project.deadline || '1month';
    const days = DEADLINE_DAYS[deadlineStr] || 30;
    const expiryDate = new Date(acceptedAt);
    expiryDate.setDate(expiryDate.getDate() + days);
    return new Date() > expiryDate;
}

export default async function handler(req, res) {
    if (req.method !== 'POST' && req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    console.log('🕐 escrow-auto-refund: checking for expired escrows...');

    try {
        // Find in-progress USDC bounties with no accepted submission
        const snap = await db.collection('subprojects')
            .where('status', '==', 'in-progress')
            .where('escrowType', '!=', 'equity')
            .get();

        const provider       = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
        const opsWallet      = new ethers.Wallet(process.env.OPERATIONS_PRIVATE_KEY, provider);
        const escrowContract = new ethers.Contract(ESCROW_CONTRACT_ADDRESS, ESCROW_ABI, opsWallet);

        const results = [];

        for (const doc of snap.docs) {
            const project   = doc.data();
            const projectId = doc.id;

            try {
                // Check if deadline has passed
                if (!deadlineExpired(project)) continue;

                // Check if any submission was accepted
                const submissions = project.submissions || [];
                const hasAccepted = submissions.some(s => s.status === 'accepted');
                if (hasAccepted) continue;

                // Get escrow ID
                const escrowId = await escrowContract.projectToEscrow(projectId);
                if (escrowId === '0x0000000000000000000000000000000000000000000000000000000000000000') {
                    console.log(`⚠️ ${projectId}: no escrow found, skipping`);
                    continue;
                }

                // Check escrow status — only refund if still active
                const escrow = await escrowContract.escrowCore(escrowId);
                const escrowStatus = escrow[5].toNumber(); // 0=active, 1=released, 2=refunded, 3=disputed
                if (escrowStatus !== 0) {
                    console.log(`⚠️ ${projectId}: escrow status ${escrowStatus}, skipping`);
                    continue;
                }

                const amount = ethers.utils.formatUnits(escrow[2], 6);
                console.log(`💸 Auto-refunding expired escrow for ${projectId}: $${amount} USDC`);

                // Claim refund
                const tx = await escrowContract.adminRefund(escrowId);
                await tx.wait();

                console.log(`✅ Refunded ${projectId}. Tx: ${tx.hash}`);

                // Update Firestore
                await db.collection('subprojects').doc(projectId).update({
                    status:          'refunded',
                    refundedAt:      new Date(),
                    refundTxHash:    tx.hash,
                    autoRefunded:    true,
                    autoRefundReason: 'Deadline passed with no accepted submission'
                });

                // Notify poster
                await db.collection('notifications').add({
                    recipientUid: project.ownerUid || project.posterUid,
                    type:         'auto_refund',
                    message:      `💸 Your escrow for "${project.title}" was automatically refunded. The deadline passed with no accepted submission. $${amount} USDC returned to your wallet. Tx: https://arbiscan.io/tx/${tx.hash}`,
                    projectId,
                    read:         false,
                    createdAt:    new Date()
                });

                // Notify builder
                if (project.acceptedBidderUid) {
                    await db.collection('notifications').add({
                        recipientUid: project.acceptedBidderUid,
                        type:         'auto_refund',
                        message:      `⚠️ The escrow for "${project.title}" was automatically refunded to the poster. The deadline passed with no accepted submission.`,
                        projectId,
                        read:         false,
                        createdAt:    new Date()
                    });
                }

                results.push({ projectId, txHash: tx.hash, amount, status: 'refunded' });

            } catch(e) {
                if (e.message.includes('UNPREDICTABLE_GAS_LIMIT') || 
                    e.message.includes('gas required exceeds allowance') || 
                    e.message.includes('insufficient funds')) {
                    console.error(`⚠️ PLATFORM GAS LOW — top up Operations wallet. Failed to auto-refund ${projectId}:`, e.message);
                } else {
                    console.error(`Failed to auto-refund ${projectId}:`, e.message);
                }
                results.push({ projectId, status: 'error', error: e.message });
            }
        }

        console.log(`✅ escrow-auto-refund complete. Processed ${results.length} projects.`);
        return res.json({ success: true, processed: results.length, results });

    } catch(e) {
        if (e.message.includes('UNPREDICTABLE_GAS_LIMIT') || 
            e.message.includes('gas required exceeds allowance') || 
            e.message.includes('insufficient funds')) {
            console.error('⚠️ PLATFORM GAS LOW — top up Operations wallet:', e.message);
        } else {
            console.error('escrow-auto-refund fatal error:', e.message);
        }
        return res.status(500).json({ error: e.message });
    }
}

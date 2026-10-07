// api/escrow-auto-release.js
// Runs daily via Vercel cron.
// Finds USDC bounties where:
//   - Work was submitted (latest submission status = 'pending')
//   - Poster has not responded in AUTO_RELEASE_DAYS days
// Auto-releases escrow to builder — no manual action needed.

import { ethers } from 'ethers';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (!getApps().length) {
    initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
const db = getFirestore();

const ESCROW_CONTRACT_ADDRESS = '0x19E9E191e5F277053Db4373FAbb8fBdEa8A30761';
const ARBITRUM_RPC            = 'https://arb1.arbitrum.io/rpc';
const AUTO_RELEASE_DAYS       = parseInt(process.env.AUTO_RELEASE_DAYS || '7');

const ESCROW_ABI = [
    "function adminRelease(bytes32 escrowId) external",
    "function projectToEscrow(bytes32 projectKey) external view returns (bytes32)"
];

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

    console.log(`🕐 escrow-auto-release: checking for stale USDC submissions before ${cutoff.toISOString()}`);

    try {
        const snap = await db.collection('subprojects')
            .where('status', '==', 'in-progress')
            .where('compensationType', 'in', ['cash', 'mixed'])
            .get();

        const provider       = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
        const opsWallet      = new ethers.Wallet(process.env.OPERATIONS_PRIVATE_KEY, provider);
        const escrowContract = new ethers.Contract(ESCROW_CONTRACT_ADDRESS, ESCROW_ABI, opsWallet);

        const results = [];

        for (const doc of snap.docs) {
            const project   = doc.data();
            const projectId = doc.id;

            try {
                // Find latest pending submission
                const submissions = project.submissions || [];
                if (submissions.length === 0) continue;

                const latest = submissions[submissions.length - 1];
                if (latest.status !== 'pending') continue;

                // Check if 7+ days since submission
                const submittedAt = latest.submittedAt?.toDate
                    ? latest.submittedAt.toDate()
                    : new Date(latest.submittedAt);

                if (submittedAt > cutoff) continue;

                // Get escrow ID
                const projectKey = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(projectId));
                const escrowId   = await escrowContract.projectToEscrow(projectKey);

                if (escrowId === '0x0000000000000000000000000000000000000000000000000000000000000000') {
                    console.log(`⚠️ ${projectId}: no escrow found, skipping`);
                    continue;
                }

                console.log(`🔓 Auto-releasing USDC escrow for ${projectId}`);
                const tx = await escrowContract.adminRelease(escrowId);
                await tx.wait();

                console.log(`✅ Auto-released ${projectId}. Tx: ${tx.hash}`);

                // Update Firestore
                await db.collection('subprojects').doc(projectId).update({
                    status:            'completed',
                    completedAt:       new Date(),
                    autoReleased:      true,
                    autoReleasedAt:    new Date(),
                    autoReleaseReason: `Poster did not respond within ${AUTO_RELEASE_DAYS} days of submission`,
                    escrowReleaseTxHash: tx.hash
                });

                // Notify both parties
                await db.collection('notifications').add({
                    recipientUid: project.acceptedBidderUid,
                    type:         'auto_release',
                    message:      `✅ Escrow auto-released for "${project.title}". The poster did not respond within ${AUTO_RELEASE_DAYS} days. Funds sent to your wallet. Tx: https://arbiscan.io/tx/${tx.hash}`,
                    projectId,
                    read:         false,
                    createdAt:    new Date()
                });

                await db.collection('notifications').add({
                    recipientUid: project.ownerUid || project.posterUid,
                    type:         'auto_release',
                    message:      `⚠️ Escrow auto-released for "${project.title}". You did not review the submission within ${AUTO_RELEASE_DAYS} days. Funds sent to the builder per NQVate policy.`,
                    projectId,
                    read:         false,
                    createdAt:    new Date()
                });

                results.push({ projectId, txHash: tx.hash, status: 'released' });

            } catch(e) {
                if (e.message.includes('UNPREDICTABLE_GAS_LIMIT') ||
                    e.message.includes('insufficient funds')) {
                    console.error(`⚠️ PLATFORM GAS LOW — top up Operations wallet. Failed: ${projectId}:`, e.message);
                } else {
                    console.error(`Failed to auto-release ${projectId}:`, e.message);
                }
                results.push({ projectId, status: 'error', error: e.message });
            }
        }

        console.log(`✅ escrow-auto-release complete. Processed ${results.length} projects.`);
        return res.json({ success: true, processed: results.length, results });

    } catch(e) {
        console.error('escrow-auto-release fatal error:', e.message);
        return res.status(500).json({ error: e.message });
    }
}

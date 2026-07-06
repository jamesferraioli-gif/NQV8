// api/resolve-dispute.js
// Fully automated dispute resolution — no human in the loop.
// Called automatically when a dispute is filed.
// Claude reads all evidence, issues a binding ruling, and executes on-chain immediately.

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

const ESCROW_CONTRACT_ADDRESS = '0x413EF7256f8099ea202d8C0fe3e620F5259c7a83';
const ARBITRUM_RPC            = 'https://arb1.arbitrum.io/rpc';

const ESCROW_ABI = [
    "function resolveDispute(bytes32 escrowId, uint256 workerPct, uint256 posterPct, string claudeRuling) external",
    "function projectToEscrow(string) external view returns (bytes32)"
];

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { projectId } = req.body;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });

    try {
        const projectDoc = await db.collection('subprojects').doc(projectId).get();
        if (!projectDoc.exists) return res.status(404).json({ error: 'Project not found' });
        const project = projectDoc.data();

        if (!project.disputeFiled)   return res.status(400).json({ error: 'No dispute filed' });
        if (project.disputeResolved) return res.status(400).json({ error: 'Already resolved' });
        if (project.disputeProcessing) return res.status(400).json({ error: 'Already processing' });

        await db.collection('subprojects').doc(projectId).update({
            disputeProcessing: true,
            disputeProcessingStartedAt: new Date()
        });

        const [posterDoc, workerDoc] = await Promise.all([
            db.collection('users').doc(project.ownerUid || project.posterUid).get().catch(() => null),
            db.collection('users').doc(project.acceptedBidderUid).get().catch(() => null)
        ]);
        const poster = posterDoc?.data() || {};
        const worker = workerDoc?.data() || {};

        const submissions = project.submissions || [];
        const evidenceSummary = submissions.length > 0
            ? submissions.map((s, i) => `
Submission ${i + 1}:
  Description: ${s.description || 'None provided'}
  Link: ${s.link || 'None'}
  Files attached: ${s.files?.length || 0}
  Status: ${s.status}
  Poster feedback: ${s.feedback || 'None'}
  Submitted: ${s.submittedAt ? new Date(s.submittedAt).toISOString() : 'Unknown'}
            `.trim()).join('\n\n')
            : 'NO SUBMISSIONS — worker never submitted any deliverables';

        const filedBy = project.disputeFiledBy === (project.ownerUid || project.posterUid)
            ? 'POSTER (project owner)'
            : 'WORKER (assigned builder)';

        const prompt = `You are Claude, an impartial AI arbitrator for NQVate — a fully decentralized freelance marketplace. You are the SOLE arbitrator for this dispute. Your ruling is BINDING and will be executed on-chain immediately with no human review. There is no appeals process.

NQVate is not a party to any agreement between users. You are acting as a neutral third party.

=== DISPUTE CASE ===

PROJECT TITLE: "${project.title}"
PROJECT DESCRIPTION: ${project.description}
CATEGORY: ${project.category || 'Not specified'}
AGREED COMPENSATION: ${project.compensation}
DEADLINE: ${project.deadline || 'Not specified'}
DISPUTE FILED BY: ${filedBy}

POSTER: @${poster.username || 'unknown'}
WORKER: @${worker.username || 'unknown'}

=== TIMELINE ===
Project posted: ${project.createdAt?.toDate?.()?.toISOString?.() || 'Unknown'}
Bid accepted / escrow locked: ${project.acceptedAt?.toDate?.()?.toISOString?.() || 'Unknown'}
Dispute filed: ${project.disputeFiledAt?.toDate?.()?.toISOString?.() || 'Unknown'}

=== SUBMISSION EVIDENCE ===
${evidenceSummary}

=== ARBITRATION GUIDELINES ===

Determine how to split the escrowed funds. Apply these principles:

1. DELIVERY: Was work actually submitted? No submissions = full refund to poster unless poster blocked submission.
2. QUALITY & SCOPE: Does submitted work address the project requirements?
3. GOOD FAITH: Did both parties act in good faith?
4. FEEDBACK: Did the poster provide clear, legitimate change requests? Did the worker address them?
5. PARTIAL CREDIT: If work was partially completed, award proportional payment.

AVAILABLE RULINGS:
- 100/0 (worker/poster): Work clearly delivered. Poster withholding unfairly.
- 75/25: Work mostly complete, minor gaps.
- 50/50: Ambiguous — partial delivery or mutual fault.
- 25/75: Work substantially incomplete or off-scope.
- 0/100: No meaningful work delivered. Full refund to poster.

Respond ONLY with valid JSON, no markdown:
{
  "workerPct": 0,
  "posterPct": 100,
  "ruling": "Clear 2-3 sentence explanation stored permanently on-chain and shown to both parties.",
  "confidence": "high",
  "keyFindings": ["finding 1", "finding 2"],
  "warningFlags": []
}

workerPct + posterPct MUST equal exactly 100.`;

        const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model:      'claude-sonnet-4-20250514',
                max_tokens: 1000,
                messages:   [{ role: 'user', content: prompt }]
            })
        });

        const claudeData = await claudeResponse.json();
        const rawText    = claudeData.content.filter(b => b.type === 'text').map(b => b.text).join('');
        const ruling     = JSON.parse(rawText.replace(/```json|```/g, '').trim());

        if (ruling.workerPct + ruling.posterPct !== 100) {
            ruling.posterPct = 100 - ruling.workerPct;
        }

        console.log(`⚖️ Claude ruling for ${projectId}: ${ruling.workerPct}% worker / ${ruling.posterPct}% poster`);

        await db.collection('subprojects').doc(projectId).update({
            claudeRuling:       ruling.ruling,
            claudeWorkerPct:    ruling.workerPct,
            claudePosterPct:    ruling.posterPct,
            claudeConfidence:   ruling.confidence,
            claudeKeyFindings:  ruling.keyFindings,
            claudeWarningFlags: ruling.warningFlags,
            claudeRuledAt:      new Date()
        });

        // Execute on-chain
        const provider       = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
        const opsWallet      = new ethers.Wallet(process.env.OPERATIONS_PRIVATE_KEY, provider);
        const escrowContract = new ethers.Contract(ESCROW_CONTRACT_ADDRESS, ESCROW_ABI, opsWallet);

        const escrowId = await escrowContract.projectToEscrow(projectId);
        if (escrowId === '0x0000000000000000000000000000000000000000000000000000000000000000') {
            throw new Error('No escrow found for this project');
        }

        const tx = await escrowContract.resolveDispute(
            escrowId,
            ruling.workerPct,
            ruling.posterPct,
            ruling.ruling
        );
        await tx.wait();

        console.log(`✅ Dispute resolved on-chain. Tx: ${tx.hash}`);

        await db.collection('subprojects').doc(projectId).update({
            status:            'completed',
            disputeResolved:   true,
            disputeProcessing: false,
            disputeResolveTx:  tx.hash,
            disputeResolvedAt: new Date(),
            completedAt:       new Date()
        });

        // Notify both parties
        const workerMsg = `⚖️ Dispute resolved on "${project.title}". ${ruling.workerPct > 0 ? `You receive ${ruling.workerPct}% of escrowed funds.` : 'No funds awarded to you.'} Ruling: ${ruling.ruling}`;
        const posterMsg = `⚖️ Dispute resolved on "${project.title}". ${ruling.posterPct > 0 ? `You are refunded ${ruling.posterPct}% of escrowed funds.` : 'No refund issued.'} Ruling: ${ruling.ruling}`;

        const batch = db.batch();
        batch.set(db.collection('notifications').doc(), {
            recipientUid: project.acceptedBidderUid,
            type: 'dispute', message: workerMsg, read: false, createdAt: new Date(), projectId
        });
        batch.set(db.collection('notifications').doc(), {
            recipientUid: project.ownerUid || project.posterUid,
            type: 'dispute', message: posterMsg, read: false, createdAt: new Date(), projectId
        });
        await batch.commit();

        return res.json({
            success:     true,
            workerPct:   ruling.workerPct,
            posterPct:   ruling.posterPct,
            ruling:      ruling.ruling,
            confidence:  ruling.confidence,
            txHash:      tx.hash,
            arbiscanUrl: `https://arbiscan.io/tx/${tx.hash}`
        });

    } catch(e) {
        console.error('resolve-dispute error:', e);
        await db.collection('subprojects').doc(projectId).update({ disputeProcessing: false }).catch(() => {});
        return res.status(500).json({ error: e.message });
    }
}

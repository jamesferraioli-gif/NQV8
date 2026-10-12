// api/resolve-dispute.js
// Fully automated dispute resolution — no human in the loop.
// Claude reads all evidence, issues a binding ruling, and executes on-chain.
//
// Handles three bounty types:
//   - USDC only  → escrow.resolveDispute() splits funds by percentage
//   - Equity only → completeReservation() or releaseReservation() (all-or-nothing)
//   - Mixed      → BOTH legs are resolved in the same run
//
// Equity cannot be split by percentage: V4 reservations are all-or-nothing,
// so a ruling at or above EQUITY_TRANSFER_THRESHOLD awards the full stake to
// the builder; anything below returns it entirely to the founder.

import { ethers } from 'ethers';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { verifyCaller } from './_auth.js';
import { gasOverrides } from './_gas.js';

if (!getApps().length) {
    initializeApp({
        credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
}
const db = getFirestore();

const ESCROW_CONTRACT_ADDRESS  = '0x19E9E191e5F277053Db4373FAbb8fBdEa8A30761'; // V3
const EQUITY_REGISTRY_ADDRESS  = '0xc640185Dab975D2D3dAEE360Bd3599B7eC45A4f2'; // V4
const PLATFORM_WALLET          = '0x2c6309Ed2e36222E7e0Ce3c1376941A0D6340F4D';
const PLATFORM_FEE_BPS         = 350;
const ARBITRUM_RPC             = 'https://arb1.arbitrum.io/rpc';
// Equity reservations are all-or-nothing in V4 — there is no partial completion.
// Equity only transfers to the builder on a clear win; ambiguous rulings return
// the stake to the founder. Keep this in sync with the arbitration prompt below.
const EQUITY_TRANSFER_THRESHOLD = 75;
const ZERO_BYTES32             = '0x0000000000000000000000000000000000000000000000000000000000000000';

const ESCROW_ABI = [
    "function resolveDispute(bytes32 escrowId, uint256 workerPct, uint256 posterPct, string claudeRuling) external",
    "function projectToEscrow(bytes32 projectKey) external view returns (bytes32)"
];

const EQUITY_ABI = [
    "function completeReservation(bytes32 companyId, bytes32 bountyId, address platformWallet, uint256 feeBps) external",
    "function releaseReservation(bytes32 companyId, bytes32 bountyId) external",
    "function reservations(bytes32 companyId, bytes32 bountyId) external view returns (address founder, address beneficiary, uint128 units, bool active)"
];

function toBytes32(str) {
    return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(str));
}

// Firestore Timestamps, JS Dates and ISO strings all arrive here — normalise them
function fmtDate(v) {
    if (!v) return 'Unknown';
    try {
        if (typeof v.toDate === 'function') return v.toDate().toISOString();
        const d = new Date(v);
        return isNaN(d.getTime()) ? 'Unknown' : d.toISOString();
    } catch { return 'Unknown'; }
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const caller = await verifyCaller(req);
    if (!caller) return res.status(401).json({ error: 'Unauthorized' });

    const { projectId } = req.body;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });

    if (!process.env.ANTHROPIC_API_KEY) {
        return res.status(500).json({ error: 'Arbitration unavailable — ANTHROPIC_API_KEY not configured' });
    }
    if (!process.env.OPERATIONS_PRIVATE_KEY) {
        return res.status(500).json({ error: 'Operations key not configured' });
    }

    try {
        const projectDoc = await db.collection('subprojects').doc(projectId).get();
        if (!projectDoc.exists) return res.status(404).json({ error: 'Project not found' });
        const project = projectDoc.data();

        if (!project.disputeFiled)     return res.status(400).json({ error: 'No dispute filed' });
        if (project.disputeResolved)   return res.status(400).json({ error: 'Already resolved' });
        if (project.disputeProcessing) return res.status(400).json({ error: 'Already processing' });

        // Only a party to the dispute may trigger resolution (service calls exempt)
        if (!caller.service && caller.uid) {
            const posterUid = project.ownerUid || project.posterUid;
            if (caller.uid !== posterUid && caller.uid !== project.acceptedBidderUid) {
                return res.status(403).json({ error: 'Only a party to this bounty can trigger resolution' });
            }
        }

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
  Security scan: ${s.virusScanStatus || 'not scanned'}
  Status: ${s.status}
  Poster feedback: ${s.feedback || 'None'}
  Submitted: ${fmtDate(s.submittedAt)}
            `.trim()).join('\n\n')
            : 'NO SUBMISSIONS — worker never submitted any deliverables';

        const filedBy = project.disputeFiledBy === (project.ownerUid || project.posterUid)
            ? 'POSTER (project owner)'
            : 'WORKER (assigned builder)';

        // Work out what is actually at stake before prompting
        const hasEquity = !!(project.equityReserved && project.companyId && !project.equityTransferred);
        const isMixed   = project.compensationType === 'mixed' || project.escrowType === 'mixed';
        const isEquityOnly = !isMixed && (project.escrowType === 'equity' || project.compensationType === 'equity');

        const equityNote = hasEquity
            ? `\nNOTE ON EQUITY: This bounty includes ${project.equityUnits || 0} equity units (${((project.equityUnits || 0) / 100).toFixed(2)}%) of permanent company ownership.

Equity cannot be split proportionally. A ruling of ${EQUITY_TRANSFER_THRESHOLD}% or above transfers the FULL stake to the worker. Anything below ${EQUITY_TRANSFER_THRESHOLD}% returns it entirely to the founder. Any cash portion still splits by your exact percentage.

Because ownership is permanent and cannot be reversed, only award ${EQUITY_TRANSFER_THRESHOLD}%+ when the worker's delivery is clearly satisfactory. If the outcome is genuinely ambiguous, a percentage below ${EQUITY_TRANSFER_THRESHOLD}% is the safer ruling — the worker still receives that share of any cash.`
            : '';

        const prompt = `You are Claude, an impartial AI arbitrator for NQVate — a fully decentralized freelance marketplace. You are the SOLE arbitrator for this dispute. Your ruling is BINDING and will be executed on-chain immediately with no human review. There is no appeals process.

NQVate is not a party to any agreement between users. You are acting as a neutral third party.

=== DISPUTE CASE ===

PROJECT TITLE: "${project.title}"
PROJECT DESCRIPTION: ${project.description}
CATEGORY: ${project.category || 'Not specified'}
AGREED COMPENSATION: ${project.compensation}
COMPENSATION TYPE: ${project.compensationType || 'unknown'}
DEADLINE: ${project.deadline || 'Not specified'}
DISPUTE FILED BY: ${filedBy}

POSTER: @${poster.username || 'unknown'}
WORKER: @${worker.username || 'unknown'}

=== TIMELINE ===
Project posted: ${fmtDate(project.createdAt)}
Bid accepted / escrow locked: ${fmtDate(project.acceptedAt)}
Dispute filed: ${fmtDate(project.disputeFiledAt)}

=== SUBMISSION EVIDENCE ===
${evidenceSummary}
${equityNote}

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

        // ── Call Claude ───────────────────────────────────────────────────
        const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type':      'application/json',
                'x-api-key':         process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model:      'claude-sonnet-5',
                max_tokens: 1000,
                messages:   [{ role: 'user', content: prompt }]
            })
        });

        if (!claudeResponse.ok) {
            const errBody = await claudeResponse.text().catch(() => '');
            throw new Error(`Claude API ${claudeResponse.status}: ${errBody.slice(0, 300)}`);
        }

        const claudeData = await claudeResponse.json();
        if (!claudeData.content || claudeData.error) {
            throw new Error(`Claude API error: ${claudeData.error?.message || 'No content returned'}`);
        }

        const rawText = claudeData.content.filter(b => b.type === 'text').map(b => b.text).join('');
        let ruling;
        try {
            ruling = JSON.parse(rawText.replace(/```json|```/g, '').trim());
        } catch (parseErr) {
            throw new Error(`Could not parse arbitration ruling: ${rawText.slice(0, 200)}`);
        }

        // Sanitise the ruling before anything touches the chain
        ruling.workerPct = Math.max(0, Math.min(100, parseInt(ruling.workerPct)));
        if (isNaN(ruling.workerPct)) throw new Error('Arbitration returned an invalid workerPct');
        ruling.posterPct = 100 - ruling.workerPct;
        if (!ruling.ruling || typeof ruling.ruling !== 'string') {
            ruling.ruling = `Ruling: ${ruling.workerPct}% worker / ${ruling.posterPct}% poster.`;
        }
        ruling.keyFindings  = Array.isArray(ruling.keyFindings)  ? ruling.keyFindings  : [];
        ruling.warningFlags = Array.isArray(ruling.warningFlags) ? ruling.warningFlags : [];
        ruling.confidence   = ruling.confidence || 'unknown';

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

        // ── Execute on-chain ──────────────────────────────────────────────
        const provider  = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
        const opsWallet = new ethers.Wallet(process.env.OPERATIONS_PRIVATE_KEY, provider);

        const workerWins = ruling.workerPct >= EQUITY_TRANSFER_THRESHOLD;
        let equityTxHash = null;
        let escrowTxHash = null;

        // ── Equity leg (equity-only AND mixed bounties) ───────────────────
        if (hasEquity) {
            const equityContract = new ethers.Contract(EQUITY_REGISTRY_ADDRESS, EQUITY_ABI, opsWallet);
            const companyIdBytes = toBytes32(project.companyId);
            const bountyIdBytes  = toBytes32(projectId);
            const reservation    = await equityContract.reservations(companyIdBytes, bountyIdBytes);

            if (!reservation.active) {
                console.warn(`⚠️ ${projectId}: equity reservation not active — skipping equity leg`);
            } else {
                const eqTx = workerWins
                    ? await equityContract.completeReservation(companyIdBytes, bountyIdBytes, PLATFORM_WALLET, PLATFORM_FEE_BPS)
                    : await equityContract.releaseReservation(companyIdBytes, bountyIdBytes);
                await eqTx.wait();
                equityTxHash = eqTx.hash;
                console.log(`✅ Equity leg resolved (${workerWins ? 'transferred to builder' : 'released to founder'}). Tx: ${eqTx.hash}`);
            }
        }

        // ── USDC leg (cash-only AND mixed bounties) ───────────────────────
        if (!isEquityOnly) {
            const escrowContract = new ethers.Contract(ESCROW_CONTRACT_ADDRESS, ESCROW_ABI, opsWallet);
            const escrowId       = await escrowContract.projectToEscrow(toBytes32(projectId));

            if (escrowId === ZERO_BYTES32) {
                if (!hasEquity) throw new Error('No escrow found for this project');
                console.warn(`⚠️ ${projectId}: no USDC escrow found — equity leg only`);
            } else {
                const escTx = await escrowContract.resolveDispute(
                    escrowId,
                    ruling.workerPct,
                    ruling.posterPct,
                    ruling.ruling,
                    await gasOverrides(provider)

                );
                await escTx.wait();
                escrowTxHash = escTx.hash;
                console.log(`✅ USDC leg resolved. Tx: ${escTx.hash}`);
            }
        }

        if (!equityTxHash && !escrowTxHash) {
            throw new Error('Nothing to resolve — no active escrow or equity reservation found');
        }

        await db.collection('subprojects').doc(projectId).update({
            status:              'completed',
            disputeResolved:     true,
            disputeProcessing:   false,
            disputeResolveTx:    escrowTxHash || equityTxHash,
            disputeEquityTx:     equityTxHash,
            disputeEscrowTx:     escrowTxHash,
            disputeResolvedAt:   new Date(),
            completedAt:         new Date(),
            ...(equityTxHash && workerWins ? {
                equityTransferred:      true,
                equityTransferTxHash:   equityTxHash,
                equityUnitsTransferred: project.equityUnits || 0
            } : {})
        });

        // ── Notify both parties ───────────────────────────────────────────
        const parts = [];
        if (escrowTxHash) {
            parts.push(`USDC split ${ruling.workerPct}% builder / ${ruling.posterPct}% poster`);
        }
        if (equityTxHash) {
            parts.push(workerWins ? 'equity transferred to builder' : 'equity returned to founder');
        }
        const outcome = parts.join(' · ');

        const workerMsg = `⚖️ Dispute resolved on "${project.title}". Outcome: ${outcome}. Ruling: ${ruling.ruling}`;
        const posterMsg = `⚖️ Dispute resolved on "${project.title}". Outcome: ${outcome}. Ruling: ${ruling.ruling}`;

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
            equityTxHash,
            escrowTxHash,
            txHash:      escrowTxHash || equityTxHash,
            arbiscanUrl: `https://arbiscan.io/tx/${escrowTxHash || equityTxHash}`
        });

    } catch(e) {
        console.error('resolve-dispute error:', e);
        await db.collection('subprojects').doc(projectId)
            .update({ disputeProcessing: false, disputeLastError: e.message })
            .catch(() => {});

        const msg = e.message || '';
        if (msg.includes('UNPREDICTABLE_GAS_LIMIT') ||
            msg.includes('insufficient funds') ||
            msg.includes('gas required exceeds allowance')) {
            return res.status(500).json({ error: 'PLATFORM_GAS_ERROR' });
        }
        return res.status(500).json({ error: e.message });
    }
}

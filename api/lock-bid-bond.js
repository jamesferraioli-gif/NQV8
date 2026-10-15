// api/lock-bid-bond.js
//
// Locks a builder's bid bond on NQVateStakingV2.
//
// lockBond is onlyOwner, so this has to run server-side with the ops key —
// the browser cannot call it. That makes this endpoint the thing standing
// between a bidder and somebody else's staked NQV8, hence the checks below.
//
// WHY A SIGNATURE: a Firebase token proves who the USER is, not which wallet
// they control, and the user document does not record one. Without proof of
// control, any signed-in user could pass a stranger's address and lock that
// stranger's stake behind a bid they never placed — a griefing attack that
// costs the attacker nothing. So the bidder signs a message naming the
// project and their wallet, and the address is recovered from it rather than
// taken on trust.
//
// WHY THE AMOUNT IS NOT A PARAMETER: it is read from the project document,
// where it was frozen at posting time. A client-supplied amount would let a
// bidder post a 1 NQV8 bond on a $50,000 bounty.

export const config = { maxDuration: 60 };

import { ethers } from 'ethers';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { verifyCaller } from './_auth.js';
import { gasOverrides } from './_gas.js';

const STAKING_ADDRESS = '0x6360074371a645c2E394a8d3B18d96aFB6C4ed7c';
const ARBITRUM_RPC    = 'https://arb1.arbitrum.io/rpc';

/// How long a signed request stays valid. Long enough to cover a slow stake
/// transaction in the same flow, short enough that a leaked signature is not
/// a standing authorisation.
const SIG_MAX_AGE_MS = 15 * 60 * 1000;

/// Grace beyond the bounty's own target before an undecided bid auto-frees.
const BID_EXPIRY_GRACE_DAYS = 14;

const BOND_KIND_BID = 1;

const STAKING_ABI = [
    "function lockBond(bytes32 bondId, address holder, uint256 amount, bytes32 ref, uint8 kind, uint64 expiresAt) external",
    "function getBond(bytes32 bondId) external view returns (tuple(address holder, uint256 amount, bytes32 ref, uint8 kind, uint8 status, uint64 createdAt, uint64 expiresAt))",
    "function availableToUnstake(address user) external view returns (uint256)",
    "function paused() external view returns (bool)"
];

const TIMEFRAME_DAYS = {
    '1day': 1, '3days': 3, '1week': 7, '2weeks': 14,
    '1month': 30, '2months': 60, '3months': 90
};

function getAdminDb() {
    if (!getApps().length) {
        initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    }
    return getFirestore();
}

/// Must match bidBondId() in index.html — a mismatch would lock a bond the
/// frontend can never find again.
function bidBondId(projectId, holder) {
    return ethers.utils.solidityKeccak256(
        ['string', 'address', 'uint8'],
        [projectId, holder, BOND_KIND_BID]
    );
}

/// Must match bidBondMessage() in index.html, byte for byte, or recovery
/// yields a different address and every bid fails.
function bidBondMessage(projectId, holder, issuedAt) {
    return [
        'NQVate bid bond authorisation',
        `Project: ${projectId}`,
        `Wallet: ${holder.toLowerCase()}`,
        `Issued: ${issuedAt}`,
        '',
        'Signing this does not move funds. It proves you control this wallet',
        'so NQVate can lock your bid bond against it.'
    ].join('\n');
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const caller = await verifyCaller(req);
    if (!caller) return res.status(401).json({ error: 'Unauthorized' });

    const { projectId, holder, issuedAt, signature } = req.body || {};
    if (!projectId || !holder || !issuedAt || !signature) {
        return res.status(400).json({ error: 'Missing projectId, holder, issuedAt or signature' });
    }
    if (!ethers.utils.isAddress(holder)) {
        return res.status(400).json({ error: 'Invalid wallet address' });
    }

    // ── 1. The signature must be fresh ────────────────────────────────────
    const issuedMs = Date.parse(issuedAt);
    if (!Number.isFinite(issuedMs)) {
        return res.status(400).json({ error: 'Invalid issuedAt' });
    }
    const age = Date.now() - issuedMs;
    if (age > SIG_MAX_AGE_MS || age < -60_000) {
        return res.status(400).json({ error: 'Authorisation expired — please place the bid again' });
    }

    // ── 2. …and must actually come from the wallet being bonded ───────────
    let recovered;
    try {
        recovered = ethers.utils.verifyMessage(bidBondMessage(projectId, holder, issuedAt), signature);
    } catch (e) {
        return res.status(400).json({ error: 'Signature could not be read' });
    }
    if (recovered.toLowerCase() !== String(holder).toLowerCase()) {
        return res.status(403).json({ error: 'Signature does not match the wallet' });
    }

    try {
        const db   = getAdminDb();
        const snap = await db.collection('subprojects').doc(projectId).get();
        if (!snap.exists) return res.status(404).json({ error: 'Posting not found' });
        const project = snap.data();

        // ── 3. The posting must still be open to bids ─────────────────────
        if (project.bidsOpen === false || project.status === 'in-progress') {
            return res.status(409).json({ error: 'This posting is no longer accepting bids' });
        }
        if (project.posterUid === caller.uid || project.ownerUid === caller.uid) {
            return res.status(403).json({ error: 'You cannot bid on your own posting' });
        }

        // ── 4. The amount comes from the posting, never the caller ────────
        const bondNQV8 = Number(project.bondNQV8);
        if (!Number.isFinite(bondNQV8) || bondNQV8 <= 0) {
            return res.status(409).json({
                error: 'This posting has no bond requirement recorded, so a bid bond cannot be locked'
            });
        }
        const amountWei = ethers.utils.parseUnits(String(bondNQV8), 18);

        const provider = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
        const wallet   = new ethers.Wallet(process.env.OPERATIONS_PRIVATE_KEY, provider);
        const staking  = new ethers.Contract(STAKING_ADDRESS, STAKING_ABI, wallet);

        const bondId = bidBondId(projectId, holder);

        // ── 5. Idempotent: a retry must not revert or double-lock ─────────
        const existing = await staking.getBond(bondId);
        if (existing.status === 1) {
            return res.status(200).json({
                success: true, alreadyLocked: true, bondId,
                amount: ethers.utils.formatUnits(existing.amount, 18)
            });
        }
        if (existing.status === 2 || existing.status === 3) {
            return res.status(409).json({
                error: 'A bond for this posting and wallet has already been settled'
            });
        }

        if (await staking.paused()) {
            return res.status(503).json({ error: 'Staking is paused — bids are temporarily unavailable' });
        }

        // ── 6. Pre-flight the revert so the bidder gets a usable message ──
        const free = await staking.availableToUnstake(holder);
        if (free.lt(amountWei)) {
            return res.status(409).json({
                error: 'Not enough free staked NQV8 to cover the bond',
                required:  ethers.utils.formatUnits(amountWei, 18),
                available: ethers.utils.formatUnits(free, 18)
            });
        }

        // ── 7. Expiry, so an undecided founder cannot strand the capital ──
        const days      = TIMEFRAME_DAYS[project.targetTimeframe] || 7;
        const expiresAt = Math.floor(Date.now() / 1000) + (days + BID_EXPIRY_GRACE_DAYS) * 86400;

        const tx = await staking.lockBond(
            bondId,
            holder,
            amountWei,
            ethers.utils.id(projectId),
            BOND_KIND_BID,
            expiresAt,
            await gasOverrides(provider)
        );
        const receipt = await tx.wait();
        if (!receipt || receipt.status === 0) throw new Error('lockBond reverted');

        return res.status(200).json({
            success:   true,
            bondId,
            amount:    String(bondNQV8),
            expiresAt,
            txHash:    tx.hash
        });

    } catch (e) {
        console.error('lock-bid-bond failed:', e);
        return res.status(500).json({ error: e.message });
    }
}

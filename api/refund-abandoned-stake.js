// api/refund-abandoned-stake.js
//
// Give back NQV8 someone staked for a bid they then didn't place.
//
// The bid flow stakes before it bonds, because you cannot bond stake that
// does not exist yet. A bidder who stops at the signature or the fee is left
// holding ordinary stake with a 30-day exit — punished for hesitating, at the
// last step of the funnel. That is the wrong answer and this undoes it.
//
// HOW: there is no "grant credit" function, by design. But a bond locked with
// creditOnRelease set and released immediately produces exactly the right
// state — releasedCredit rises, withdrawReleased() pays out, no cooldown.
// Two ops transactions and the carve-out used precisely as intended.
//
// WHY IT IS NOT A COOLDOWN BYPASS: credit is capped at the amount verified as
// staked in the last 30 minutes, one claim per transaction. A wallet with
// 100,000 of old reward stake can stake 100,000 more, refund it, and withdraw
// 100,000 — ending exactly where it began. To escape the cooldown it would
// have to withdraw more than it just added, and the cap forbids that.

export const config = { maxDuration: 60 };

import { ethers } from 'ethers';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { verifyCaller } from './_auth.js';
import { gasOverrides } from './_gas.js';

const STAKING_ADDRESS = '0x5d430f7Faae867E0A8a02EcCcbE21eF40628937c';
const ARBITRUM_RPC    = 'https://arb1.arbitrum.io/rpc';

/// keccak256("stake(uint256)")[0:4]
const STAKE_SELECTOR = '0xa694fc3a';

/// Same window as lock-bid-bond's STAKE_MAX_AGE_MS. Beyond it, a stake is
/// indistinguishable from reward stake and must serve the ordinary cooldown.
const STAKE_MAX_AGE_MS = 30 * 60 * 1000;

const SIG_MAX_AGE_MS = 15 * 60 * 1000;

/// Its own bond kind, so these never collide with a real bid bond and are
/// obvious in the event log.
const BOND_KIND_REFUND = 5;

const STAKING_ABI = [
    "function lockBond(bytes32 bondId, address holder, uint256 amount, bytes32 ref, uint8 kind, uint64 expiresAt, uint256 creditOnRelease) external",
    "function releaseBond(bytes32 bondId) external",
    "function getBond(bytes32 bondId) external view returns (tuple(address holder, uint256 amount, bytes32 ref, uint8 kind, uint8 status, uint64 createdAt, uint64 expiresAt, uint256 creditOnRelease))",
    "function availableToUnstake(address user) external view returns (uint256)",
    "function withdrawableNow(address user) external view returns (uint256)",
    "function paused() external view returns (bool)"
];

function getAdminDb() {
    if (!getApps().length) {
        initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    }
    return getFirestore();
}

/// Must match refundStakeMessage() in index.html, byte for byte.
function refundStakeMessage(stakeTxHash, holder, issuedAt) {
    return [
        'NQVate abandoned stake refund',
        `Stake: ${String(stakeTxHash).toLowerCase()}`,
        `Wallet: ${String(holder).toLowerCase()}`,
        `Issued: ${issuedAt}`,
        '',
        'Signing this does not move funds. It proves you control this wallet',
        'so NQVate can make your unused bid stake withdrawable again.'
    ].join('\n');
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const caller = await verifyCaller(req);
    if (!caller) return res.status(401).json({ error: 'Unauthorized' });

    const { stakeTxHash, holder, issuedAt, signature } = req.body || {};
    if (!stakeTxHash || !holder || !issuedAt || !signature) {
        return res.status(400).json({ error: 'Missing stakeTxHash, holder, issuedAt or signature' });
    }
    if (!ethers.utils.isAddress(holder)) return res.status(400).json({ error: 'Invalid wallet address' });
    if (!/^0x[0-9a-fA-F]{64}$/.test(stakeTxHash)) return res.status(400).json({ error: 'Invalid transaction hash' });

    // ── Signature: fresh, and from the wallet being refunded ──────────────
    // This is in the holder's favour, so the risk is not theft — it is that
    // someone else burns their one-time claim on this stake transaction and
    // denies them the credit on a real bid.
    const issuedMs = Date.parse(issuedAt);
    if (!Number.isFinite(issuedMs)) return res.status(400).json({ error: 'Invalid issuedAt' });
    const age = Date.now() - issuedMs;
    if (age > SIG_MAX_AGE_MS || age < -60_000) {
        return res.status(400).json({ error: 'Authorisation expired — please try again' });
    }

    let recovered;
    try {
        recovered = ethers.utils.verifyMessage(refundStakeMessage(stakeTxHash, holder, issuedAt), signature);
    } catch (e) {
        return res.status(400).json({ error: 'Signature could not be read' });
    }
    if (recovered.toLowerCase() !== String(holder).toLowerCase()) {
        return res.status(403).json({ error: 'Signature does not match the wallet' });
    }

    try {
        const db       = getAdminDb();
        const provider = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
        const wallet   = new ethers.Wallet(process.env.OPERATIONS_PRIVATE_KEY, provider);
        const staking  = new ethers.Contract(STAKING_ADDRESS, STAKING_ABI, wallet);

        // ── The stake must be real, recent, theirs, and unclaimed ─────────
        const [tx, receipt] = await Promise.all([
            provider.getTransaction(stakeTxHash),
            provider.getTransactionReceipt(stakeTxHash)
        ]);
        if (!tx || !receipt || receipt.status !== 1) {
            return res.status(400).json({ error: 'That transaction did not succeed' });
        }
        if (!tx.to || tx.to.toLowerCase() !== STAKING_ADDRESS.toLowerCase()) {
            return res.status(400).json({ error: 'That transaction was not a stake on the current contract' });
        }
        if (tx.from.toLowerCase() !== String(holder).toLowerCase()) {
            return res.status(403).json({ error: 'That stake was made by a different wallet' });
        }
        if (!tx.data || !tx.data.toLowerCase().startsWith(STAKE_SELECTOR)) {
            return res.status(400).json({ error: 'That transaction was not a stake' });
        }

        const block = await provider.getBlock(receipt.blockNumber);
        if (!block || (Date.now() - block.timestamp * 1000) > STAKE_MAX_AGE_MS) {
            return res.status(409).json({
                error: 'That stake is more than 30 minutes old, so it now counts as ordinary stake. '
                     + 'Unstake it from the Tokenomics page — that path has the usual 30-day cooldown.'
            });
        }

        const [staked] = ethers.utils.defaultAbiCoder.decode(['uint256'], '0x' + tx.data.slice(10));
        if (staked.isZero()) return res.status(400).json({ error: 'That stake was zero' });

        // One claim per stake transaction, shared with lock-bid-bond so a
        // stake cannot both back a bid and be refunded.
        try {
            await db.collection('usedStakeTxs').doc(stakeTxHash.toLowerCase()).create({
                holder: String(holder).toLowerCase(),
                amount: staked.toString(),
                usedAt: new Date(),
                purpose: 'refund'
            });
        } catch (e) {
            return res.status(409).json({
                error: 'That stake has already been used — either for a bid, or refunded already'
            });
        }

        // ── Must still be free. A bond placed since then takes priority ───
        const free = await staking.availableToUnstake(holder);
        if (free.lt(staked)) {
            return res.status(409).json({
                error: 'That NQV8 is no longer free — it is backing a bid, or has been unstaked',
                available: ethers.utils.formatUnits(free, 18)
            });
        }
        if (await staking.paused()) {
            return res.status(503).json({ error: 'Staking is paused — try again shortly' });
        }

        // ── Lock and immediately release, which is what grants the credit ─
        const bondId = ethers.utils.solidityKeccak256(
            ['string', 'bytes32', 'address'], ['refund', stakeTxHash, holder]);

        const existing = await staking.getBond(bondId);
        if (existing.status === 0) {
            const lockTx = await staking.lockBond(
                bondId, holder, staked, ethers.utils.id('abandoned-bid-stake'),
                BOND_KIND_REFUND, 0, staked, await gasOverrides(provider));
            const r1 = await lockTx.wait();
            if (!r1 || r1.status === 0) throw new Error('lockBond reverted');
        }

        // Re-read: it may have been locked by an earlier attempt that died
        // before releasing, in which case this call finishes the job.
        const nowBond = await staking.getBond(bondId);
        if (nowBond.status === 1) {
            const relTx = await staking.releaseBond(bondId, await gasOverrides(provider));
            const r2 = await relTx.wait();
            if (!r2 || r2.status === 0) throw new Error('releaseBond reverted');
        }

        const instant = await staking.withdrawableNow(holder);
        return res.status(200).json({
            success: true,
            refunded: ethers.utils.formatUnits(staked, 18),
            withdrawableNow: ethers.utils.formatUnits(instant, 18)
        });

    } catch (e) {
        console.error('refund-abandoned-stake failed:', e);
        return res.status(500).json({ error: e.message });
    }
}

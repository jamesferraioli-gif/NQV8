// api/monthly-rewards.js
// Runs EVERY DAY via Vercel cron (0 0 * * *).
//
// Most days it only settles: it rolls the shares of wallets that had nothing
// staked into the open pool (see below). On the first run after a month ends
// it also closes that month. Running daily means a close that failed on the
// 1st is simply retried on the 2nd, and settling is never more than a day
// behind — which matters now that every bounty worker and paying member has a
// share, staked or not.
//
// It can never close a month early: the open epoch is closed only if it began
// before the current month did.
//
// Under RewardsV2 this closes the month and nothing else. It pays nobody.
//
// V1's distribute() looped over every fee payer doing up to two ERC20
// transfers each, then looped them again to delete the records — one
// transaction, unbounded. Past roughly 300 payers it stopped fitting in an
// Arbitrum block and would have failed permanently, with each later month
// compounding onto the same array.
//
// V2 freezes the epoch's weights and pools, and wallets claim their own share
// afterwards. closeEpoch() is O(1), so this cron cannot run out of gas however
// many wallets paid fees.
//
// The Firestore fee verification V1 did here is gone too: it existed as an
// audit trail against a push-based payout, and the on-chain epoch record now
// holds the same figures authoritatively.
//
// ROLLING FORFEITS FORWARD (RewardsV4)
//
// A wallet's uncollected share only moves into the next pool when its claim is
// settled. A wallet that covered part of its slice settles itself by claiming.
// A wallet that had nothing staked has nothing to collect, so nobody ever
// settles it and its share would sit in the old month for two years.
//
// So after closing a month this job settles the wallets whose payout is zero.
// claimFor() is open to anyone and pays such a wallet nothing; all it does is
// release the share into the open pool. Wallets with something to collect are
// never touched here; that claim is theirs to make.
//
// Settling is best-effort and separate from closing: a month that closed is
// reported as closed even if settling ran out of time, and whatever is left is
// picked up on the next run.

export const config = { maxDuration: 300 };

import { ethers } from 'ethers';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { gasOverrides } from './_gas.js';

function getAdminDb() {
    if (!getApps().length) {
        initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    }
    return getFirestore();
}

import { REWARDS_ADDRESS as REWARDS_CONTRACT_ADDRESS, REWARDS_DEPLOY_BLOCK, ARBITRUM_RPC } from './_rewards.js';
const NQV8_DECIMALS            = 18;

// Ceiling on settlements per run, so a busy month cannot run the function out
// of time. The remainder is flagged and handled next run.
const MAX_SETTLE_PER_RUN       = 60;

// eth_getLogs window. Halved on failure, because public RPCs cap the range
// and the cap is not published.
const LOG_CHUNK_BLOCKS         = 500000;
const LOG_CHUNK_FLOOR          = 5000;
const USDC_DECIMALS            = 6;

const REWARDS_ABI = [
    "function closeEpoch(string label) external",
    "function currentEpoch() external view returns (uint256)",
    "function getCurrentMonthStats() external view returns (uint256 feePayerCount, uint256 nqv8FeesCollected, uint256 usdcFeesCollected, uint256 nqv8Pool, uint256 usdcPool, uint256 lastDistribution)",
    "function getEpochByLabel(string label) external view returns (uint256 epochId, tuple(uint64 startedAt, uint64 endedAt, uint256 totalNQV8Fees, uint256 totalUSDCFees, uint256 nqv8Pool, uint256 usdcPool, uint256 nqv8Claimed, uint256 usdcClaimed, uint32 payerCount, uint32 claimantCount, bool closed, bool swept, string label) epoch)",
    "event EpochClosed(uint256 indexed epochId, string label, uint256 nqv8Pool, uint256 usdcPool, uint256 totalNQV8Fees, uint32 payers)",
    "event FeesReceived(address indexed payer, uint256 nqv8Amount, uint256 nqv8ToOps, uint256 nqv8ToPool)",
    "event USDCFeeCredited(address indexed wallet, uint256 usdcAmount, uint256 weight)",
    "function getEpoch(uint256 epochId) external view returns (tuple(uint64 startedAt, uint64 endedAt, uint256 totalNQV8Fees, uint256 totalUSDCFees, uint256 nqv8Pool, uint256 usdcPool, uint256 nqv8Claimed, uint256 usdcClaimed, uint32 payerCount, uint32 claimantCount, bool closed, bool swept, string label))",
    "function claimFor(uint256 epochId, address wallet) external",
    "function claimStatus(uint256 epochId, address wallet) external view returns (tuple(bool closed, bool settled, bool open, uint256 nqv8Paid, uint256 nqv8FullShare, uint256 usdcFullShare, uint256 stakeSlice, uint256 coverageBps, uint256 nqv8Payout, uint256 usdcPayout))"
];

/**
 * Every wallet that earned weight between two blocks: paid an NQV8 fee, or
 * was credited with a USDC one.
 *
 * Read from the logs because the contract deliberately keeps no list of
 * payers. The range can be a little wider than the month without harm:
 * claimStatus() decides who actually has a share in it.
 */
async function payersBetween(rewards, fromBlock, toBlock) {
    const paid     = rewards.filters.FeesReceived();
    const credited = rewards.filters.USDCFeeCredited();
    const payers = new Set();
    let start = fromBlock;
    let step  = LOG_CHUNK_BLOCKS;

    while (start <= toBlock) {
        const end = Math.min(start + step - 1, toBlock);
        try {
            const [a, b] = await Promise.all([
                rewards.queryFilter(paid, start, end), rewards.queryFilter(credited, start, end)]);
            for (const l of a) payers.add(l.args.payer.toLowerCase());
            for (const l of b) payers.add(l.args.wallet.toLowerCase());
            start = end + 1;
        } catch (e) {
            if (step <= LOG_CHUNK_FLOOR) throw e;
            step = Math.max(LOG_CHUNK_FLOOR, Math.floor(step / 2));
        }
    }
    return [...payers];
}

/**
 * Settle the wallets in one closed epoch that have a share but a payout of
 * zero, releasing those shares into the open pool.
 *
 * Returns how many were settled and whether any are left for the next run.
 * One failed wallet does not stop the rest.
 */
async function settleZeroCoverage(rewards, provider, epochId, fromBlock, toBlock, budget) {
    const payers = await payersBetween(rewards, fromBlock, toBlock);
    let settled = 0, failed = 0, skippedForBudget = 0;

    for (const wallet of payers) {
        const s = await rewards.claimStatus(epochId, wallet);
        const hasShare  = s.nqv8Paid.gt(0) && s.open && !s.settled;
        const zeroPayout = s.nqv8Payout.isZero() && s.usdcPayout.isZero();
        if (!hasShare || !zeroPayout) continue;

        if (settled >= budget) { skippedForBudget++; continue; }

        try {
            const tx = await rewards.claimFor(epochId, wallet, await gasOverrides(provider));
            const r  = await tx.wait();
            if (!r || r.status === 0) throw new Error('claimFor reverted');
            settled++;
        } catch (e) {
            failed++;
            console.warn(`settle failed for ${wallet} in epoch ${epochId}:`, e.message);
        }
    }
    return { settled, pending: failed > 0 || skippedForBudget > 0, payersSeen: payers.length };
}

/**
 * Finish any month whose zero-payout wallets were not all settled last time.
 * Never throws: this must not stand between the job and closing the month.
 */
async function settlePendingEpochs(db, rewards, provider, budget) {
    const out = [];
    try {
        const snap = await db.collection('rewardEpochs')
            .where('rewardsContract', '==', REWARDS_CONTRACT_ADDRESS)
            .where('zeroSettlePending', '==', true)
            .get();

        for (const doc of snap.docs) {
            const d = doc.data();
            if (budget <= 0) break;
            if (d.epochId == null || d.fromBlock == null || d.closeBlock == null) continue;
            const r = await settleZeroCoverage(
                rewards, provider, Number(d.epochId), d.fromBlock, d.closeBlock, budget);
            budget -= r.settled;
            await doc.ref.set({
                zeroSettlePending: r.pending,
                zeroSettled: (d.zeroSettled || 0) + r.settled,
                zeroSettleLastRun: new Date()
            }, { merge: true });
            out.push({ month: d.month, settled: r.settled, pending: r.pending });
        }
    } catch (e) {
        console.warn('settlePendingEpochs failed:', e.message);
    }
    return { results: out, budgetLeft: budget };
}

export default async function handler(req, res) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}` &&
        authHeader !== `Bearer ${process.env.INTERNAL_API_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const provider = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
        const wallet   = new ethers.Wallet(process.env.OPERATIONS_PRIVATE_KEY, provider);
        const rewards  = new ethers.Contract(REWARDS_CONTRACT_ADDRESS, REWARDS_ABI, wallet);
        const db       = getAdminDb();

        // ── 1. Label the month that just ended ────────────────────────────
        const now      = new Date();
        const last     = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
        const monthStr = `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, '0')}`;

        console.log(`📅 Closing reward epoch for ${monthStr}`);

        // Before anything can return early: finish settling earlier months,
        // so their forfeits are in the pool this run is about to close.
        const pendingRun = await settlePendingEpochs(db, rewards, provider, MAX_SETTLE_PER_RUN);
        if (pendingRun.results.length) console.log('♻️ settled from earlier months:', JSON.stringify(pendingRun.results));

        // ── 2. Already closed? closeEpoch rejects a reused label, but check
        //       first so a re-run is a clean no-op rather than a revert. ────
        try {
            const [existingId, existing] = await rewards.getEpochByLabel(monthStr);
            if (existing.closed) {
                console.log(`⏭ ${monthStr} already closed as epoch ${existingId}`);
                return res.json({
                    success: true, skipped: true, reason: 'already closed',
                    month: monthStr, epochId: existingId.toString(),
                    settledFromEarlierMonths: pendingRun.results
                });
            }
        } catch (e) {
            // "Unknown label" is the expected path — the month is not closed yet.
        }

        // ── 2b. Has the month actually ended for the open epoch? ──────────
        // This job runs daily. The open epoch is closed only if it began
        // before the current month did; otherwise it IS the current month
        // and today is just a settling day.
        const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000;
        const openEpoch  = await rewards.getEpoch(await rewards.currentEpoch());
        if (Number(openEpoch.startedAt) >= monthStart) {
            return res.json({
                success: true, skipped: true, reason: 'month still open', month: monthStr,
                settledFromEarlierMonths: pendingRun.results
            });
        }

        // ── 3. What is about to be frozen ─────────────────────────────────
        const stats = await rewards.getCurrentMonthStats();
        const payerCount = stats[0].toNumber();
        const nqv8Fees   = stats[1];
        const nqv8Pool   = stats[3];
        const usdcPool   = stats[4];

        console.log(`💛 ${payerCount} fee payer(s), ${ethers.utils.formatUnits(nqv8Fees, NQV8_DECIMALS)} NQV8 in fees`);
        console.log(`🏦 Pools: ${ethers.utils.formatUnits(nqv8Pool, NQV8_DECIMALS)} NQV8 / $${ethers.utils.formatUnits(usdcPool, USDC_DECIMALS)}`);

        // A month with no NQV8 fees has no weights, so nothing is claimable.
        // The contract closes it and rolls the pools forward rather than
        // stranding them — but there is no reason to spend gas on that unless
        // something was actually collected.
        if (payerCount === 0 && nqv8Pool.eq(0) && usdcPool.eq(0)) {
            console.log('⚠️ Nothing collected this month — not closing');
            return res.json({
                success: true, skipped: true, reason: 'no activity', month: monthStr,
                settledFromEarlierMonths: pendingRun.results
            });
        }

        // ── 4. Close it ───────────────────────────────────────────────────
        const tx      = await rewards.closeEpoch(monthStr, await gasOverrides(provider));
        const receipt = await tx.wait();
        if (!receipt || receipt.status === 0) throw new Error('closeEpoch reverted');

        const iface  = new ethers.utils.Interface(REWARDS_ABI);
        let epochId  = null;
        for (const log of receipt.logs) {
            try {
                const parsed = iface.parseLog(log);
                if (parsed.name === 'EpochClosed') { epochId = parsed.args.epochId.toString(); break; }
            } catch { /* not ours */ }
        }

        console.log(`✅ Epoch ${epochId} closed for ${monthStr}. Tx: ${tx.hash}`);

        // ── 4b. Where this month's fee logs start ──────────────────────────
        // They sit between the previous close and this one.
        let fromBlock = REWARDS_DEPLOY_BLOCK;
        try {
            const prev = await db.collection('rewardEpochs')
                .where('rewardsContract', '==', REWARDS_CONTRACT_ADDRESS)
                .where('epochId', '==', String(Number(epochId) - 1))
                .limit(1).get();
            if (!prev.empty && prev.docs[0].data().closeBlock) fromBlock = prev.docs[0].data().closeBlock;
        } catch (e) {
            console.warn('previous close block lookup failed, searching from deployment:', e.message);
        }

        // ── 5. Record it so the app can show the period without a chain read
        await db.collection('rewardEpochs').doc(monthStr).set({
            month:          monthStr,
            epochId:        epochId,
            closedAt:       new Date(),
            closeTxHash:    tx.hash,
            closeBlock:     receipt.blockNumber,
            fromBlock,
            rewardsContract: REWARDS_CONTRACT_ADDRESS,
            // Written as pending BEFORE settling starts. If the function is
            // cut off mid-way, the record of the close is already saved and
            // the next run knows this month still needs finishing.
            zeroSettled:       0,
            zeroSettlePending: true,
            payerCount,
            nqv8Fees:       parseFloat(ethers.utils.formatUnits(nqv8Fees, NQV8_DECIMALS)),
            nqv8Pool:       parseFloat(ethers.utils.formatUnits(nqv8Pool, NQV8_DECIMALS)),
            usdcPool:       parseFloat(ethers.utils.formatUnits(usdcPool, USDC_DECIMALS)),
            // Wallets claim from here; nothing has been paid out yet.
            claimsOpen:     true
        }, { merge: true });

        // ── 6. Roll this month's zero-payout shares into the open pool ─────
        let settle = { settled: 0, pending: true, payersSeen: 0 };
        if (epochId !== null) {
            try {
                settle = await settleZeroCoverage(
                    rewards, provider, Number(epochId), fromBlock, receipt.blockNumber,
                    pendingRun.budgetLeft);
                console.log(`♻️ ${monthStr}: settled ${settle.settled} zero-payout wallet(s) of ${settle.payersSeen} payer(s)${settle.pending ? ', more next run' : ''}`);
            } catch (e) {
                console.warn('settling failed, will retry next run:', e.message);
            }
        }
        await db.collection('rewardEpochs').doc(monthStr).set({
            zeroSettled:       settle.settled,
            zeroSettlePending: settle.pending,
            zeroSettleLastRun: new Date()
        }, { merge: true }).catch(e => console.warn('could not record settle result:', e.message));

        return res.json({
            success:     true,
            month:       monthStr,
            epochId,
            payerCount,
            nqv8Fees:    ethers.utils.formatUnits(nqv8Fees, NQV8_DECIMALS),
            nqv8Pool:    ethers.utils.formatUnits(nqv8Pool, NQV8_DECIMALS),
            usdcPool:    ethers.utils.formatUnits(usdcPool, USDC_DECIMALS),
            closeTxHash: tx.hash,
            zeroPayoutWalletsSettled: settle.settled,
            settlePending: settle.pending,
            settledFromEarlierMonths: pendingRun.results,
            note:        'Epoch closed. Wallets claim their own share; nothing was pushed.'
        });

    } catch (e) {
        console.error('monthly-rewards failed:', e);
        return res.status(500).json({ error: e.message });
    }
}

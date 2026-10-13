// api/monthly-rewards.js
// Runs on the 1st of every month via Vercel cron (0 0 1 * *)
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

const REWARDS_CONTRACT_ADDRESS = '0xBfB1301819Ea548E05Ae88611761Db3Fe5bD7C2D';
const ARBITRUM_RPC             = 'https://arb1.arbitrum.io/rpc';
const NQV8_DECIMALS            = 18;
const USDC_DECIMALS            = 6;

const REWARDS_ABI = [
    "function closeEpoch(string label) external",
    "function currentEpoch() external view returns (uint256)",
    "function getCurrentMonthStats() external view returns (uint256 feePayerCount, uint256 nqv8FeesCollected, uint256 usdcFeesCollected, uint256 nqv8Pool, uint256 usdcPool, uint256 lastDistribution)",
    "function getEpochByLabel(string label) external view returns (uint256 epochId, tuple(uint64 startedAt, uint64 endedAt, uint256 totalNQV8Fees, uint256 totalUSDCFees, uint256 nqv8Pool, uint256 usdcPool, uint256 nqv8Claimed, uint256 usdcClaimed, uint32 payerCount, uint32 claimantCount, bool closed, bool swept, string label) epoch)",
    "event EpochClosed(uint256 indexed epochId, string label, uint256 nqv8Pool, uint256 usdcPool, uint256 totalNQV8Fees, uint32 payers)"
];

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
        const last     = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const monthStr = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}`;

        console.log(`📅 Closing reward epoch for ${monthStr}`);

        // ── 2. Already closed? closeEpoch rejects a reused label, but check
        //       first so a re-run is a clean no-op rather than a revert. ────
        try {
            const [existingId, existing] = await rewards.getEpochByLabel(monthStr);
            if (existing.closed) {
                console.log(`⏭ ${monthStr} already closed as epoch ${existingId}`);
                return res.json({
                    success: true, skipped: true, reason: 'already closed',
                    month: monthStr, epochId: existingId.toString()
                });
            }
        } catch (e) {
            // "Unknown label" is the expected path — the month is not closed yet.
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
                success: true, skipped: true, reason: 'no activity', month: monthStr
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

        // ── 5. Record it so the app can show the period without a chain read
        await db.collection('rewardEpochs').doc(monthStr).set({
            month:          monthStr,
            epochId:        epochId,
            closedAt:       new Date(),
            closeTxHash:    tx.hash,
            payerCount,
            nqv8Fees:       parseFloat(ethers.utils.formatUnits(nqv8Fees, NQV8_DECIMALS)),
            nqv8Pool:       parseFloat(ethers.utils.formatUnits(nqv8Pool, NQV8_DECIMALS)),
            usdcPool:       parseFloat(ethers.utils.formatUnits(usdcPool, USDC_DECIMALS)),
            // Wallets claim from here; nothing has been paid out yet.
            claimsOpen:     true
        }, { merge: true });

        return res.json({
            success:     true,
            month:       monthStr,
            epochId,
            payerCount,
            nqv8Fees:    ethers.utils.formatUnits(nqv8Fees, NQV8_DECIMALS),
            nqv8Pool:    ethers.utils.formatUnits(nqv8Pool, NQV8_DECIMALS),
            usdcPool:    ethers.utils.formatUnits(usdcPool, USDC_DECIMALS),
            closeTxHash: tx.hash,
            note:        'Epoch closed. Wallets claim their own share; nothing was pushed.'
        });

    } catch (e) {
        console.error('monthly-rewards failed:', e);
        return res.status(500).json({ error: e.message });
    }
}

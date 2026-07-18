// api/monthly-rewards.js
// Runs on the 1st of every month via Vercel cron
// 1. Calculates last month's escrow fees from on-chain events
// 2. Deposits 20% into the rewards contract
// 3. Calls distribute() to pay out NQV8 + USDC rewards to fee payers
// 4. Reads RewardPaid events and writes per-wallet records to Firestore

import { ethers } from 'ethers';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function getAdminDb() {
    if (!getApps().length) {
        const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        initializeApp({ credential: cert(sa) });
    }
    return getFirestore();
}

const REWARDS_CONTRACT_ADDRESS = '0x045aD6C2889ABCe6Bd8ef52D621706c44e4f1266';
const ESCROW_CONTRACT_ADDRESS  = '0x413EF7256f8099ea202d8C0fe3e620F5259c7a83';
const NQV8_ADDRESS             = '0x02b3EF81d6577507114BB26F91F1a8d0A7bB1B67';
const USDC_ADDRESS             = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const ARBITRUM_RPC             = 'https://arb1.arbitrum.io/rpc';

const REWARDS_ABI = [
    "function depositUSDCRewards(uint256 amount) external",
    "function depositNQV8Rewards(uint256 amount) external",
    "function distribute(string month) external",
    "function getCurrentMonthStats() external view returns (uint256 feePayerCount, uint256 nqv8FeesCollected, uint256 usdcFeesCollected, uint256 nqv8Pool, uint256 usdcPool, uint256 lastDistribution)",
    "function getDistributionHistory(string month) external view returns (tuple(string month, uint256 nqv8Distributed, uint256 usdcDistributed, uint256 recipientCount, uint256 timestamp, uint256 totalNQV8Fees, uint256 totalUSDCFees))",
    "function getAllDistributionMonths() external view returns (string[])",
    "function getStats() external view returns (uint256 totalNQV8Distributed, uint256 totalUSDCDistributed, uint256 totalRounds, uint256 lastDistribution, uint256 currentNQV8Pool, uint256 currentUSDCPool)",
    "event RewardsDistributed(string month, uint256 nqv8Amount, uint256 usdcAmount, uint256 recipients)",
    "event RewardPaid(address indexed recipient, uint256 nqv8Amount, uint256 usdcAmount, uint256 sharePercent)"
];

const ESCROW_ABI = [
    "event EscrowReleased(bytes32 indexed escrowId, address worker, uint256 workerAmount, uint256 platformFee)"
];

const ERC20_ABI = [
    "function approve(address spender, uint256 amount) returns (bool)",
    "function balanceOf(address owner) view returns (uint256)"
];

export default async function handler(req, res) {
    // Security — Vercel signs cron requests with CRON_SECRET
    if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const provider = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
        const wallet   = new ethers.Wallet(process.env.OPERATIONS_PRIVATE_KEY, provider);
        const db       = getAdminDb();

        const rewardsContract = new ethers.Contract(REWARDS_CONTRACT_ADDRESS, REWARDS_ABI, wallet);
        const usdcContract    = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);
        const escrowContract  = new ethers.Contract(ESCROW_CONTRACT_ADDRESS, ESCROW_ABI, provider);

        // ── 1. Determine last month's date range ──────────────────────────
        const now              = new Date();
        const thisYear         = now.getFullYear();
        const thisMonth        = now.getMonth(); // 0-indexed

        // Last month
        const lastMonthDate    = new Date(thisYear, thisMonth - 1, 1);
        const lastMonthYear    = lastMonthDate.getFullYear();
        const lastMonthIndex   = lastMonthDate.getMonth();
        const monthStr         = `${lastMonthYear}-${String(lastMonthIndex + 1).padStart(2, '0')}`;

        const firstOfLastMonth = new Date(lastMonthYear, lastMonthIndex, 1);
        const firstOfThisMonth = new Date(thisYear, thisMonth, 1);
        const lastMonthStartTs = Math.floor(firstOfLastMonth.getTime() / 1000);
        const lastMonthEndTs   = Math.floor(firstOfThisMonth.getTime() / 1000);

        console.log(`Running distribution for ${monthStr}`);
        console.log(`Period: ${firstOfLastMonth.toISOString()} → ${firstOfThisMonth.toISOString()}`);

        // ── 2. Find block range for last month ────────────────────────────
        const latestBlock = await provider.getBlockNumber();

        async function getBlockAtTimestamp(targetTs, low, high) {
            while (low <= high) {
                const mid   = Math.floor((low + high) / 2);
                const block = await provider.getBlock(mid);
                if (!block) { low = mid + 1; continue; }
                if (block.timestamp < targetTs) low = mid + 1;
                else high = mid - 1;
            }
            return low;
        }

        const fromBlock = await getBlockAtTimestamp(lastMonthStartTs, 0, latestBlock);
        const toBlock   = await getBlockAtTimestamp(lastMonthEndTs, fromBlock, latestBlock);

        console.log(`Block range: ${fromBlock} → ${toBlock}`);

        // ── 3. Sum escrow platform fees from last month ───────────────────
        const releaseFilter = escrowContract.filters.EscrowReleased();
        const events        = await escrowContract.queryFilter(releaseFilter, fromBlock, toBlock);

        let totalEscrowFeesUSDC = ethers.BigNumber.from(0);
        for (const event of events) {
            totalEscrowFeesUSDC = totalEscrowFeesUSDC.add(event.args.platformFee);
        }

        console.log(`Escrow fees last month: $${ethers.utils.formatUnits(totalEscrowFeesUSDC, 6)} USDC from ${events.length} releases`);

        // ── 4. Deposit 20% of escrow fees into USDC reward pool ──────────
        const usdcDeposit = totalEscrowFeesUSDC.mul(2000).div(10000); // 20%

        let depositTxHash = null;
        if (usdcDeposit.gt(0)) {
            const usdcBal = await usdcContract.balanceOf(wallet.address);
            if (usdcBal.gte(usdcDeposit)) {
                const approveTx = await usdcContract.approve(REWARDS_CONTRACT_ADDRESS, usdcDeposit);
                await approveTx.wait();
                const depositTx = await rewardsContract.depositUSDCRewards(usdcDeposit);
                await depositTx.wait();
                depositTxHash = depositTx.hash;
                console.log(`Deposited $${ethers.utils.formatUnits(usdcDeposit, 6)} USDC into rewards pool. Tx: ${depositTx.hash}`);
            } else {
                console.warn(`Insufficient USDC in ops wallet. Have: $${ethers.utils.formatUnits(usdcBal, 6)}, need: $${ethers.utils.formatUnits(usdcDeposit, 6)}`);
            }
        }

        // ── 5. Check if there are fee payers to distribute to ────────────
        const stats         = await rewardsContract.getCurrentMonthStats();
        const feePayerCount = stats[0].toNumber();
        const nqv8Pool      = stats[3];
        const usdcPool      = stats[4];

        console.log(`Fee payers this month: ${feePayerCount}`);
        console.log(`NQV8 reward pool: ${ethers.utils.formatUnits(nqv8Pool, 18)} NQV8`);
        console.log(`USDC reward pool: $${ethers.utils.formatUnits(usdcPool, 6)} USDC`);

        if (feePayerCount === 0) {
            console.log('No fee payers this month — skipping distribution');
            return res.json({
                success: true,
                skipped: true,
                reason:  'no fee payers',
                month:   monthStr,
                escrowFeesUSDC:    ethers.utils.formatUnits(totalEscrowFeesUSDC, 6),
                usdcDepositTxHash: depositTxHash
            });
        }

        if (nqv8Pool.eq(0) && usdcPool.eq(0)) {
            console.log('Reward pools empty — skipping distribution');
            return res.json({
                success: true,
                skipped: true,
                reason:  'empty pools',
                month:   monthStr
            });
        }

        // ── 6. Run distribution ───────────────────────────────────────────
        const distributeTx = await rewardsContract.distribute(monthStr);
        const receipt      = await distributeTx.wait();

        console.log(`✅ Distribution complete for ${monthStr}. Tx: ${distributeTx.hash}`);

        // ── 7. Read RewardPaid events and write per-wallet Firestore records
        const rewardsIface   = new ethers.utils.Interface(REWARDS_ABI);
        const rewardPaidLogs = receipt.logs.filter(log => {
            try {
                const parsed = rewardsIface.parseLog(log);
                return parsed.name === 'RewardPaid';
            } catch { return false; }
        });

        console.log(`Writing ${rewardPaidLogs.length} per-wallet reward records to Firestore...`);

        if (rewardPaidLogs.length > 0) {
            // Look up UIDs by wallet address
            const walletAddresses = rewardPaidLogs.map(log => {
                const parsed = rewardsIface.parseLog(log);
                return parsed.args.recipient.toLowerCase();
            });

            const userSnaps = await Promise.all(
                walletAddresses.map(addr =>
                    db.collection('users').where('walletAddress', '==', addr).limit(1).get()
                )
            );

            const walletToUid = {};
            userSnaps.forEach((snap, i) => {
                if (!snap.empty) walletToUid[walletAddresses[i]] = snap.docs[0].id;
            });

            const batch = db.batch();

            for (const log of rewardPaidLogs) {
                const parsed     = rewardsIface.parseLog(log);
                const recipient  = parsed.args.recipient.toLowerCase();
                const nqv8Amount = parseFloat(ethers.utils.formatUnits(parsed.args.nqv8Amount, 18));
                const usdcAmount = parseFloat(ethers.utils.formatUnits(parsed.args.usdcAmount, 6));
                const sharePct   = parsed.args.sharePercent.toNumber() / 100;
                const uid        = walletToUid[recipient] || null;

                const docRef = db.collection('rewardDistributions').doc(`${monthStr}-${recipient}`);
                batch.set(docRef, {
                    month: monthStr,
                    walletAddress: recipient,
                    uid,
                    nqv8Amount,
                    usdcAmount,
                    sharePercent: sharePct,
                    txHash: distributeTx.hash,
                    distributedAt: new Date()
                });

                console.log(`  ${recipient}: ${nqv8Amount} NQV8 + $${usdcAmount} USDC (${sharePct}% share)`);
            }

            await batch.commit();
            console.log(`✅ Wrote ${rewardPaidLogs.length} reward records to Firestore`);
        }

        return res.json({
            success:             true,
            month:               monthStr,
            feePayerCount,
            escrowFeesUSDC:      ethers.utils.formatUnits(totalEscrowFeesUSDC, 6),
            usdcDeposited:       ethers.utils.formatUnits(usdcDeposit, 6),
            nqv8PoolDistributed: ethers.utils.formatUnits(nqv8Pool, 18),
            usdcPoolDistributed: ethers.utils.formatUnits(usdcPool, 6),
            recipientsRecorded:  rewardPaidLogs.length,
            depositTxHash,
            distributeTxHash:    distributeTx.hash
        });

    } catch(e) {
        console.error('Monthly rewards failed:', e);
        return res.status(500).json({ error: e.message });
    }
}

// api/monthly-rewards.js
// Runs on the 1st of every month via Vercel cron (0 0 1 * *)
// 1. Reads last month's NQV8 fees from on-chain Transfer events to Operations wallet
// 2. Deposits 20% of NQV8 fees into rewards contract
// 3. Reads last month's USDC escrow fees from on-chain EscrowReleased events
// 4. Deposits 20% of USDC fees into rewards contract
// 5. Calls distribute() to pay out rewards to fee payers
// 6. Writes per-wallet distribution records to Firestore

import { ethers } from 'ethers';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function getAdminDb() {
    if (!getApps().length) {
        initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    }
    return getFirestore();
}

const OPERATIONS_WALLET        = '0x2c6309Ed2e36222E7e0Ce3c1376941A0D6340F4D';
const REWARDS_CONTRACT_ADDRESS = '0x045aD6C2889ABCe6Bd8ef52D621706c44e4f1266';
const ESCROW_CONTRACT_ADDRESS  = '0xE484561B8D1c4274853CDE01d397294CBa5dEaCa'; // V2
const NQV8_ADDRESS             = '0x02b3EF81d6577507114BB26F91F1a8d0A7bB1B67';
const USDC_ADDRESS             = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const ARBITRUM_RPC             = 'https://arb1.arbitrum.io/rpc';
const NQV8_DECIMALS            = 18;
const USDC_DECIMALS            = 6;
const REWARD_PCT               = 2000; // 20% in basis points

const REWARDS_ABI = [
    "function depositUSDCRewards(uint256 amount) external",
    "function depositNQV8Rewards(uint256 amount) external",
    "function distribute(string month) external",
    "function getCurrentMonthStats() external view returns (uint256 feePayerCount, uint256 nqv8FeesCollected, uint256 usdcFeesCollected, uint256 nqv8Pool, uint256 usdcPool, uint256 lastDistribution)",
    "function getStats() external view returns (uint256 totalNQV8Distributed, uint256 totalUSDCDistributed, uint256 totalRounds, uint256 lastDistribution, uint256 currentNQV8Pool, uint256 currentUSDCPool)",
    "event RewardPaid(address indexed recipient, uint256 nqv8Amount, uint256 usdcAmount, uint256 sharePercent)"
];

const ERC20_ABI = [
    "function approve(address spender, uint256 amount) returns (bool)",
    "function balanceOf(address owner) view returns (uint256)",
    "event Transfer(address indexed from, address indexed to, uint256 value)"
];

const ESCROW_ABI = [
    "event EscrowReleased(bytes32 indexed escrowId, address worker, uint256 workerAmount, uint256 platformFee)"
];

export default async function handler(req, res) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}` &&
        authHeader !== `Bearer ${process.env.INTERNAL_API_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const provider        = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
        const wallet          = new ethers.Wallet(process.env.OPERATIONS_PRIVATE_KEY, provider);
        const db              = getAdminDb();
        const rewardsContract = new ethers.Contract(REWARDS_CONTRACT_ADDRESS, REWARDS_ABI, wallet);
        const nqv8Contract    = new ethers.Contract(NQV8_ADDRESS, ERC20_ABI, wallet);
        const usdcContract    = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);
        const escrowContract  = new ethers.Contract(ESCROW_CONTRACT_ADDRESS, ESCROW_ABI, provider);

        // ── 1. Last month date range ──────────────────────────────────────
        const now             = new Date();
        const lastMonthDate   = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const monthStr        = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}`;
        const firstOfLast     = Math.floor(new Date(lastMonthDate.getFullYear(), lastMonthDate.getMonth(), 1).getTime() / 1000);
        const firstOfThis     = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);

        console.log(`📅 Distribution for ${monthStr}`);

        // ── 2. Find block range via binary search ─────────────────────────
        const latestBlock = await provider.getBlockNumber();

        async function blockAtTs(ts, lo, hi) {
            while (lo < hi) {
                const mid   = Math.floor((lo + hi) / 2);
                const block = await provider.getBlock(mid).catch(() => null);
                if (!block) { lo = mid + 1; continue; }
                if (block.timestamp < ts) lo = mid + 1;
                else hi = mid;
            }
            return lo;
        }

        const fromBlock = await blockAtTs(firstOfLast, 0, latestBlock);
        const toBlock   = await blockAtTs(firstOfThis, fromBlock, latestBlock);
        console.log(`🔍 Block range: ${fromBlock} → ${toBlock}`);

        // ── 3. Sum NQV8 fees: Transfer events TO Operations wallet ────────
        const nqv8Iface      = new ethers.utils.Interface(ERC20_ABI);
        const transferFilter = {
            address: NQV8_ADDRESS,
            topics:  [
                ethers.utils.id('Transfer(address,address,uint256)'),
                null,
                ethers.utils.hexZeroPad(OPERATIONS_WALLET.toLowerCase(), 32)
            ],
            fromBlock,
            toBlock
        };
        const nqv8Transfers = await provider.getLogs(transferFilter);
        let totalNQV8Fees = ethers.BigNumber.from(0);
        for (const log of nqv8Transfers) {
            try {
                const parsed = nqv8Iface.parseLog(log);
                totalNQV8Fees = totalNQV8Fees.add(parsed.args.value);
            } catch {}
        }
        console.log(`💛 NQV8 fees received: ${ethers.utils.formatUnits(totalNQV8Fees, NQV8_DECIMALS)} NQV8 from ${nqv8Transfers.length} transfers`);

        // ── 4. Sum USDC escrow platform fees from EscrowReleased events ───
        const releaseFilter = escrowContract.filters.EscrowReleased();
        const releaseEvents = await escrowContract.queryFilter(releaseFilter, fromBlock, toBlock);
        let totalEscrowFeesUSDC = ethers.BigNumber.from(0);
        for (const e of releaseEvents) {
            totalEscrowFeesUSDC = totalEscrowFeesUSDC.add(e.args.platformFee);
        }
        console.log(`💵 USDC escrow fees: $${ethers.utils.formatUnits(totalEscrowFeesUSDC, USDC_DECIMALS)} from ${releaseEvents.length} releases`);

        // ── 5. Deposit 20% of NQV8 fees ──────────────────────────────────
        let nqv8DepositTxHash = null;
        const nqv8Deposit = totalNQV8Fees.mul(REWARD_PCT).div(10000);
        if (nqv8Deposit.gt(0)) {
            const bal = await nqv8Contract.balanceOf(wallet.address);
            if (bal.gte(nqv8Deposit)) {
                const approveTx = await nqv8Contract.approve(REWARDS_CONTRACT_ADDRESS, nqv8Deposit);
                await approveTx.wait();
                const depositTx = await rewardsContract.depositNQV8Rewards(nqv8Deposit);
                await depositTx.wait();
                nqv8DepositTxHash = depositTx.hash;
                console.log(`✅ Deposited ${ethers.utils.formatUnits(nqv8Deposit, NQV8_DECIMALS)} NQV8 to rewards. Tx: ${depositTx.hash}`);
            } else {
                console.warn('Insufficient NQV8 in ops wallet for rewards deposit');
            }
        }

        // ── 6. Deposit 20% of USDC fees ───────────────────────────────────
        let usdcDepositTxHash = null;
        const usdcDeposit = totalEscrowFeesUSDC.mul(REWARD_PCT).div(10000);
        if (usdcDeposit.gt(0)) {
            const bal = await usdcContract.balanceOf(wallet.address);
            if (bal.gte(usdcDeposit)) {
                const approveTx = await usdcContract.approve(REWARDS_CONTRACT_ADDRESS, usdcDeposit);
                await approveTx.wait();
                const depositTx = await rewardsContract.depositUSDCRewards(usdcDeposit);
                await depositTx.wait();
                usdcDepositTxHash = depositTx.hash;
                console.log(`✅ Deposited $${ethers.utils.formatUnits(usdcDeposit, USDC_DECIMALS)} USDC to rewards. Tx: ${depositTx.hash}`);
            } else {
                console.warn('Insufficient USDC in ops wallet for rewards deposit');
            }
        }

        // ── 7. Check pools and fee payer count ────────────────────────────
        const stats         = await rewardsContract.getCurrentMonthStats();
        const feePayerCount = stats[0].toNumber();
        const nqv8Pool      = stats[3];
        const usdcPool      = stats[4];

        console.log(`👥 Fee payers: ${feePayerCount} | NQV8 pool: ${ethers.utils.formatUnits(nqv8Pool, NQV8_DECIMALS)} | USDC pool: $${ethers.utils.formatUnits(usdcPool, USDC_DECIMALS)}`);

        if (feePayerCount === 0 || (nqv8Pool.eq(0) && usdcPool.eq(0))) {
            console.log('⚠️ No fee payers or empty pools — skipping distribution');
            return res.json({
                success: true, skipped: true,
                reason: feePayerCount === 0 ? 'no fee payers' : 'empty pools',
                month: monthStr,
                nqv8FeesCollected: ethers.utils.formatUnits(totalNQV8Fees, NQV8_DECIMALS),
                escrowFeesUSDC: ethers.utils.formatUnits(totalEscrowFeesUSDC, USDC_DECIMALS),
                nqv8DepositTxHash,
                usdcDepositTxHash
            });
        }

        // ── 8. Run distribution ───────────────────────────────────────────
        const distributeTx = await rewardsContract.distribute(monthStr);
        const receipt      = await distributeTx.wait();
        console.log(`✅ Distribution complete for ${monthStr}. Tx: ${distributeTx.hash}`);

        // ── 9. Write per-wallet Firestore records ─────────────────────────
        const rewardsIface   = new ethers.utils.Interface(REWARDS_ABI);
        const rewardPaidLogs = receipt.logs.filter(log => {
            try { return rewardsIface.parseLog(log).name === 'RewardPaid'; }
            catch { return false; }
        });

        if (rewardPaidLogs.length > 0) {
            const walletAddrs = rewardPaidLogs.map(l => rewardsIface.parseLog(l).args.recipient.toLowerCase());
            const userSnaps   = await Promise.all(
                walletAddrs.map(addr => db.collection('users').where('walletAddress', '==', addr).limit(1).get())
            );
            const walletToUid = {};
            userSnaps.forEach((snap, i) => { if (!snap.empty) walletToUid[walletAddrs[i]] = snap.docs[0].id; });

            const batch = db.batch();
            for (const log of rewardPaidLogs) {
                const parsed    = rewardsIface.parseLog(log);
                const recipient = parsed.args.recipient.toLowerCase();
                const docRef    = db.collection('rewardDistributions').doc(`${monthStr}-${recipient}`);
                batch.set(docRef, {
                    month:            monthStr,
                    walletAddress:    recipient,
                    uid:              walletToUid[recipient] || null,
                    nqv8Amount:       parseFloat(ethers.utils.formatUnits(parsed.args.nqv8Amount, NQV8_DECIMALS)),
                    usdcAmount:       parseFloat(ethers.utils.formatUnits(parsed.args.usdcAmount, USDC_DECIMALS)),
                    sharePercent:     parsed.args.sharePercent.toNumber() / 100,
                    txHash:           distributeTx.hash,
                    distributedAt:    new Date(),
                    nqv8FeesTotal:    parseFloat(ethers.utils.formatUnits(totalNQV8Fees, NQV8_DECIMALS)),
                    usdcFeesTotal:    parseFloat(ethers.utils.formatUnits(totalEscrowFeesUSDC, USDC_DECIMALS))
                });
            }
            await batch.commit();
            console.log(`📝 Wrote ${rewardPaidLogs.length} distribution records to Firestore`);
        }

        return res.json({
            success:             true,
            month:               monthStr,
            feePayerCount,
            nqv8FeesCollected:   ethers.utils.formatUnits(totalNQV8Fees, NQV8_DECIMALS),
            nqv8Deposited:       ethers.utils.formatUnits(nqv8Deposit, NQV8_DECIMALS),
            escrowFeesUSDC:      ethers.utils.formatUnits(totalEscrowFeesUSDC, USDC_DECIMALS),
            usdcDeposited:       ethers.utils.formatUnits(usdcDeposit, USDC_DECIMALS),
            nqv8PoolDistributed: ethers.utils.formatUnits(nqv8Pool, NQV8_DECIMALS),
            usdcPoolDistributed: ethers.utils.formatUnits(usdcPool, USDC_DECIMALS),
            recipientsRecorded:  rewardPaidLogs.length,
            nqv8DepositTxHash,
            usdcDepositTxHash,
            distributeTxHash:    distributeTx.hash
        });

    } catch(e) {
        console.error('Monthly rewards failed:', e);
        return res.status(500).json({ error: e.message });
    }
}

// api/monthly-rewards.js
// Runs on the 1st of every month via Vercel cron
// 1. Calculates last month's escrow fees from on-chain events
// 2. Deposits 20% into the rewards contract
// 3. Calls distribute() to pay out NQV8 + USDC rewards to fee payers

import { ethers } from 'ethers';

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
    "function getStats() external view returns (uint256 totalNQV8Distributed, uint256 totalUSDCDistributed, uint256 totalRounds, uint256 lastDistribution, uint256 currentNQV8Pool, uint256 currentUSDCPool)"
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
            // platformFee is in USDC (6 decimals) for USDC escrows
            // For NQV8 escrows the fee is in NQV8 — we only count USDC fees here
            // NQV8 fees are already handled by payNQV8Fee() on the rewards contract
            totalEscrowFeesUSDC = totalEscrowFeesUSDC.add(event.args.platformFee);
        }

        console.log(`Escrow fees last month: $${ethers.utils.formatUnits(totalEscrowFeesUSDC, 6)} USDC from ${events.length} releases`);

        // ── 4. Deposit 20% of escrow fees into USDC reward pool ──────────
        const usdcDeposit = totalEscrowFeesUSDC.mul(2000).div(10000); // 20%

        let depositTxHash = null;
        if (usdcDeposit.gt(0)) {
            // Check ops wallet has enough USDC
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
        const stats        = await rewardsContract.getCurrentMonthStats();
        const feePayerCount = stats[0].toNumber();
        const nqv8Pool     = stats[3];
        const usdcPool     = stats[4];

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
                escrowFeesUSDC:   ethers.utils.formatUnits(totalEscrowFeesUSDC, 6),
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

        // ── 6. Run distribution ────────────────────────────────────────────
        const distributeTx = await rewardsContract.distribute(monthStr);
        await distributeTx.wait();

        console.log(`✅ Distribution complete for ${monthStr}. Tx: ${distributeTx.hash}`);

        return res.json({
            success:           true,
            month:             monthStr,
            feePayerCount,
            escrowFeesUSDC:    ethers.utils.formatUnits(totalEscrowFeesUSDC, 6),
            usdcDeposited:     ethers.utils.formatUnits(usdcDeposit, 6),
            nqv8PoolDistributed: ethers.utils.formatUnits(nqv8Pool, 18),
            usdcPoolDistributed: ethers.utils.formatUnits(usdcPool, 6),
            depositTxHash,
            distributeTxHash:  distributeTx.hash
        });

    } catch(e) {
        console.error('Monthly rewards failed:', e);
        return res.status(500).json({ error: e.message });
    }
}

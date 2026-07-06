// api/deposit-escrow-fee.js
// Called after each bounty escrow release to deposit the platform's
// 3.5% USDC fee from the Operations wallet into the Rewards contract pool.
// This ensures USDC fees appear in getCurrentMonthStats() and get
// distributed to NQV8 holders in the monthly rewards run.

import { ethers } from 'ethers';

const REWARDS_CONTRACT_ADDRESS = '0x045aD6C2889ABCe6Bd8ef52D621706c44e4f1266';
const USDC_ADDRESS             = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const ARBITRUM_RPC             = 'https://arb1.arbitrum.io/rpc';
const PLATFORM_FEE_BPS         = 350; // 3.5% = 350 basis points

const REWARDS_ABI = [
    "function payUSDCFee(uint256 amount) external",
    "function depositUSDCRewards(uint256 amount) external"
];

const ERC20_ABI = [
    "function approve(address spender, uint256 amount) returns (bool)",
    "function balanceOf(address owner) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)"
];

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Verify request is from our own frontend using a shared secret
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { bountyAmountUSDC, escrowTxHash, subprojectId } = req.body;

    if (!bountyAmountUSDC || bountyAmountUSDC <= 0) {
        return res.status(400).json({ error: 'Invalid bountyAmountUSDC' });
    }

    try {
        const provider = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
        const wallet   = new ethers.Wallet(process.env.OPERATIONS_PRIVATE_KEY, provider);

        const rewardsContract = new ethers.Contract(REWARDS_CONTRACT_ADDRESS, REWARDS_ABI, wallet);
        const usdcContract    = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);

        // Calculate the platform fee (3.5% of bounty amount)
        const platformFeeUSDC  = (bountyAmountUSDC * PLATFORM_FEE_BPS) / 10000;
        // USDC has 6 decimals on Arbitrum
        const platformFeeRaw   = ethers.utils.parseUnits(platformFeeUSDC.toFixed(6), 6);

        // Check Operations wallet USDC balance
        const balance = await usdcContract.balanceOf(wallet.address);
        if (balance.lt(platformFeeRaw)) {
            return res.status(400).json({
                error: 'Insufficient USDC in Operations wallet',
                required: platformFeeUSDC,
                available: ethers.utils.formatUnits(balance, 6)
            });
        }

        // Approve Rewards contract to spend USDC if needed
        const allowance = await usdcContract.allowance(wallet.address, REWARDS_CONTRACT_ADDRESS);
        if (allowance.lt(platformFeeRaw)) {
            const approveTx = await usdcContract.approve(
                REWARDS_CONTRACT_ADDRESS,
                ethers.constants.MaxUint256 // approve max so we don't need to re-approve each time
            );
            await approveTx.wait();
        }

        // Try payUSDCFee first (tracks fee payers for reward calculation)
        // Fall back to depositUSDCRewards if payUSDCFee doesn't exist
        let depositTx;
        try {
            depositTx = await rewardsContract.payUSDCFee(platformFeeRaw);
        } catch(e) {
            // payUSDCFee failed — try depositUSDCRewards
            depositTx = await rewardsContract.depositUSDCRewards(platformFeeRaw);
        }
        await depositTx.wait();

        console.log(`✅ Deposited $${platformFeeUSDC.toFixed(4)} USDC into rewards pool`);
        console.log(`   Bounty: $${bountyAmountUSDC} | Fee: 3.5% | Tx: ${depositTx.hash}`);
        console.log(`   Escrow tx: ${escrowTxHash} | Subproject: ${subprojectId}`);

        return res.status(200).json({
            success: true,
            platformFeeUSDC,
            depositTxHash: depositTx.hash,
            escrowTxHash,
            subprojectId
        });

    } catch (e) {
        console.error('deposit-escrow-fee error:', e.message);
        return res.status(500).json({ error: e.message });
    }
}

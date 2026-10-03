// api/monthly-rewards.js
// Runs on the 1st of every month via Vercel cron (0 0 1 * *)
//
// Fee verification method (same for NQV8 and USDC):
//   1. Query Firestore protocolFees for last month → get tx hashes
//   2. For each tx hash, verify on-chain (real transaction, correct amount)
//   3. Sum verified amounts → deposit 20% into rewards pool
//   4. Call distribute() → pay out to fee payers
//   5. Write per-wallet records to Firestore

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
    "event RewardPaid(address indexed recipient, uint256 nqv8Amount, uint256 usdcAmount, uint256 sharePercent)"
];

const ERC20_ABI = [
    "function approve(address spender, uint256 amount) returns (bool)",
    "function balanceOf(address owner) view returns (uint256)"
];

// Verify a fee tx on-chain — confirm it's a real transfer TO the Operations wallet
// Returns the verified amount in smallest units, or null if invalid
async function verifyFeeTx(provider, txHash, tokenAddress, decimals) {
    try {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt || receipt.status !== 1) return null; // tx failed or not found

        const transferTopic = ethers.utils.id('Transfer(address,address,uint256)');
        const opsLower      = OPERATIONS_WALLET.toLowerCase();

        for (const log of receipt.logs) {
            if (log.address.toLowerCase() !== tokenAddress.toLowerCase()) continue;
            if (log.topics[0] !== transferTopic) continue;
            const to = ethers.utils.defaultAbiCoder.decode(['address'], log.topics[2])[0].toLowerCase();
            if (to !== opsLower) continue;
            const amount = ethers.BigNumber.from(log.data);
            return amount;
        }
        return null; // no matching transfer found
    } catch(e) {
        console.warn(`Failed to verify tx ${txHash}:`, e.message);
        return null;
    }
}

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

        // ── 1. Determine last month ───────────────────────────────────────
        const now           = new Date();
        const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const monthStr      = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}`;

        console.log(`📅 Distribution for ${monthStr}`);

        // ── 2. Query Firestore for last month's fee records ───────────────
        const feesSnap = await db.collection('protocolFees')
            .where('month', '==', monthStr)
            .get();

        const nqv8Records  = [];
        const usdcRecords  = [];

        feesSnap.forEach(doc => {
            const d = doc.data();
            if (!d.txHash) return;
            if (d.currency === 'NQV8') nqv8Records.push(d);
            else usdcRecords.push(d); // default USDC
        });

        console.log(`📋 Firestore: ${nqv8Records.length} NQV8 fees, ${usdcRecords.length} USDC fees`);

        // ── 3. Verify NQV8 fees on-chain ──────────────────────────────────
        let totalNQV8Fees  = ethers.BigNumber.from(0);
        let nqv8Verified   = 0;
        let nqv8Rejected   = 0;

        for (const record of nqv8Records) {
            const amount = await verifyFeeTx(provider, record.txHash, NQV8_ADDRESS, NQV8_DECIMALS);
            if (amount) {
                totalNQV8Fees = totalNQV8Fees.add(amount);
                nqv8Verified++;
            } else {
                console.warn(`❌ NQV8 tx not verified: ${record.txHash}`);
                nqv8Rejected++;
            }
        }

        console.log(`💛 NQV8 fees verified: ${ethers.utils.formatUnits(totalNQV8Fees, NQV8_DECIMALS)} NQV8 (${nqv8Verified} verified, ${nqv8Rejected} rejected)`);

        // ── 4. Verify USDC fees on-chain ──────────────────────────────────
        let totalUSDCFees  = ethers.BigNumber.from(0);
        let usdcVerified   = 0;
        let usdcRejected   = 0;

        for (const record of usdcRecords) {
            const amount = await verifyFeeTx(provider, record.txHash, USDC_ADDRESS, USDC_DECIMALS);
            if (amount) {
                totalUSDCFees = totalUSDCFees.add(amount);
                usdcVerified++;
            } else {
                console.warn(`❌ USDC tx not verified: ${record.txHash}`);
                usdcRejected++;
            }
        }

        console.log(`💵 USDC fees verified: $${ethers.utils.formatUnits(totalUSDCFees, USDC_DECIMALS)} (${usdcVerified} verified, ${usdcRejected} rejected)`);

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
                console.log(`✅ Deposited ${ethers.utils.formatUnits(nqv8Deposit, NQV8_DECIMALS)} NQV8. Tx: ${depositTx.hash}`);
            } else {
                console.warn('Insufficient NQV8 in ops wallet');
            }
        }

        // ── 6. Deposit 20% of USDC fees ───────────────────────────────────
        let usdcDepositTxHash = null;
        const usdcDeposit = totalUSDCFees.mul(REWARD_PCT).div(10000);
        if (usdcDeposit.gt(0)) {
            const bal = await usdcContract.balanceOf(wallet.address);
            if (bal.gte(usdcDeposit)) {
                const approveTx = await usdcContract.approve(REWARDS_CONTRACT_ADDRESS, usdcDeposit);
                await approveTx.wait();
                const depositTx = await rewardsContract.depositUSDCRewards(usdcDeposit);
                await depositTx.wait();
                usdcDepositTxHash = depositTx.hash;
                console.log(`✅ Deposited $${ethers.utils.formatUnits(usdcDeposit, USDC_DECIMALS)} USDC. Tx: ${depositTx.hash}`);
            } else {
                console.warn('Insufficient USDC in ops wallet');
            }
        }

        // ── 7. Check pools ────────────────────────────────────────────────
        const stats         = await rewardsContract.getCurrentMonthStats();
        const feePayerCount = stats[0].toNumber();
        const nqv8Pool      = stats[3];
        const usdcPool      = stats[4];

        if (feePayerCount === 0 || (nqv8Pool.eq(0) && usdcPool.eq(0))) {
            console.log('⚠️ No fee payers or empty pools — skipping distribution');
            return res.json({
                success: true, skipped: true,
                reason: feePayerCount === 0 ? 'no fee payers' : 'empty pools',
                month: monthStr,
                nqv8FeesVerified: ethers.utils.formatUnits(totalNQV8Fees, NQV8_DECIMALS),
                usdcFeesVerified: ethers.utils.formatUnits(totalUSDCFees, USDC_DECIMALS),
                nqv8DepositTxHash,
                usdcDepositTxHash
            });
        }

        // ── 8. Distribute ─────────────────────────────────────────────────
        const distributeTx = await rewardsContract.distribute(monthStr);
        const receipt      = await distributeTx.wait();
        console.log(`✅ Distribution complete. Tx: ${distributeTx.hash}`);

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
                    // Audit trail
                    nqv8FeesVerified: parseFloat(ethers.utils.formatUnits(totalNQV8Fees, NQV8_DECIMALS)),
                    usdcFeesVerified: parseFloat(ethers.utils.formatUnits(totalUSDCFees, USDC_DECIMALS)),
                    nqv8TxsVerified:  nqv8Verified,
                    usdcTxsVerified:  usdcVerified
                });
            }
            await batch.commit();
            console.log(`📝 Wrote ${rewardPaidLogs.length} records to Firestore`);
        }

        return res.json({
            success:             true,
            month:               monthStr,
            feePayerCount,
            nqv8FeesVerified:    ethers.utils.formatUnits(totalNQV8Fees, NQV8_DECIMALS),
            nqv8TxsVerified:     nqv8Verified,
            nqv8TxsRejected:     nqv8Rejected,
            usdcFeesVerified:    ethers.utils.formatUnits(totalUSDCFees, USDC_DECIMALS),
            usdcTxsVerified:     usdcVerified,
            usdcTxsRejected:     usdcRejected,
            nqv8Deposited:       ethers.utils.formatUnits(nqv8Deposit, NQV8_DECIMALS),
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

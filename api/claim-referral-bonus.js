// api/claim-referral-bonus.js
// Called when a user has 5+ verified referrals and wants to claim 1,000 NQV8.
// Repeatable every 5 referrals — tracked in Firestore.
// Sends NQV8 directly from Treasury to the user's wallet via Operations wallet.

import { ethers } from 'ethers';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { credential } from 'firebase-admin';

if (!getApps().length) {
    initializeApp({
        credential: credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
}
const db = getFirestore();

const NQV8_TOKEN_ADDRESS      = '0x02b3EF81d6577507114BB26F91F1a8d0A7bB1B67';
const TREASURY_CONTRACT_ADDRESS = '0x75dB1b0a363a6994e4e502Cf201e23B1D93582D8';
const ARBITRUM_RPC            = 'https://arb1.arbitrum.io/rpc';
const BONUS_PER_TIER          = 1000;   // NQV8 per 5 referrals
const REFERRALS_PER_TIER      = 5;

const ERC20_ABI = [
    "function transfer(address to, uint256 amount) returns (bool)",
    "function balanceOf(address owner) view returns (uint256)"
];

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { uid } = req.body;
    if (!uid) return res.status(400).json({ error: 'uid required' });

    try {
        // ── 1. Fetch user ─────────────────────────────────────────────────
        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
        const user = userDoc.data();

        if (!user.walletAddress) {
            return res.status(400).json({ error: 'No wallet connected' });
        }

        // ── 2. Count verified referrals ───────────────────────────────────
        // A verified referral = referred user has claimed their signup bonus
        const referralsSnap = await db.collection('users')
            .where('referredBy', '==', uid)
            .where('signupBonusClaimed', '==', true)
            .get();

        const verifiedReferrals = referralsSnap.size;
        const bonusesClaimed    = user.referralBonusesClaimed || 0;
        const tiersEarned       = Math.floor(verifiedReferrals / REFERRALS_PER_TIER);
        const tiersAvailable    = tiersEarned - bonusesClaimed;

        if (tiersAvailable <= 0) {
            const nextTierAt = (bonusesClaimed + 1) * REFERRALS_PER_TIER;
            const needed     = nextTierAt - verifiedReferrals;
            return res.status(400).json({
                error: `No referral bonus available yet. You need ${needed} more verified referral${needed !== 1 ? 's' : ''} to earn your next bonus.`,
                verifiedReferrals,
                tiersEarned,
                bonusesClaimed,
                nextTierAt
            });
        }

        // ── 3. Check Treasury has enough NQV8 ────────────────────────────
        const provider    = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
        const opsWallet   = new ethers.Wallet(process.env.OPERATIONS_PRIVATE_KEY, provider);
        const nqv8        = new ethers.Contract(NQV8_TOKEN_ADDRESS, ERC20_ABI, opsWallet);

        const treasuryBal = await nqv8.balanceOf(TREASURY_CONTRACT_ADDRESS);
        const totalBonus  = tiersAvailable * BONUS_PER_TIER;
        const bonusRaw    = ethers.utils.parseUnits(String(totalBonus), 18);

        // Use ops wallet balance as fallback if treasury is low
        const opsBal = await nqv8.balanceOf(opsWallet.address);

        const sourceHasFunds = treasuryBal.gte(bonusRaw) || opsBal.gte(bonusRaw);
        if (!sourceHasFunds) {
            return res.status(400).json({ error: 'Referral bonus program has ended — Treasury has no remaining NQV8.' });
        }

        // ── 4. Send NQV8 to user wallet ───────────────────────────────────
        // Send from ops wallet (which holds NQV8 from treasury fees)
        const tx = await nqv8.transfer(user.walletAddress, bonusRaw);
        await tx.wait();

        // ── 5. Update Firestore ───────────────────────────────────────────
        await db.collection('users').doc(uid).update({
            referralBonusesClaimed:    bonusesClaimed + tiersAvailable,
            referralNQV8Earned:        (user.referralNQV8Earned || 0) + totalBonus,
            lastReferralBonusClaimedAt: new Date(),
            lastReferralBonusTxHash:   tx.hash,
            totalNQV8Earned:           (user.totalNQV8Earned || 0) + totalBonus
        });

        // Log the bonus
        await db.collection('referralBonuses').add({
            uid,
            walletAddress:    user.walletAddress,
            bonusAmount:      totalBonus,
            tiersAwarded:     tiersAvailable,
            verifiedReferrals,
            txHash:           tx.hash,
            claimedAt:        new Date()
        });

        console.log(`✅ Referral bonus: ${totalBonus} NQV8 sent to ${user.walletAddress} for ${uid}. Tx: ${tx.hash}`);

        return res.json({
            success:          true,
            bonusAmount:      totalBonus,
            tiersAwarded:     tiersAvailable,
            verifiedReferrals,
            txHash:           tx.hash,
            arbiscanUrl:      `https://arbiscan.io/tx/${tx.hash}`
        });

    } catch(e) {
        console.error('claim-referral-bonus error:', e);
        return res.status(500).json({ error: e.message });
    }
}

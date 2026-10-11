// api/claim-voucher.js
// Node runtime. Verifies on-chain that the caller actually paid a platform fee,
// then issues a short-lived single-use voucher the Edge endpoints can check.
//
// Why: verify-docs, verify-metrics and generate-flowmap run on Edge and cannot
// read the chain or Firestore. Without this, any logged-in user could call them
// directly and skip the fee entirely.
//
// Trust model: the on-chain FeesReceived event is the only source of truth.
// The protocolFees Firestore doc is client-written and is NOT trusted here.

import { ethers } from 'ethers';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { verifyCaller } from './_auth.js';
import { issueVoucher } from './_voucher.js';

if (!getApps().length) {
    initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
const db = getFirestore();

const REWARDS_CONTRACT_ADDRESS = '0x045aD6C2889ABCe6Bd8ef52D621706c44e4f1266';
const ARBITRUM_RPC             = 'https://arb1.arbitrum.io/rpc';
const NQV8_DECIMALS            = 18;

// USD price of each paid feature. The NQV8 amount is derived at claim time
// from the live price, so this stays correct as NQV8 moves.
const PURPOSE_PRICE_USD = {
    'verify-docs':      10.00,
    'verify-metrics':    1.00,
    'generate-flowmap':  5.00
};

// Accept slightly less than the quoted amount — the frontend quotes a price,
// the user confirms seconds later, and NQV8 may have ticked up in between.
const PRICE_TOLERANCE = 0.80;

const FEES_RECEIVED_TOPIC = ethers.utils.id('FeesReceived(address,uint256,uint256,uint256)');

async function getNQV8PriceUSD() {
    try {
        const res  = await fetch(`https://api.dexscreener.com/latest/dex/tokens/0x02b3EF81d6577507114BB26F91F1a8d0A7bB1B67`);
        const data = await res.json();
        const p    = parseFloat(data.pairs?.[0]?.priceUsd);
        if (p && p > 0) return p;
    } catch (e) { /* fall through to peg */ }
    return 0.01; // peg fallback, same as the frontend
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const caller = await verifyCaller(req);
    if (!caller) return res.status(401).json({ error: 'Unauthorized' });
    if (!caller.uid) return res.status(403).json({ error: 'A signed-in user is required' });

    const { txHash, purpose } = req.body || {};
    if (!txHash || !purpose) return res.status(400).json({ error: 'txHash and purpose are required' });
    if (!PURPOSE_PRICE_USD[purpose]) return res.status(400).json({ error: `Unknown purpose: ${purpose}` });
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return res.status(400).json({ error: 'Malformed txHash' });

    try {
        // ── 1. Single use — reserve the hash before doing anything else ───
        const voucherRef = db.collection('vouchers').doc(txHash.toLowerCase());
        const existing   = await voucherRef.get();
        if (existing.exists) {
            return res.status(409).json({
                error: 'This payment has already been used.',
                usedFor: existing.data().purpose,
                usedAt:  existing.data().claimedAt || null
            });
        }

        // ── 2. Which wallet does this user own? ───────────────────────────
        const userDoc = await db.collection('users').doc(caller.uid).get();
        const wallet  = (userDoc.data()?.walletAddress || '').toLowerCase();
        if (!wallet) return res.status(400).json({ error: 'No wallet on file for this account' });

        // ── 3. The chain is the source of truth ───────────────────────────
        const provider = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
        const receipt  = await provider.getTransactionReceipt(txHash);

        if (!receipt)                 return res.status(404).json({ error: 'Transaction not found. It may still be pending.' });
        if (receipt.status !== 1)     return res.status(400).json({ error: 'That transaction failed on-chain' });
        if (receipt.from.toLowerCase() !== wallet) {
            return res.status(403).json({ error: 'That payment was made from a different wallet' });
        }
        if ((receipt.to || '').toLowerCase() !== REWARDS_CONTRACT_ADDRESS.toLowerCase()) {
            return res.status(400).json({ error: 'That transaction is not a platform fee payment' });
        }

        // ── 4. Read the amount straight out of the FeesReceived event ─────
        const feeLog = receipt.logs.find(l =>
            l.address.toLowerCase() === REWARDS_CONTRACT_ADDRESS.toLowerCase() &&
            l.topics[0] === FEES_RECEIVED_TOPIC
        );
        if (!feeLog) return res.status(400).json({ error: 'No fee payment found in that transaction' });

        // FeesReceived(address indexed payer, uint256 nqv8Amount, uint256 toOps, uint256 toPool)
        const decoded   = ethers.utils.defaultAbiCoder.decode(['uint256','uint256','uint256'], feeLog.data);
        const paidNQV8  = parseFloat(ethers.utils.formatUnits(decoded[0], NQV8_DECIMALS));

        const price      = await getNQV8PriceUSD();
        const paidUSD    = paidNQV8 * price;
        const requiredUSD = PURPOSE_PRICE_USD[purpose] * PRICE_TOLERANCE;

        if (paidUSD < requiredUSD) {
            return res.status(402).json({
                error: `Payment too small for ${purpose}. Paid ~$${paidUSD.toFixed(2)}, required $${PURPOSE_PRICE_USD[purpose].toFixed(2)}.`
            });
        }

        // ── 5. Burn the hash, then mint the voucher ───────────────────────
        try {
            await voucherRef.create({
                txHash:     txHash.toLowerCase(),
                uid:        caller.uid,
                wallet,
                purpose,
                paidNQV8,
                paidUSD,
                nqv8Price:  price,
                claimedAt:  new Date()
            });
        } catch (raceErr) {
            // create() fails if the doc appeared between our read and write
            return res.status(409).json({ error: 'This payment has already been used.' });
        }

        const voucher = await issueVoucher({ uid: caller.uid, purpose, txHash });

        console.log(`🎟️ Voucher issued: ${purpose} for ${caller.uid} (~$${paidUSD.toFixed(2)})`);
        return res.status(200).json({ success: true, voucher });

    } catch (e) {
        console.error('claim-voucher error:', e.message);
        return res.status(500).json({ error: e.message });
    }
}

// api/subscriptions.js
//
// Paid creator memberships: 30-day passes, paid in USDC.
//
// HOW THE MONEY MOVES. NQVate never holds it. The member sends two ordinary
// USDC transfers from their own wallet:
//
//     96.5%  → the creator's wallet
//      3.5%  → the Operations wallet (the platform fee, same rate as escrow),
//              which this endpoint then forwards into the Rewards contract
//
// There are no token approvals anywhere in this flow, so nothing is left
// standing that could be pulled from later.
//
// HOW A PAYMENT IS TIED TO A MEMBER. A USDC transfer carries no note saying
// who it is for, and a member's wallet address in Firestore is something they
// can edit themselves — so neither can be trusted to answer "whose payment is
// this?". Instead the server issues a QUOTE first, and the quote's fee amount
// includes a random fraction of a cent (at most $0.000999) that makes it
// unique. Only the account that was issued that exact amount can claim the
// transfers that match it. Watching the chain and submitting someone else's
// transaction hashes gets nowhere: they match nobody else's quote.
//
// A quote also fixes the price for twenty minutes, so a creator changing
// their price mid-payment cannot strand a member who has already paid.
//
// GATED CONTENT. A subscribers-only episode's link is never written to the
// public post; it is held here and handed out by `unlock` to the creator, an
// admin, or a member whose pass is current. A subscribers-only stream runs in
// a private video room, and `unlock` issues a watch-only token for it.
//
// Everything this file stores (subscriptions, subIntents, usedSubTxs,
// gatedContent) is read and written only through the Admin SDK. No Firestore
// rule opens any of it to the browser.

export const config = { maxDuration: 60 };

import crypto from 'crypto';
import { ethers } from 'ethers';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { verifyCaller } from './_auth.js';
import { payCreditedUSDCFee, splitTwo, MEMBERSHIP_SUBSCRIBER_BPS } from './_rewards.js';

const USDC_ADDRESS     = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const FEE_WALLET       = '0x2c6309Ed2e36222E7e0Ce3c1376941A0D6340F4D';   // Operations
const ARBITRUM_RPC     = 'https://arb1.arbitrum.io/rpc';
const ADMIN_UIDS       = ['5t0gD2wVnqXXPAQEzfoahx3EIPp2'];

const PLATFORM_FEE_BPS = 350;                       // 3.5%, the same cut as escrow
const PASS_SECONDS     = 30 * 24 * 60 * 60;
const QUOTE_SECONDS    = 20 * 60;
const MIN_PRICE        = 1;                         // USDC
const MAX_PRICE        = 1000;

const TRANSFER_TOPIC = ethers.utils.id('Transfer(address,address,uint256)');

function db() {
    if (!getApps().length) {
        initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    }
    return getFirestore();
}

const subId   = (member, creator) => `${member}_${creator}`;
const isAddr  = a => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
const isHash  = h => typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h);
const isId    = s => typeof s === 'string' && s.length > 0 && s.length < 200 && !s.includes('/');
const seconds = t => (t && typeof t.toMillis === 'function') ? Math.floor(t.toMillis() / 1000) : 0;

/// A member's pass with a creator, if it is current.
async function activePass(store, member, creator) {
    const snap = await store.collection('subscriptions').doc(subId(member, creator)).get();
    if (!snap.exists) return null;
    const until = seconds(snap.data().paidUntil);
    return until > Date.now() / 1000 ? until : null;
}

/// The USDC transfers inside one transaction, as { from, to, value }.
function usdcTransfers(receipt) {
    return receipt.logs
        .filter(l => l.address.toLowerCase() === USDC_ADDRESS.toLowerCase() && l.topics[0] === TRANSFER_TOPIC && l.topics.length === 3)
        .map(l => ({
            from:  '0x' + l.topics[1].slice(26).toLowerCase(),
            to:    '0x' + l.topics[2].slice(26).toLowerCase(),
            value: ethers.BigNumber.from(l.data)
        }));
}

// ── quote ────────────────────────────────────────────────────────────────
async function quote(store, uid, body, res) {
    const { creatorUid, wallet } = body;
    if (!isId(creatorUid)) return res.status(400).json({ error: 'creatorUid required' });
    if (!isAddr(wallet))   return res.status(400).json({ error: 'Connect a wallet first' });
    if (creatorUid === uid) return res.status(400).json({ error: 'You cannot subscribe to yourself' });

    const creator = (await store.collection('users').doc(creatorUid).get()).data();
    const price = creator && Number(creator.subscriptionPriceUSDC);
    if (!creator || !(price >= MIN_PRICE && price <= MAX_PRICE)) {
        return res.status(409).json({ error: 'This creator does not offer a paid membership' });
    }
    if (!isAddr(creator.walletAddress)) {
        return res.status(409).json({ error: 'This creator has no wallet connected to be paid to' });
    }
    if (creator.walletAddress.toLowerCase() === wallet.toLowerCase()) {
        return res.status(400).json({ error: 'That is the creator\'s own wallet' });
    }

    // A handful of open quotes is plenty for one person; more than that is
    // someone fishing for a quote that happens to match another member's.
    const open = await store.collection('subIntents').where('uid', '==', uid).get();
    let live = 0;
    open.forEach(d => { const q = d.data(); if (!q.used && q.expiresSec > Date.now() / 1000) live++; });
    if (live >= 5) return res.status(429).json({ error: 'Too many open quotes — wait a few minutes and try again' });

    // Whole micro-USDC throughout, so the split always adds up exactly.
    const total = Math.round(price * 100) * 10000;                          // price to the cent, in 6-decimal units
    const fee   = Math.floor(total * PLATFORM_FEE_BPS / 10000);
    const net   = total - fee;
    const dust  = crypto.randomInt(1, 1000);                                // what makes this quote's fee unique
    const now   = Math.floor(Date.now() / 1000);

    const ref = await store.collection('subIntents').add({
        uid, creatorUid, wallet: wallet.toLowerCase(), creatorWallet: creator.walletAddress.toLowerCase(),
        price, net: String(net), fee: String(fee + dust), used: false,
        createdAt: FieldValue.serverTimestamp(), createdSec: now, expiresSec: now + QUOTE_SECONDS
    });

    return res.status(200).json({
        intentId: ref.id, price, creatorUsername: creator.username || '',
        creatorWallet: creator.walletAddress, feeWallet: FEE_WALLET,
        netRaw: String(net), feeRaw: String(fee + dust),
        expires: now + QUOTE_SECONDS, days: PASS_SECONDS / 86400
    });
}

// ── confirm ──────────────────────────────────────────────────────────────
async function confirm(store, uid, body, res) {
    const { intentId, payTx, feeTx } = body;
    if (!isId(intentId) || !isHash(payTx) || !isHash(feeTx) || payTx.toLowerCase() === feeTx.toLowerCase()) {
        return res.status(400).json({ error: 'intentId, payTx and feeTx required' });
    }
    const intentRef = store.collection('subIntents').doc(intentId);
    const intent = (await intentRef.get()).data();
    if (!intent || intent.uid !== uid) return res.status(404).json({ error: 'Quote not found' });

    if (!intent.used && intent.expiresSec + 40 * 60 < Date.now() / 1000) {
        // Twenty minutes to pay, and a further forty to finish confirming.
        return res.status(410).json({ error: 'That quote has expired' });
    }

    if (intent.used) {
        // The same confirmation arriving twice (a retry after a dropped
        // connection) is not an error: report the pass as it stands.
        if (intent.payTx === payTx.toLowerCase() && intent.feeTx === feeTx.toLowerCase()) {
            return res.status(200).json({ success: true, paidUntil: await activePass(store, uid, intent.creatorUid) });
        }
        return res.status(409).json({ error: 'That quote has already been used' });
    }

    const provider = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
    const [payR, feeR] = await Promise.all([provider.getTransactionReceipt(payTx), provider.getTransactionReceipt(feeTx)]);
    if (!payR || !feeR) return res.status(409).json({ error: 'Those transactions are not confirmed yet — try again in a moment', retry: true });
    if (payR.status !== 1 || feeR.status !== 1) return res.status(400).json({ error: 'One of those transactions failed' });

    // Both must have been mined after the quote was issued (a minute's grace
    // for clock drift) — a payment cannot be older than the amount it matches.
    const [payB, feeB] = await Promise.all([provider.getBlock(payR.blockNumber), provider.getBlock(feeR.blockNumber)]);
    if (!payB || !feeB || payB.timestamp < intent.createdSec - 60 || feeB.timestamp < intent.createdSec - 60) {
        return res.status(400).json({ error: 'Those transactions are older than the quote' });
    }

    const paid = usdcTransfers(payR).some(t => t.from === intent.wallet && t.to === intent.creatorWallet && t.value.eq(intent.net));
    const feed = usdcTransfers(feeR).some(t => t.from === intent.wallet && t.to === FEE_WALLET.toLowerCase() && t.value.eq(intent.fee));
    if (!paid) return res.status(400).json({ error: 'The payment to the creator does not match the quote' });
    if (!feed) return res.status(400).json({ error: 'The platform fee payment does not match the quote' });

    // One atomic step: claim both transactions, close the quote, extend the
    // pass. If any of it has already happened, none of it happens again.
    const subRef  = store.collection('subscriptions').doc(subId(uid, intent.creatorUid));
    const payUsed = store.collection('usedSubTxs').doc(payTx.toLowerCase());
    const feeUsed = store.collection('usedSubTxs').doc(feeTx.toLowerCase());
    let paidUntil;
    try {
        paidUntil = await store.runTransaction(async tx => {
            const [i, s, a, b] = await Promise.all([tx.get(intentRef), tx.get(subRef), tx.get(payUsed), tx.get(feeUsed)]);
            if (i.data().used || a.exists || b.exists) throw new Error('already-used');
            const now  = Math.floor(Date.now() / 1000);
            const from = Math.max(now, s.exists ? seconds(s.data().paidUntil) : 0);      // renewing early adds to what is left
            const until = from + PASS_SECONDS;
            tx.set(payUsed, { uid, intentId, kind: 'pay', usedAt: FieldValue.serverTimestamp() });
            tx.set(feeUsed, { uid, intentId, kind: 'fee', usedAt: FieldValue.serverTimestamp() });
            tx.update(intentRef, { used: true, payTx: payTx.toLowerCase(), feeTx: feeTx.toLowerCase(), usedAt: FieldValue.serverTimestamp() });
            tx.set(subRef, {
                subscriberUid: uid, creatorUid: intent.creatorUid, paidUntil: Timestamp.fromMillis(until * 1000),
                lastPrice: intent.price, lastPayTx: payTx.toLowerCase(), lastFeeTx: feeTx.toLowerCase(),
                payments: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp()
            }, { merge: true });
            return until;
        });
    } catch (e) {
        if (e.message === 'already-used') return res.status(409).json({ error: 'Those transactions have already been used' });
        throw e;
    }

    // The member has their pass. What follows is housekeeping and must not be
    // able to undo it.
    forwardFee(provider, intent, intentId).catch(e => console.error('subscriptions: fee forward failed:', e.message));
    store.collection('notifications').add({
        recipientUid: intent.creatorUid, type: 'subscription', read: false,
        message: `You have a new paid member — $${Number(intent.price).toFixed(2)} for 30 days.`,
        createdAt: FieldValue.serverTimestamp()
    }).catch(() => {});

    return res.status(200).json({ success: true, paidUntil });
}

/// Move the platform's cut from the Operations wallet into the Rewards
/// contract, the same destination as the escrow fee, credited to the
/// subscriber and the creator so it counts towards their share of the month's
/// pool. Approves exactly the amount being moved. If this fails the USDC
/// simply stays in Operations.
async function forwardFee(provider, intent, intentId) {
    if (!process.env.OPERATIONS_PRIVATE_KEY) return;
    const ops     = new ethers.Wallet(process.env.OPERATIONS_PRIVATE_KEY, provider);
    const credits = splitTwo(intent.fee, intent.wallet, intent.creatorWallet, MEMBERSHIP_SUBSCRIBER_BPS);
    const paid    = await payCreditedUSDCFee(ops, provider, intent.fee, credits);
    console.log('subscriptions: fee forwarded to rewards', intentId, paid.txHash);
}

// ── mine ─────────────────────────────────────────────────────────────────
async function mine(store, uid, res) {
    const snap = await store.collection('subscriptions').where('subscriberUid', '==', uid).get();
    const now = Date.now() / 1000, out = [];
    snap.forEach(d => { const until = seconds(d.data().paidUntil); if (until > now) out.push({ creatorUid: d.data().creatorUid, paidUntil: until }); });
    return res.status(200).json({ memberships: out });
}

// ── setGated ─────────────────────────────────────────────────────────────
async function setGated(store, uid, body, res) {
    const { postId, link } = body;
    if (!isId(postId)) return res.status(400).json({ error: 'postId required' });
    let ok = false;
    try { ok = new URL(link).protocol === 'https:' && String(link).length < 600; } catch (e) {}
    if (!ok) return res.status(400).json({ error: 'A full https:// link is required' });

    const post = (await store.collection('posts').doc(postId).get()).data();
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (post.posterUid !== uid) return res.status(403).json({ error: 'Only the author can set this' });
    if (!post.subscribersOnly || post.type !== 'podcast') return res.status(400).json({ error: 'That post is not a subscribers-only episode' });

    await store.collection('gatedContent').doc(postId).set({ link, creatorUid: uid, updatedAt: FieldValue.serverTimestamp() });
    return res.status(200).json({ success: true });
}

// ── unlock ───────────────────────────────────────────────────────────────
async function unlock(store, uid, body, res) {
    const { postId } = body;
    if (!isId(postId)) return res.status(400).json({ error: 'postId required' });
    const post = (await store.collection('posts').doc(postId).get()).data();
    if (!post || !post.subscribersOnly) return res.status(404).json({ error: 'Not a subscribers-only post' });

    const allowed = post.posterUid === uid || ADMIN_UIDS.includes(uid) || !!(await activePass(store, uid, post.posterUid));
    if (!allowed) return res.status(402).json({ error: 'members-only', creatorUid: post.posterUid });

    if (post.type === 'podcast') {
        const g = (await store.collection('gatedContent').doc(postId).get()).data();
        if (!g) return res.status(404).json({ error: 'This episode has no link yet' });
        return res.status(200).json({ link: g.link });
    }

    if (post.type === 'stream') {
        const live = post.liveStatus === 'live' && (!post.liveExpiresAt || Date.now() < post.liveExpiresAt);
        if (!live || !post.liveRoomName || !post.liveRoomUrl) return res.status(200).json({ ended: true });
        if (!process.env.DAILY_API_KEY) return res.status(500).json({ error: 'Live video is not configured' });
        // A watch-only token for the private room: not an owner, so it
        // inherits the room's "cannot send" permission.
        const r = await fetch('https://api.daily.co/v1/meeting-tokens', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DAILY_API_KEY}` },
            body: JSON.stringify({ properties: {
                room_name: post.liveRoomName, is_owner: false, eject_at_token_exp: true,
                exp: Math.floor(Math.min(post.liveExpiresAt || Date.now() + 7200e3, Date.now() + 7200e3) / 1000)
            } })
        });
        if (!r.ok) return res.status(502).json({ error: 'Could not open the stream' });
        return res.status(200).json({ roomUrl: post.liveRoomUrl, token: (await r.json()).token });
    }
    return res.status(400).json({ error: 'Unsupported post type' });
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const caller = await verifyCaller(req, { allowService: false });
    if (!caller || !caller.uid) return res.status(401).json({ error: 'Unauthorized' });

    const body = req.body || {};
    try {
        const store = db();
        switch (body.action) {
            case 'quote':    return await quote(store, caller.uid, body, res);
            case 'confirm':  return await confirm(store, caller.uid, body, res);
            case 'mine':     return await mine(store, caller.uid, res);
            case 'setGated': return await setGated(store, caller.uid, body, res);
            case 'unlock':   return await unlock(store, caller.uid, body, res);
            default:         return res.status(400).json({ error: 'Unknown action' });
        }
    } catch (e) {
        console.error('subscriptions failed:', body.action, e.message);
        return res.status(500).json({ error: 'Something went wrong — nothing was changed' });
    }
}

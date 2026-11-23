// api/_rewards.js
//
// One place for everything the server does with the Rewards contract:
// where it lives, and how a USDC platform fee gets from the Operations wallet
// into the monthly pool WITH CREDIT to the people it came from.
//
// Under RewardsV4 a USDC fee grew the pool but was recorded against nobody, so
// a $5,000 bounty earned its poster the same share as a $50 one. RewardsV5
// takes the fee together with a list of wallets to credit. This file decides
// that list:
//
//   bounty fee      → the poster and the worker
//   membership fee  → the subscriber and the creator
//
// The split is the two numbers below and nothing else. Changing them needs no
// contract change.

import { ethers } from 'ethers';
import { FieldValue } from 'firebase-admin/firestore';
import { gasOverrides } from './_gas.js';

export const REWARDS_ADDRESS      = '0xAD69239AEC2a0ace4A7E75249CdffD8D0Bf5ad06';   // NQVateRewardsV5
export const REWARDS_DEPLOY_BLOCK = 526694327;
export const ESCROW_ADDRESS       = '0x19E9E191e5F277053Db4373FAbb8fBdEa8A30761';
export const USDC_ADDRESS         = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
export const ARBITRUM_RPC         = 'https://arb1.arbitrum.io/rpc';

// Out of 10,000. The other party gets the rest.
export const BOUNTY_POSTER_BPS         = 5000;   // poster 50%, worker 50%
export const MEMBERSHIP_SUBSCRIBER_BPS = 5000;   // subscriber 50%, creator 50%

const REWARDS_ABI = [
    'function payUSDCFeeFor(uint256 amount, address[] wallets, uint256[] portions) external'
];
const ERC20_ABI = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function balanceOf(address owner) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)'
];
const ESCROW_ABI = [
    'function escrows(bytes32) view returns (address poster, address worker, uint128 amount, uint64 deadline, uint64 createdAt, uint64 submittedAt, uint64 autoReleaseAt, uint8 status, bool disputeFiled, address disputeFiledBy, uint32 workerPct, uint32 posterPct)'
];
const ESCROW_EVENTS = new ethers.utils.Interface([
    'event EscrowReleased(bytes32 indexed escrowId, address worker, uint256 workerAmount, uint256 platformFee)',
    'event DisputeResolved(bytes32 indexed escrowId, uint256 workerPct, uint256 posterPct, string ruling)'
]);
const RELEASED_TOPIC = ESCROW_EVENTS.getEventTopic('EscrowReleased');
const RESOLVED_TOPIC = ESCROW_EVENTS.getEventTopic('DisputeResolved');
const TRANSFER_TOPIC = ethers.utils.id('Transfer(address,address,uint256)');

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const isAddr = a => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/.test(a);
const topicAddr = t => '0x' + t.slice(26).toLowerCase();

/** Split `amount` between two wallets: `firstBps` of it to the first, the rest to the second. */
export function splitTwo(amount, first, second, firstBps) {
    const total = ethers.BigNumber.from(amount);
    const a = total.mul(firstBps).div(10000);
    return [{ wallet: first, portion: a }, { wallet: second, portion: total.sub(a) }];
}

/**
 * Move `amount` USDC from the Operations wallet into the Rewards contract,
 * credited as stated.
 *
 * `credits` is [{ wallet, portion }]. Entries without a usable address are
 * dropped — their portion then grows the pool uncredited, which is what the
 * whole fee did before V5. The approval is for exactly this amount.
 *
 * `onSent(hash)` is called as soon as the deposit is broadcast, so a caller
 * that tracks "was anything sent" knows even if confirmation then fails.
 */
export async function payCreditedUSDCFee(ops, provider, amount, credits, onSent) {
    const fee  = ethers.BigNumber.from(amount);
    const good = (credits || []).filter(c => isAddr(c.wallet) && ethers.BigNumber.from(c.portion).gt(0)).slice(0, 4);

    const usdc    = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, ops);
    const rewards = new ethers.Contract(REWARDS_ADDRESS, REWARDS_ABI, ops);

    const balance = await usdc.balanceOf(ops.address);
    if (balance.lt(fee)) throw new Error('Insufficient USDC in Operations wallet');

    const allowance = await usdc.allowance(ops.address, REWARDS_ADDRESS);
    if (allowance.lt(fee)) {
        await (await usdc.approve(REWARDS_ADDRESS, fee, await gasOverrides(provider))).wait();
    }

    // The contract requires at least one wallet. With nobody to credit, name
    // Operations with a zero portion: accepted, and earns nothing.
    const wallets  = good.length ? good.map(c => ethers.utils.getAddress(c.wallet.toLowerCase())) : [ops.address];
    const portions = good.length ? good.map(c => ethers.BigNumber.from(c.portion)) : [0];

    const tx = await rewards.payUSDCFeeFor(fee, wallets, portions, await gasOverrides(provider));
    if (onSent) onSent(tx.hash);
    const done = await tx.wait();
    if (!done || done.status === 0) throw new Error('payUSDCFeeFor reverted');
    return { txHash: tx.hash, credited: good.map(c => ({ wallet: c.wallet.toLowerCase(), portion: ethers.BigNumber.from(c.portion).toString() })) };
}

/**
 * Forward the platform fee from one escrow payout into the Rewards pool,
 * credited to that bounty's poster and worker.
 *
 * WHAT THIS TRUSTS: the chain, and nothing the caller says. The caller hands
 * over a transaction hash; everything else is read from that transaction.
 *
 *   - it must have succeeded and contain exactly one payout event emitted by
 *     OUR escrow contract: an EscrowReleased (a release, by the poster, by the
 *     7-day timer or by an admin) or a DisputeResolved (a ruling);
 *   - the fee is what the same receipt shows arriving in the Operations wallet
 *     from the escrow contract as USDC. For a release it must equal the
 *     platformFee the contract itself put in the event;
 *   - the poster and the worker are read from the escrow record on-chain;
 *   - each payout is forwarded once. The claim is recorded before the transfer
 *     and given back only if nothing was sent.
 *
 * Returns { status, ... } where status is one of
 *   'deposited' | 'already' | 'no-fee' | 'pending' | 'invalid'
 * and throws only when the deposit itself could not be made.
 */
export async function forwardEscrowFee({ db, txHash, subprojectId = null, requestedBy = 'service', waitForReceipt = true }) {
    if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        return { status: 'invalid', reason: 'escrowTxHash required' };
    }
    txHash = txHash.toLowerCase();

    const provider = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
    const ops      = new ethers.Wallet(process.env.OPERATIONS_PRIVATE_KEY, provider);

    // A page calls this the moment its wallet reports the release, which can
    // be a beat before this node has the receipt.
    let receipt = null;
    for (let i = 0; i < (waitForReceipt ? 4 : 1) && !receipt; i++) {
        receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt && waitForReceipt && i < 3) await sleep(1500);
    }
    if (!receipt) return { status: 'pending', reason: 'That transaction is not confirmed yet' };
    if (receipt.status !== 1) return { status: 'invalid', reason: 'That transaction failed' };

    // ── The payout, as our escrow contract recorded it ─────────────────────
    const escrow   = ESCROW_ADDRESS.toLowerCase();
    const ours     = receipt.logs.filter(l => l.address.toLowerCase() === escrow);
    const released = ours.filter(l => l.topics[0] === RELEASED_TOPIC);
    const resolved = ours.filter(l => l.topics[0] === RESOLVED_TOPIC);
    if (released.length + resolved.length !== 1) {
        return { status: 'invalid', reason: 'That transaction is not a single escrow payout on the NQVate escrow contract' };
    }

    // ── …and the fee really arriving here ──────────────────────────────────
    const opsAddr = ops.address.toLowerCase();
    const arrived = receipt.logs
        .filter(l => l.address.toLowerCase() === USDC_ADDRESS.toLowerCase() && l.topics[0] === TRANSFER_TOPIC && l.topics.length === 3 &&
                     topicAddr(l.topics[1]) === escrow && topicAddr(l.topics[2]) === opsAddr)
        .map(l => ethers.BigNumber.from(l.data));

    let escrowId, fee, kind;
    if (released.length) {
        const ev = ESCROW_EVENTS.parseLog(released[0]);
        escrowId = ev.args.escrowId; fee = ev.args.platformFee; kind = 'release';
        if (fee.isZero()) return { status: 'no-fee' };
        if (!arrived.some(v => v.eq(fee))) {
            return { status: 'invalid', reason: 'The fee from that release was not paid to the Operations wallet' };
        }
    } else {
        // A ruling carries no fee figure. The fee is whatever the escrow
        // contract sent Operations in this transaction — nothing, if the
        // worker was awarded nothing.
        const ev = ESCROW_EVENTS.parseLog(resolved[0]);
        escrowId = ev.args.escrowId; kind = 'dispute';
        fee = arrived.reduce((a, v) => a.add(v), ethers.BigNumber.from(0));
        if (fee.isZero()) return { status: 'no-fee' };
    }

    // ── Who it came from ───────────────────────────────────────────────────
    // Read before the claim is taken, so a failed read leaves nothing to undo.
    const rec = await new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, provider).escrows(escrowId);
    const credits = splitTwo(fee, rec.poster, rec.worker, BOUNTY_POSTER_BPS);

    // ── Once only ──────────────────────────────────────────────────────────
    // create() fails if the record exists, so two requests for the same
    // payout cannot both get past this line.
    const marker = db.collection('depositedEscrowFees').doc(txHash);
    try {
        await marker.create({
            escrowId, kind, fee: fee.toString(),
            subprojectId: subprojectId ? String(subprojectId).slice(0, 200) : null,
            requestedBy, status: 'pending', createdAt: FieldValue.serverTimestamp()
        });
    } catch (e) {
        return { status: 'already' };
    }

    let sentHash = null;
    try {
        const paid = await payCreditedUSDCFee(ops, provider, fee, credits, h => { sentHash = h; });
        await marker.update({
            status: 'deposited', depositTxHash: paid.txHash, credited: paid.credited,
            depositedAt: FieldValue.serverTimestamp()
        }).catch(e => console.warn('forwardEscrowFee: could not mark deposited:', e.message));

        const feeUSDC = Number(ethers.utils.formatUnits(fee, 6));
        console.log(`✅ Deposited $${feeUSDC.toFixed(4)} USDC into rewards pool (${kind}) | payout ${txHash} | deposit ${paid.txHash} | subproject ${subprojectId || '-'}`);
        return { status: 'deposited', platformFeeUSDC: feeUSDC, depositTxHash: paid.txHash, escrowTxHash: txHash, credited: paid.credited };

    } catch (e) {
        if (sentHash) {
            // Broadcast, outcome unknown. Keep the claim, so a retry cannot
            // send the same fee twice; the record says which tx to look up.
            await marker.update({ status: 'unconfirmed', depositTxHash: sentHash, error: String(e.message).slice(0, 200) }).catch(() => {});
        } else {
            // Nothing was sent. Give the claim back: the fee is still in
            // Operations and a retry should be able to forward it.
            await marker.delete().catch(() => {});
        }
        throw e;
    }
}

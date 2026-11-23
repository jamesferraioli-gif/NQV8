// api/deposit-escrow-fee.js
//
// After a bounty's escrow is released, move the platform's 3.5% USDC fee from
// the Operations wallet into the Rewards contract, so it is counted in the
// month's pool.
//
// WHAT THIS ENDPOINT TRUSTS: the chain, and nothing the browser says.
//
// The caller supplies one thing that matters — the hash of the release
// transaction. Everything else is read from that transaction's receipt:
//
//   - it must have succeeded, and contain an EscrowReleased event emitted by
//     OUR escrow contract (not merely a contract that emits a same-named one);
//   - the fee is the `platformFee` in that event — the amount the contract
//     itself computed — not a number sent in the request;
//   - the same receipt must show that fee arriving in the Operations wallet
//     as USDC, so this never forwards money that did not come in;
//   - each release can be forwarded once. The claim is recorded before the
//     transfer and released again only if the transfer fails.
//
// It used to take `bountyAmountUSDC` from the request and forward 3.5% of
// whatever it was told, as often as it was asked: any signed-in user could
// drain the Operations wallet's USDC into the rewards pool. That field is now
// ignored.
//
// The approval given to the Rewards contract is for exactly the amount being
// moved, never an open-ended one.

export const config = { maxDuration: 60 };

import { ethers } from 'ethers';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { verifyCaller } from './_auth.js';
import { gasOverrides } from './_gas.js';

const REWARDS_CONTRACT_ADDRESS = '0x0F630bbEd28545970CCD5C15eAD08fb1286c160f';
const ESCROW_CONTRACT_ADDRESS  = '0x19E9E191e5F277053Db4373FAbb8fBdEa8A30761';
const USDC_ADDRESS             = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const ARBITRUM_RPC             = 'https://arb1.arbitrum.io/rpc';

const REWARDS_ABI = ["function payUSDCFee(uint256 amount) external"];
const ERC20_ABI = [
    "function approve(address spender, uint256 amount) returns (bool)",
    "function balanceOf(address owner) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)"
];
const ESCROW_EVENTS = new ethers.utils.Interface([
    "event EscrowReleased(bytes32 indexed escrowId, address worker, uint256 workerAmount, uint256 platformFee)"
]);
const RELEASED_TOPIC = ESCROW_EVENTS.getEventTopic('EscrowReleased');
const TRANSFER_TOPIC = ethers.utils.id('Transfer(address,address,uint256)');

function getAdminDb() {
    if (!getApps().length) {
        initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    }
    return getFirestore();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const caller = await verifyCaller(req);
    if (!caller) return res.status(401).json({ error: 'Unauthorized' });

    const { escrowTxHash, subprojectId } = req.body || {};
    if (typeof escrowTxHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(escrowTxHash)) {
        return res.status(400).json({ error: 'escrowTxHash required' });
    }
    const txHash = escrowTxHash.toLowerCase();

    let marker = null, claimed = false, sentHash = null;
    try {
        const provider = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
        const wallet   = new ethers.Wallet(process.env.OPERATIONS_PRIVATE_KEY, provider);

        // The page calls this the moment its wallet reports the release, which
        // can be a beat before this node has the receipt.
        let receipt = null;
        for (let i = 0; i < 4 && !receipt; i++) {
            receipt = await provider.getTransactionReceipt(txHash);
            if (!receipt && i < 3) await sleep(1500);
        }
        if (!receipt) return res.status(409).json({ error: 'That transaction is not confirmed yet', retry: true });
        if (receipt.status !== 1) return res.status(400).json({ error: 'That transaction failed' });

        // ── The release, as our escrow contract recorded it ────────────────
        const escrow = ESCROW_CONTRACT_ADDRESS.toLowerCase();
        const released = receipt.logs.filter(l => l.address.toLowerCase() === escrow && l.topics[0] === RELEASED_TOPIC);
        if (released.length !== 1) {
            return res.status(400).json({ error: 'That transaction is not a single escrow release on the NQVate escrow contract' });
        }
        const ev  = ESCROW_EVENTS.parseLog(released[0]);
        const fee = ev.args.platformFee;
        if (fee.isZero()) return res.status(200).json({ success: true, platformFeeUSDC: 0, note: 'No fee on this release' });

        // ── …and that fee really arriving here ─────────────────────────────
        const ops = wallet.address.toLowerCase();
        const arrived = receipt.logs.some(l =>
            l.address.toLowerCase() === USDC_ADDRESS.toLowerCase() && l.topics[0] === TRANSFER_TOPIC && l.topics.length === 3 &&
            '0x' + l.topics[1].slice(26).toLowerCase() === escrow &&
            '0x' + l.topics[2].slice(26).toLowerCase() === ops &&
            ethers.BigNumber.from(l.data).eq(fee));
        if (!arrived) {
            return res.status(400).json({ error: 'The fee from that release was not paid to the Operations wallet' });
        }

        // ── Once only ──────────────────────────────────────────────────────
        // create() fails if the record exists, so two requests for the same
        // release cannot both get past this line.
        marker = getAdminDb().collection('depositedEscrowFees').doc(txHash);
        try {
            await marker.create({
                escrowId: ev.args.escrowId, fee: fee.toString(), subprojectId: subprojectId ? String(subprojectId).slice(0, 200) : null,
                requestedBy: caller.uid || 'service', status: 'pending', createdAt: FieldValue.serverTimestamp()
            });
            claimed = true;
        } catch (e) {
            return res.status(200).json({ success: true, alreadyDeposited: true });
        }

        const usdc    = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, wallet);
        const rewards = new ethers.Contract(REWARDS_CONTRACT_ADDRESS, REWARDS_ABI, wallet);

        const balance = await usdc.balanceOf(wallet.address);
        if (balance.lt(fee)) throw new Error('Insufficient USDC in Operations wallet');

        // Exactly this fee. Any allowance already standing is used first.
        const allowance = await usdc.allowance(wallet.address, REWARDS_CONTRACT_ADDRESS);
        if (allowance.lt(fee)) {
            await (await usdc.approve(REWARDS_CONTRACT_ADDRESS, fee, await gasOverrides(provider))).wait();
        }

        const depositTx = await rewards.payUSDCFee(fee, await gasOverrides(provider));
        sentHash = depositTx.hash;
        const done = await depositTx.wait();
        if (!done || done.status === 0) throw new Error('payUSDCFee reverted');

        await marker.update({ status: 'deposited', depositTxHash: depositTx.hash, depositedAt: FieldValue.serverTimestamp() })
            .catch(e => console.warn('deposit-escrow-fee: could not mark deposited:', e.message));

        const feeUSDC = Number(ethers.utils.formatUnits(fee, 6));
        console.log(`✅ Deposited $${feeUSDC.toFixed(4)} USDC into rewards pool | release ${txHash} | deposit ${depositTx.hash} | subproject ${subprojectId || '-'}`);

        return res.status(200).json({
            success: true, platformFeeUSDC: feeUSDC, depositTxHash: depositTx.hash, escrowTxHash: txHash, subprojectId: subprojectId || null
        });

    } catch (e) {
        console.error('deposit-escrow-fee error:', e.message);
        if (claimed && marker) {
            if (sentHash) {
                // The deposit was broadcast and its outcome is not known here.
                // Keep the claim, so a retry cannot send the same fee twice;
                // the record says which transaction to look up.
                await marker.update({ status: 'unconfirmed', depositTxHash: sentHash, error: String(e.message).slice(0, 200) }).catch(() => {});
            } else {
                // Nothing was sent. Give the claim back: the fee is still in
                // Operations and a retry should be able to forward it.
                await marker.delete().catch(() => {});
            }
        }
        return res.status(500).json({ error: 'The fee could not be deposited — it remains in the Operations wallet' });
    }
}

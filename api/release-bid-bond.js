// api/release-bid-bond.js
//
// Returns bid bonds. releaseBond is onlyOwner on NQVateStakingV2, so the
// browser cannot call it — this runs with the ops key.
//
// Three endings, all of them clean, all returning the stake in full:
//
//   losers     a bid was accepted, so every other bidder is free
//   withdrawn  a builder pulled their own bid
//   cancelled  the founder deleted the posting
//
// A released bond becomes immediately withdrawable — StakingV2 exempts it
// from the 30-day cooldown, because capital the protocol required a bidder to
// lock was never cycling stake around reward epochs.
//
// Releasing is the SAFE direction: it hands money back. So unlike locking,
// this needs no signature from the wallet — only proof that the caller is
// entitled to end that bid. What it must never do is release the WINNER's
// bond, which stays locked as their delivery commitment.
//
// The on-chain expiry is the backstop under all of this. If this endpoint is
// never called, or fails forever, a bid bond still frees itself once its
// expiry passes and anyone can trigger it. Nothing here can strand capital
// permanently.

export const config = { maxDuration: 60 };

import { ethers } from 'ethers';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { verifyCaller } from './_auth.js';
import { gasOverrides } from './_gas.js';

const STAKING_ADDRESS = '0x5d430f7Faae867E0A8a02EcCcbE21eF40628937c';
const ARBITRUM_RPC    = 'https://arb1.arbitrum.io/rpc';
const BOND_KIND_BID   = 1;

/// Matches MAX_BATCH in NQVateStakingV2.
const MAX_BATCH = 100;

const STAKING_ABI = [
    "function releaseBond(bytes32 bondId) external",
    "function releaseBonds(bytes32[] bondIds) external",
    "function getBond(bytes32 bondId) external view returns (tuple(address holder, uint256 amount, bytes32 ref, uint8 kind, uint8 status, uint64 createdAt, uint64 expiresAt, uint256 creditOnRelease))"
];

function getAdminDb() {
    if (!getApps().length) {
        initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    }
    return getFirestore();
}

/// Must match bidBondId() in index.html and api/lock-bid-bond.js.
function bidBondId(projectId, holder) {
    return ethers.utils.solidityKeccak256(
        ['string', 'address', 'uint8'], [projectId, holder, BOND_KIND_BID]);
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const caller = await verifyCaller(req);
    if (!caller) return res.status(401).json({ error: 'Unauthorized' });

    const { projectId, reason } = req.body || {};
    if (!projectId) return res.status(400).json({ error: 'Missing projectId' });
    if (!['losers', 'withdrawn', 'cancelled'].includes(reason)) {
        return res.status(400).json({ error: 'reason must be losers, withdrawn or cancelled' });
    }

    try {
        const db   = getAdminDb();
        const ref  = db.collection('subprojects').doc(projectId);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Posting not found' });

        const project = snap.data();
        const bids    = Array.isArray(project.bids) ? project.bids : [];
        const isOwner = !caller.service &&
            (project.posterUid === caller.uid || project.ownerUid === caller.uid);

        // ── Who may end which bids ────────────────────────────────────────
        let targets;   // the bids whose bonds are being released

        if (reason === 'withdrawn') {
            if (caller.service) return res.status(400).json({ error: 'withdrawn requires a user caller' });
            const mine = bids.filter(b => b.bidderUid === caller.uid);
            if (mine.length === 0) return res.status(404).json({ error: 'You have no bid on this posting' });
            // A builder cannot walk away from a commitment they have already
            // won — that bond is now backing a live job.
            if (project.acceptedBidderUid === caller.uid) {
                return res.status(409).json({
                    error: 'Your bid was accepted, so it can no longer be withdrawn'
                });
            }
            targets = mine;

        } else if (reason === 'losers') {
            if (!isOwner && !caller.service) {
                return res.status(403).json({ error: 'Only the poster can settle bids on this posting' });
            }
            if (!project.acceptedBidderUid) {
                return res.status(409).json({ error: 'No bid has been accepted on this posting yet' });
            }
            targets = bids.filter(b => b.bidderUid !== project.acceptedBidderUid);

        } else { // cancelled
            if (!isOwner && !caller.service) {
                return res.status(403).json({ error: 'Only the poster can cancel this posting' });
            }
            // Deleting is already blocked once a bid is accepted; this is the
            // second lock, because releasing a winner's bond here would free
            // a builder from a job that is underway.
            if (project.acceptedBidderUid) {
                return res.status(409).json({
                    error: 'A bid has been accepted, so bonds cannot be released by cancelling'
                });
            }
            targets = bids;
        }

        // ── Resolve to bond ids ───────────────────────────────────────────
        // bondWallet is the wallet that was connected when the bid was placed,
        // which is what the bond is held against. It is NOT paymentWallet,
        // which a bidder may set to somewhere else entirely.
        const wallets = [...new Set(
            targets.map(b => b.bondWallet).filter(w => w && ethers.utils.isAddress(w))
                   .map(w => w.toLowerCase())
        )];

        if (wallets.length === 0) {
            return res.status(200).json({
                success: true, released: 0,
                note: 'No bonded bids to release (bids placed before bonds, or none matching)'
            });
        }

        const provider = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
        const wallet   = new ethers.Wallet(process.env.OPERATIONS_PRIVATE_KEY, provider);
        const staking  = new ethers.Contract(STAKING_ADDRESS, STAKING_ABI, wallet);

        // Only release what is actually Active. releaseBonds skips the rest
        // anyway, but filtering first keeps a no-op from costing a
        // transaction, and makes the count we report honest.
        // Kept in lockstep: ids is filtered to active bonds, so it cannot be
        // indexed against `wallets` afterwards.
        const ids    = [];
        const freed  = new Set();
        for (const w of wallets) {
            const id = bidBondId(projectId, w);
            try {
                const b = await staking.getBond(id);
                if (b.status === 1) { ids.push(id); freed.add(w); }
            } catch (e) {
                console.warn('getBond failed for', w, e.message);
            }
        }

        if (ids.length === 0) {
            return res.status(200).json({ success: true, released: 0, note: 'Nothing active to release' });
        }

        let txHash = null;
        for (let i = 0; i < ids.length; i += MAX_BATCH) {
            const slice = ids.slice(i, i + MAX_BATCH);
            const tx = slice.length === 1
                ? await staking.releaseBond(slice[0], await gasOverrides(provider))
                : await staking.releaseBonds(slice, await gasOverrides(provider));
            const rec = await tx.wait();
            if (!rec || rec.status === 0) throw new Error('release reverted');
            txHash = tx.hash;
        }

        // ── Tell the builders ─────────────────────────────────────────────
        // A bidder has capital sitting in a bond and no reason to keep
        // checking a posting they did not win. Without a notification the
        // release is invisible and the stake looks stuck.
        if (reason !== 'withdrawn') {
            const title = project.title || 'a posting';
            await Promise.all(targets
                .filter(b => b.bidderUid && b.bondWallet && freed.has(String(b.bondWallet).toLowerCase()))
                .map(b => db.collection('notifications').add({
                    recipientUid: b.bidderUid,
                    type:    'bond_released',
                    message: reason === 'losers'
                        ? `Your bid on "${title}" wasn't selected. Your ${Number(b.bondNQV8 || 0).toLocaleString()} NQV8 stake has been released — withdraw it any time from Tokenomics, with no cooldown.`
                        : `"${title}" was cancelled by the poster. Your ${Number(b.bondNQV8 || 0).toLocaleString()} NQV8 stake has been released — withdraw it any time from Tokenomics, with no cooldown.`,
                    read: false,
                    createdAt: new Date(),
                    projectId
                }))
            ).catch(e => console.warn('bond_released notifications failed:', e.message));
        }

        // ── A withdrawn bid also leaves the posting ───────────────────────
        // Done AFTER the on-chain release: if the release fails the bid stays,
        // and the builder can retry. The reverse order could drop their bid
        // while their capital stayed locked until expiry.
        if (reason === 'withdrawn') {
            await ref.update({ bids: bids.filter(b => b.bidderUid !== caller.uid) });
        }

        return res.status(200).json({ success: true, reason, released: ids.length, txHash });

    } catch (e) {
        console.error('release-bid-bond failed:', e);
        return res.status(500).json({ error: e.message });
    }
}

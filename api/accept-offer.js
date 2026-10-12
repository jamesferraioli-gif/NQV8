// api/accept-offer.js
// Called immediately after buyer makes an offer at asking price.
// Ops wallet accepts on behalf of seller — completing the trade atomically.

import { ethers } from 'ethers';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { verifyCaller } from './_auth.js';
import { gasOverrides } from './_gas.js';

if (!getApps().length) {
    initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
const db = getFirestore();

const EQUITY_REGISTRY_ADDRESS = '0x726a5EEa94C6d3117bbCd05336A0Cfdaf3c9327a';
const ARBITRUM_RPC            = 'https://arb1.arbitrum.io/rpc';

const EQUITY_ABI = [
    "function acceptOffer(bytes32 offerId) external",
    "function rejectOffer(bytes32 offerId) external",
    "function rejectOffers(bytes32[] offerIds) external",
    "function offers(bytes32 offerId) external view returns (bytes32 listingId, address buyer, uint128 units, uint128 pricePerUnit, uint64 createdAt, bool active)"
];

function toBytes32(str) {
    return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(str));
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const caller = await verifyCaller(req);
    if (!caller) return res.status(401).json({ error: 'Unauthorized' });

    const { offerId, listingId } = req.body;
    if (!offerId) return res.status(400).json({ error: 'Missing offerId' });

    try {
        const provider  = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
        const opsWallet = new ethers.Wallet(process.env.OPERATIONS_PRIVATE_KEY, provider);
        const equity    = new ethers.Contract(EQUITY_REGISTRY_ADDRESS, EQUITY_ABI, opsWallet);

        const tx = await equity.acceptOffer(toBytes32(offerId), await gasOverrides(provider));
        await tx.wait();

        console.log(`✅ Offer accepted: ${offerId} | Tx: ${tx.hash}`);

        // Refund everyone who lost. Competing offers are intended on a funding
        // request, but being outbid should not cost you a week of locked
        // capital waiting for the 7-day expiry. Best-effort: the sale already
        // succeeded, so a refund failure must not fail this request.
        let refundedCount = 0, refundTxHash = null;
        if (listingId) {
            try {
                const losersSnap = await db.collection('equityOffers')
                    .where('listingId', '==', listingId)
                    .where('active', '==', true)
                    .get();

                const loserIds = [];
                for (const d of losersSnap.docs) {
                    const row = d.data();
                    const id  = row.offerId || d.id;
                    if (id === offerId) continue;                 // the winner
                    try {
                        const onChain = await equity.offers(toBytes32(id));
                        if (onChain.active) loserIds.push(toBytes32(id));
                    } catch (e) { /* unreadable — skip rather than guess */ }
                }

                if (loserIds.length) {
                    const rTx = await equity.rejectOffers(loserIds, await gasOverrides(provider));
                    await rTx.wait();
                    refundedCount = loserIds.length;
                    refundTxHash  = rTx.hash;
                    console.log(`💸 Refunded ${refundedCount} losing offer(s) | Tx: ${rTx.hash}`);

                    await Promise.all(losersSnap.docs
                        .filter(d => (d.data().offerId || d.id) !== offerId)
                        .map(d => d.ref.update({ active: false, status: 'outbid' }).catch(() => {})));
                }
            } catch (refundErr) {
                console.error(`⚠️ Losing-offer refunds failed for listing ${listingId}:`, refundErr.message);
            }
        }

        return res.status(200).json({ success: true, txHash: tx.hash, refundedCount, refundTxHash });

    } catch(e) {
        console.error('accept-offer error:', e.message);

        // SAFETY NET — the buyer's USDC is already locked in the contract by the
        // time we get here (makeOffer took it). V4 does not encumber a seller's
        // equity while it is listed, so the units can be gone by the time we try
        // to settle, and acceptOffer reverts on "Insufficient equity". Without
        // this, that money sits locked until the 7-day expiry. rejectOffer is
        // callable by the owner, so refund the buyer now instead.
        if (e.message.includes('Insufficient equity')) {
            try {
                const provider  = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
                const opsWallet = new ethers.Wallet(process.env.OPERATIONS_PRIVATE_KEY, provider);
                const equity    = new ethers.Contract(EQUITY_REGISTRY_ADDRESS, EQUITY_ABI, opsWallet);

                const refundTx = await equity.rejectOffer(toBytes32(offerId), await gasOverrides(provider));
                await refundTx.wait();
                console.log(`💸 Auto-refunded buyer for offer ${offerId} | Tx: ${refundTx.hash}`);

                return res.status(409).json({
                    error: 'The seller no longer holds enough equity to complete this sale. Your USDC has been refunded in full.',
                    refunded: true,
                    refundTxHash: refundTx.hash
                });
            } catch (refundErr) {
                console.error(`🚨 REFUND FAILED for offer ${offerId}:`, refundErr.message);
                return res.status(500).json({
                    error: 'This sale could not be completed and the automatic refund also failed. Our team has been notified — your funds are safe and will be returned.',
                    refundFailed: true
                });
            }
        }

        let userMessage = e.message;
        if (e.message.includes('UNPREDICTABLE_GAS_LIMIT') ||
            e.message.includes('insufficient funds')) {
            userMessage = 'PLATFORM_GAS_ERROR';
        } else if (e.message.includes('Offer not active')) {
            userMessage = 'This offer is no longer active.';
        } else if (e.message.includes('Listing not active')) {
            userMessage = 'This listing is no longer active.';
        }

        return res.status(500).json({ error: userMessage });
    }
}

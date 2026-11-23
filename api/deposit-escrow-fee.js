// api/deposit-escrow-fee.js
//
// After a bounty's escrow is released, move the platform's 3.5% USDC fee from
// the Operations wallet into the Rewards contract, credited to the bounty's
// poster and worker so it counts towards their share of the month's pool.
//
// The work — and the account of what is and is not trusted — is in
// _rewards.js (forwardEscrowFee), which the server-side release paths call
// directly. This endpoint is the same thing for a release the poster signed
// in their own wallet: the page hands over the transaction hash.
//
// WHAT THIS ENDPOINT TRUSTS: the chain, and nothing the browser says. The
// amount, the poster and the worker are all read from the transaction. Any
// `bountyAmountUSDC` in the request is ignored. Each release is forwarded once.

export const config = { maxDuration: 60 };

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { verifyCaller } from './_auth.js';
import { forwardEscrowFee } from './_rewards.js';

function getAdminDb() {
    if (!getApps().length) {
        initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    }
    return getFirestore();
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const caller = await verifyCaller(req);
    if (!caller) return res.status(401).json({ error: 'Unauthorized' });

    const { escrowTxHash, subprojectId } = req.body || {};

    try {
        const r = await forwardEscrowFee({
            db: getAdminDb(), txHash: escrowTxHash, subprojectId, requestedBy: caller.uid || 'service'
        });

        if (r.status === 'invalid') return res.status(400).json({ error: r.reason });
        if (r.status === 'pending') return res.status(409).json({ error: r.reason, retry: true });
        if (r.status === 'already') return res.status(200).json({ success: true, alreadyDeposited: true });
        if (r.status === 'no-fee')  return res.status(200).json({ success: true, platformFeeUSDC: 0, note: 'No fee on this release' });

        return res.status(200).json({
            success: true, platformFeeUSDC: r.platformFeeUSDC, depositTxHash: r.depositTxHash,
            escrowTxHash: r.escrowTxHash, subprojectId: subprojectId || null
        });

    } catch (e) {
        console.error('deposit-escrow-fee error:', e.message);
        return res.status(500).json({ error: 'The fee could not be deposited — it remains in the Operations wallet' });
    }
}

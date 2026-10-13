// api/ai-job.js
// Step 1 of a paid AI job: exchange a voucher for a durable job record.
//
// Returns in well under a second. The actual generation happens in
// ai-job-run.js, so a slow model can never kill the request that took the
// money. The client fires ai-job-run and then watches the job document.

import { verifyCaller } from './_auth.js';
import { verifyVoucher } from './_voucher.js';
import { getKind } from './_aikinds.js';
import { createJob } from './_aijobs.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const caller = await verifyCaller(req);
    if (!caller) return res.status(401).json({ error: 'Unauthorized' });

    const { kind, voucher, wallet, input } = req.body || {};

    if (!kind || !getKind(kind)) return res.status(400).json({ error: `Unknown job kind: ${kind}` });

    try {
        let jobId;

        if (caller.service) {
            // Internal callers (crons, admin tooling) pay no fee and supply
            // their own id. They are never refunded, so no wallet is recorded.
            jobId = req.body.jobId;
            if (!jobId) return res.status(400).json({ error: 'jobId required for service calls' });
        } else {
            if (!caller.uid) return res.status(403).json({ error: 'A signed-in user is required' });

            const v = await verifyVoucher(voucher, kind, caller.uid);
            if (!v) return res.status(402).json({ error: 'Payment required or voucher expired' });

            // The voucher's txHash is the job id, so one payment can only ever
            // produce one job however many times this is called.
            jobId = v.txHash;
            if (!jobId) return res.status(400).json({ error: 'Voucher is missing its transaction hash' });
        }

        const { job, created } = await createJob({
            jobId,
            kind,
            uid:    caller.uid || null,
            wallet: caller.service ? null : wallet,
            input
        });

        return res.status(created ? 201 : 200).json({
            jobId:     job.id,
            status:    job.status,
            retryable: job.retryable,
            created,
            // A replayed request gets the finished result straight back rather
            // than paying for a second run.
            result:    job.status === 'done' ? job.result : null
        });

    } catch (e) {
        console.error('ai-job create failed:', e.message);
        return res.status(500).json({ error: e.message });
    }
}

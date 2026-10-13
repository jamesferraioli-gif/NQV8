// api/ai-job-run.js
// Step 2 of a paid AI job: do the work and write the result to the job doc.
//
// A Node function, not Edge — Edge caps the initial response at 25s and the
// flow map generation exceeded that, which is how two 500 NQV8 payments were
// lost in testing. maxDuration is a ceiling, not a target.
//
// The caller does not need to receive this response. Whatever happens to the
// HTTP request, the outcome lands on the job document, and the client (or the
// sweep cron) reads it from there. That is the whole point of the split.

export const config = { maxDuration: 300 };

import { verifyCaller } from './_auth.js';
import { getKind } from './_aikinds.js';
import { jobRef, claimJob, completeJob, failJob } from './_aijobs.js';
import { isRetryableAIError } from './_ai.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const caller = await verifyCaller(req);
    if (!caller) return res.status(401).json({ error: 'Unauthorized' });

    const { jobId, input } = req.body || {};
    if (!jobId) return res.status(400).json({ error: 'jobId required' });

    try {
        const snap = await jobRef(jobId).get();
        if (!snap.exists) return res.status(404).json({ error: 'Job not found' });
        const existing = snap.data();

        // Only the job's owner or an internal caller may run it.
        if (!caller.service && existing.uid !== caller.uid) {
            return res.status(403).json({ error: 'Not your job' });
        }

        if (existing.status === 'done') {
            return res.status(200).json({ status: 'done', result: existing.result });
        }
        if (existing.status === 'refunded') {
            return res.status(200).json({ status: 'refunded', error: existing.error });
        }

        const spec = getKind(existing.kind);
        if (!spec) return res.status(400).json({ error: `Unknown job kind: ${existing.kind}` });
        if (typeof spec.run !== 'function') {
            // A kind that has no runner here is still served by its own
            // endpoint. Fail terminally so the fee is refunded rather than
            // leaving the job pending forever.
            await failJob(jobId, `No runner registered for ${existing.kind}`, { terminal: true });
            return res.status(501).json({ error: `${existing.kind} is not run through the job queue yet` });
        }

        // Claim it. Returns null when another worker holds it or attempts are
        // exhausted — a paid generation must never run twice concurrently.
        const job = await claimJob(jobId);
        if (!job) {
            const now = (await jobRef(jobId).get()).data();
            return res.status(409).json({
                status: now?.status || 'unknown',
                error:  now?.status === 'running' ? 'Already running' : 'Cannot run this job'
            });
        }

        // Stored input for retryable kinds; for the rest it has to arrive with
        // this request, because it was too large to persist.
        const payload = job.retryable ? (job.input || {}) : (input || {});
        if (!job.retryable && (!input || Object.keys(input).length === 0)) {
            await failJob(jobId, 'Input was not supplied and this job kind cannot store it', { terminal: true });
            return res.status(400).json({ error: 'Input required for this job kind' });
        }

        const started = Date.now();
        try {
            const result = await spec.run(payload);
            await completeJob(jobId, result);
            console.log(`🤖 ${job.kind} job ${jobId} done in ${Date.now() - started}ms (attempt ${job.attempts})`);
            return res.status(200).json({ status: 'done', result });
        } catch (e) {
            // A rate limit or an overloaded upstream deserves another attempt.
            // A malformed prompt or a bad model string does not.
            const terminal = !isRetryableAIError(e);
            await failJob(jobId, e.message, { terminal });
            console.error(`❌ ${job.kind} job ${jobId} attempt ${job.attempts} failed (${terminal ? 'terminal' : 'will retry'}): ${e.message}`);
            return res.status(500).json({ status: terminal ? 'failed' : 'pending', error: e.message });
        }

    } catch (e) {
        console.error('ai-job-run failed:', e.message);
        return res.status(500).json({ error: e.message });
    }
}

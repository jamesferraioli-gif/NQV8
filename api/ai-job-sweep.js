// api/ai-job-sweep.js
// Runs every minute via Vercel cron. The safety net under every paid AI job.
//
// Picks up anything stranded:
//   pending too long   — the client died before calling ai-job-run
//   running too long    — the worker died mid-generation
//   failed, retries left— transient upstream error, try again
//   failed, exhausted   — refund the fee
//   refund owed         — a previous refund transaction itself failed
//
// Without this, a browser crash between payment and generation left the user
// charged with nothing to show and no path to recovery.

export const config = { maxDuration: 300 };

import { getKind } from './_aikinds.js';
import {
    jobsDb, jobRef, claimJob, completeJob, failJob, refundJob,
    MAX_ATTEMPTS, STALE_RUN_MS, STALE_PEND_MS
} from './_aijobs.js';
import { isRetryableAIError } from './_ai.js';

// Bounded so one sweep cannot run past its own ceiling.
const MAX_PER_SWEEP = 5;

function ageMs(value) {
    if (!value) return Infinity;
    const d = value.toDate ? value.toDate() : new Date(value);
    return Date.now() - d.getTime();
}

export default async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}` &&
        authHeader !== `Bearer ${process.env.INTERNAL_API_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const actions = [];

    try {
        const db = jobsDb();

        // ── 1. Refunds we still owe ───────────────────────────────────────
        // Highest priority: a failed job whose refund transaction did not go
        // through is money owed to a user.
        const owed = await db.collection('aiJobs')
            .where('status', '==', 'failed')
            .limit(MAX_PER_SWEEP)
            .get();

        for (const doc of owed.docs) {
            const job = doc.data();
            if (job.refundTxHash || job.refundPending) continue;
            try {
                const tx = await refundJob(doc.id);
                actions.push({ jobId: doc.id, action: 'refunded', txHash: tx });
            } catch (e) {
                actions.push({ jobId: doc.id, action: 'refund-failed', error: e.message });
            }
        }

        // ── 2. Stranded work ──────────────────────────────────────────────
        const open = await db.collection('aiJobs')
            .where('status', 'in', ['pending', 'running'])
            .limit(25)
            .get();

        let ran = 0;

        for (const doc of open.docs) {
            if (ran >= MAX_PER_SWEEP) break;
            const job = doc.data();

            const stale = job.status === 'running'
                ? ageMs(job.startedAt) > STALE_RUN_MS
                : ageMs(job.createdAt) > STALE_PEND_MS && ageMs(job.finishedAt) > STALE_PEND_MS;
            if (!stale) continue;

            // Cannot be retried without its input — refund instead of leaving
            // it stuck pending forever.
            if (!job.retryable) {
                await failJob(doc.id, job.error || 'Worker died and this job kind cannot be retried', { terminal: true });
                actions.push({ jobId: doc.id, action: 'terminal-no-retry' });
                continue;
            }

            if ((job.attempts || 0) >= MAX_ATTEMPTS) {
                await failJob(doc.id, job.error || `Gave up after ${MAX_ATTEMPTS} attempts`, { terminal: true });
                actions.push({ jobId: doc.id, action: 'terminal-exhausted' });
                continue;
            }

            const spec = getKind(job.kind);
            if (!spec || typeof spec.run !== 'function') {
                await failJob(doc.id, `No runner registered for ${job.kind}`, { terminal: true });
                actions.push({ jobId: doc.id, action: 'terminal-no-runner' });
                continue;
            }

            const claimed = await claimJob(doc.id);
            if (!claimed) continue; // someone else got it

            ran++;
            try {
                const result = await spec.run(claimed.input || {});
                await completeJob(doc.id, result);
                actions.push({ jobId: doc.id, action: 'completed', attempt: claimed.attempts });
            } catch (e) {
                const terminal = !isRetryableAIError(e.message);
                await failJob(doc.id, e.message, { terminal });
                actions.push({
                    jobId: doc.id,
                    action: terminal ? 'terminal-error' : 'retry-scheduled',
                    error: e.message
                });
            }
        }

        if (actions.length) console.log(`🧹 ai-job-sweep: ${JSON.stringify(actions)}`);
        return res.status(200).json({ success: true, processed: actions.length, actions });

    } catch (e) {
        console.error('ai-job-sweep fatal:', e.message);
        return res.status(500).json({ error: e.message, processed: actions.length, actions });
    }
}

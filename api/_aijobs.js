// api/_aijobs.js
// Lifecycle for paid AI jobs.
//
// Why this exists: a paid AI call used to be a single HTTP request. If it timed
// out, hit a rate limit, or the function died, the NQV8 was already spent and
// the single-use voucher already burned — the user paid and got nothing, with
// no way to retry. Two such losses happened in testing (500 NQV8 each) before
// anyone outside the team had touched it.
//
// Now the payment creates a durable record first. The job survives the request
// that started it, the sweep cron picks up anything stranded, and a job that
// genuinely cannot be completed refunds the fee.
//
// The job id IS the fee transaction hash. That ties payment to work one-to-one,
// makes creation idempotent (a replayed request finds the existing job instead
// of starting a second generation), and matches what the voucher already binds.

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { ethers } from 'ethers';
import { getKind } from './_aikinds.js';
import { gasOverrides } from './_gas.js';

const NQV8_ADDRESS = '0x02b3EF81d6577507114BB26F91F1a8d0A7bB1B67';
const ARBITRUM_RPC = 'https://arb1.arbitrum.io/rpc';
const ERC20_ABI    = ['function transfer(address to, uint256 amount) returns (bool)',
                      'function balanceOf(address owner) view returns (uint256)'];

export const MAX_ATTEMPTS   = 3;
// A worker that has held a job longer than this is assumed dead. Comfortably
// above the 300s function ceiling so a slow-but-alive run is never stolen.
export const STALE_RUN_MS   = 6 * 60 * 1000;
// Grace before the sweep adopts a pending job, so it does not race the client
// that is about to call ai-job-run itself.
export const STALE_PEND_MS  = 60 * 1000;

function db() {
    if (!getApps().length) {
        initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    }
    return getFirestore();
}

export function jobRef(jobId) {
    return db().collection('aiJobs').doc(String(jobId).toLowerCase());
}

/**
 * Create the job record, or return the existing one.
 * Idempotent on jobId (the fee txHash).
 */
export async function createJob({ jobId, kind, uid, wallet, input }) {
    const spec = getKind(kind);
    if (!spec) throw new Error(`Unknown job kind: ${kind}`);

    const ref      = jobRef(jobId);
    const existing = await ref.get();
    if (existing.exists) return { job: { id: ref.id, ...existing.data() }, created: false };

    const record = {
        kind,
        uid:        uid || null,
        wallet:     wallet ? String(wallet).toLowerCase() : null,
        status:     'pending',
        // Only persisted when the kind says the payload is small enough.
        // Without it the sweep cannot retry, so it refunds instead.
        input:      spec.storeInput ? (input || {}) : null,
        retryable:  !!spec.storeInput,
        priceNQV8:  spec.priceNQV8,
        result:     null,
        error:      null,
        attempts:   0,
        createdAt:  new Date(),
        startedAt:  null,
        finishedAt: null,
        refundTxHash: null
    };

    try {
        await ref.create(record);
    } catch (raceErr) {
        // Another request created it between our read and write.
        const now = await ref.get();
        return { job: { id: ref.id, ...now.data() }, created: false };
    }
    return { job: { id: ref.id, ...record }, created: true };
}

/**
 * Take ownership of a job for this invocation.
 * Returns null when another worker holds it or it is already finished —
 * two workers must never run the same paid generation twice.
 */
export async function claimJob(jobId) {
    const ref = jobRef(jobId);
    return db().runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return null;
        const job = snap.data();

        if (job.status === 'done' || job.status === 'refunded') return null;
        if (job.status === 'running') {
            const started = job.startedAt?.toDate ? job.startedAt.toDate() : new Date(job.startedAt || 0);
            if (Date.now() - started.getTime() < STALE_RUN_MS) return null; // alive
        }
        if (job.attempts >= MAX_ATTEMPTS) return null;

        const attempts = (job.attempts || 0) + 1;
        tx.update(ref, { status: 'running', startedAt: new Date(), attempts });
        return { id: ref.id, ...job, attempts, status: 'running' };
    });
}

export async function completeJob(jobId, result) {
    await jobRef(jobId).update({
        status: 'done', result, error: null, finishedAt: new Date()
    });
}

/**
 * Record a failure. Marks the job retryable or terminal, and refunds the fee
 * once it is terminal — a user never pays for work that cannot be delivered.
 */
export async function failJob(jobId, message, { terminal = false } = {}) {
    const ref  = jobRef(jobId);
    const snap = await ref.get();
    if (!snap.exists) return;
    const job = snap.data();

    const exhausted = terminal || (job.attempts || 0) >= MAX_ATTEMPTS || !job.retryable;

    await ref.update({
        status:     exhausted ? 'failed' : 'pending',
        error:      String(message || 'Unknown error').slice(0, 500),
        finishedAt: exhausted ? new Date() : null
    });

    if (exhausted) await refundJob(jobId).catch(e => console.error('refund failed:', e.message));
}

/**
 * Return the fee to the payer. Idempotent via refundTxHash, and guarded by a
 * transaction so two sweeps cannot both pay out.
 */
export async function refundJob(jobId) {
    const ref = jobRef(jobId);

    const claimed = await db().runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return null;
        const job = snap.data();
        if (job.refundTxHash || job.status === 'refunded') return null;
        if (!job.wallet || !job.priceNQV8) return null;
        tx.update(ref, { refundPending: true });
        return { wallet: job.wallet, amount: job.priceNQV8, kind: job.kind };
    });
    if (!claimed) return null;

    try {
        const provider = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
        const signer   = new ethers.Wallet(process.env.OPERATIONS_PRIVATE_KEY, provider);
        const nqv8     = new ethers.Contract(NQV8_ADDRESS, ERC20_ABI, signer);
        const amountRaw = ethers.utils.parseUnits(String(claimed.amount), 18);

        const balance = await nqv8.balanceOf(await signer.getAddress());
        if (balance.lt(amountRaw)) {
            throw new Error(`Operations wallet has insufficient NQV8 to refund ${claimed.amount}`);
        }

        const tx = await nqv8.transfer(claimed.wallet, amountRaw, await gasOverrides(provider));
        await tx.wait();

        await ref.update({
            status: 'refunded', refundTxHash: tx.hash,
            refundedAt: new Date(), refundPending: false
        });
        console.log(`💸 Refunded ${claimed.amount} NQV8 to ${claimed.wallet} for failed ${claimed.kind} (${tx.hash})`);
        return tx.hash;
    } catch (e) {
        // Leave the job failed-and-unrefunded so the next sweep retries the
        // payout. Never swallow this — an unpaid refund is money we owe.
        await ref.update({ refundPending: false, refundError: String(e.message).slice(0, 300) }).catch(() => {});
        throw e;
    }
}

export { db as jobsDb };

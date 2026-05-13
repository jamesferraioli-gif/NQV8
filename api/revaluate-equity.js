// api/revaluate-equity.js
// Runs daily at midnight via Vercel cron.
// Revaluates all verified projects that have had activity in the last 30 days.
// Skips dormant projects to keep costs low.

import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore }           from 'firebase-admin/firestore';
import { credential }             from 'firebase-admin';

if (!getApps().length) {
    initializeApp({
        credential: credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
}
const db = getFirestore();

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export default async function handler(req, res) {
    if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        // Get all verified projects
        const companiesSnap = await db.collection('companies')
            .where('verificationStatus', '==', 'verified')
            .where('equityRegistered', '==', true)
            .get();

        const projects    = companiesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        const now         = Date.now();
        let processed     = 0;
        let skipped       = 0;
        let errors        = 0;
        const results     = [];

        for (const project of projects) {
            try {
                // Check if project has had any activity in last 30 days
                const lastActivity = await getLastActivityTimestamp(project.id);
                const isActive     = (now - lastActivity) < THIRTY_DAYS_MS;

                if (!isActive) {
                    skipped++;
                    continue;
                }

                // Call the valuation endpoint with forceRefresh
                const response = await fetch(`${process.env.VERCEL_URL}/api/valuate-equity`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ projectId: project.id, forceRefresh: true })
                });

                if (response.ok) {
                    const valuation = await response.json();
                    results.push({
                        projectId:  project.id,
                        name:       project.name,
                        midValue:   valuation.valuationRange?.mid,
                        confidence: valuation.confidence
                    });
                    processed++;
                } else {
                    errors++;
                }

                // Small delay between calls to avoid rate limiting
                await new Promise(r => setTimeout(r, 500));

            } catch(e) {
                console.error(`Failed to valuate ${project.id}:`, e.message);
                errors++;
            }
        }

        console.log(`Daily revaluation complete: ${processed} processed, ${skipped} skipped (dormant), ${errors} errors`);

        return res.json({
            success:   true,
            total:     projects.length,
            processed,
            skipped,
            errors,
            results
        });

    } catch(e) {
        console.error('revaluate-equity cron failed:', e.message);
        return res.status(500).json({ error: e.message });
    }
}

async function getLastActivityTimestamp(projectId) {
    const now = Date.now();

    try {
        // Check last equity valuation cache update
        const valuationDoc = await db.collection('equityValuations').doc(projectId).get();
        if (valuationDoc.exists && valuationDoc.data().cachedAt) {
            const cachedAt = valuationDoc.data().cachedAt;
            if ((now - cachedAt) < 30 * 24 * 60 * 60 * 1000) return cachedAt;
        }

        // Check last metrics update in Firestore
        const companyDoc = await db.collection('companies').doc(projectId).get();
        if (companyDoc.exists) {
            const statsUpdatedAt = companyDoc.data().statsUpdatedAt;
            if (statsUpdatedAt) {
                const statsTs = new Date(statsUpdatedAt).getTime();
                if ((now - statsTs) < 30 * 24 * 60 * 60 * 1000) return statsTs;
            }
        }

        // Check last subproject activity
        const subSnap = await db.collection('subprojects')
            .where('companyId', '==', projectId)
            .orderBy('createdAt', 'desc')
            .limit(1)
            .get();

        if (!subSnap.empty) {
            const lastSubproject = subSnap.docs[0].data();
            const subTs = lastSubproject.createdAt?.toMillis?.() || 0;
            if ((now - subTs) < 30 * 24 * 60 * 60 * 1000) return subTs;
        }

        // No recent activity found
        return 0;
    } catch(e) {
        return 0;
    }
}

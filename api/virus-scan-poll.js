// api/virus-scan-poll.js
// Runs every 5 minutes via Vercel cron.
// Finds all submissions with virusScanStatus: 'pending' and analysis IDs saved.
// Polls VirusTotal for results, updates Firestore status.

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (!getApps().length) {
    initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
const db = getFirestore();

const VIRUSTOTAL_API_KEY = process.env.VIRUSTOTAL_API_KEY;

export default async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}` &&
        authHeader !== `Bearer ${process.env.INTERNAL_API_SECRET}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!VIRUSTOTAL_API_KEY) {
        return res.status(200).json({ success: true, message: 'No VT API key configured' });
    }

    try {
        // Find all in-progress projects with pending virus scans
        const snap = await db.collection('subprojects')
            .where('status', 'in', ['in-progress', 'completed'])
            .get();

        const results = [];

        for (const doc of snap.docs) {
            const project     = doc.data();
            const submissions = project.submissions || [];

            for (let idx = 0; idx < submissions.length; idx++) {
                const sub = submissions[idx];
                if (sub.virusScanStatus !== 'pending') continue;
                if (!sub.virusScanIds || sub.virusScanIds.length === 0) continue;

                try {
                    const scanResults = [];
                    let allComplete   = true;

                    for (const { name, analysisId } of sub.virusScanIds) {
                        const analysisRes  = await fetch(`https://www.virustotal.com/api/v3/analyses/${analysisId}`, {
                            headers: { 'x-apikey': VIRUSTOTAL_API_KEY }
                        });
                        const analysisData = await analysisRes.json();
                        const status       = analysisData.data?.attributes?.status;

                        if (status === 'completed') {
                            const stats = analysisData.data.attributes.stats;
                            scanResults.push({
                                name,
                                malicious:  stats.malicious  || 0,
                                suspicious: stats.suspicious || 0,
                                harmless:   stats.harmless   || 0,
                                undetected: stats.undetected || 0
                            });
                        } else {
                            // Not done yet — skip this submission for now
                            allComplete = false;
                            break;
                        }
                    }

                    if (!allComplete) continue;

                    // All files scanned — update status
                    const malicious   = scanResults.filter(r => r.malicious > 0);
                    const finalStatus = malicious.length > 0 ? 'flagged' : 'clean';

                    submissions[idx].virusScanStatus  = finalStatus;
                    submissions[idx].virusScanResults = scanResults;
                    submissions[idx].virusScanAt      = new Date();

                    await db.collection('subprojects').doc(doc.id).update({ submissions });

                    if (finalStatus === 'flagged') {
                        console.error('🚨 VIRUSTOTAL FLAGGED', {
                            projectId: doc.id,
                            flaggedFiles: malicious.map(r => `${r.name} (${r.malicious} engines)`).join(', '),
                            timestamp: new Date().toISOString()
                        });

                        // Notify poster
                        const posterUid = project.ownerUid || project.posterUid;
                        if (posterUid) {
                            await db.collection('notifications').add({
                                recipientUid: posterUid,
                                type:         'security_flag',
                                message:      `⚠️ Security scan flagged files in a submission on "${project.title}". Review before accepting.`,
                                projectId:    doc.id,
                                read:         false,
                                createdAt:    new Date()
                            });
                        }
                    } else {
                        console.log(`✅ VT scan clean: ${doc.id} submission ${idx}`);
                    }

                    results.push({ projectId: doc.id, submissionIndex: idx, status: finalStatus });

                } catch(e) {
                    console.error(`VT poll error for ${doc.id} sub ${idx}:`, e.message);
                    results.push({ projectId: doc.id, submissionIndex: idx, status: 'error', error: e.message });
                }
            }
        }

        console.log(`✅ virus-scan-poll complete. Processed ${results.length} submissions.`);
        return res.status(200).json({ success: true, processed: results.length, results });

    } catch(e) {
        console.error('virus-scan-poll fatal error:', e.message);
        return res.status(500).json({ error: e.message });
    }
}

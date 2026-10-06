// api/virus-scan.js
// Step 1: Upload files to VirusTotal, save analysis IDs to Firestore.
// Returns immediately — polling handled by virus-scan-poll.js cron.

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (!getApps().length) {
    initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
const db = getFirestore();

const VIRUSTOTAL_API_KEY = process.env.VIRUSTOTAL_API_KEY;

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { projectId, submissionIndex, attachments = [] } = req.body;
    if (!projectId) return res.status(400).json({ error: 'Missing projectId' });

    try {
        // No API key or no files — mark clean immediately
        if (!VIRUSTOTAL_API_KEY || attachments.length === 0) {
            await updateSubmission(projectId, submissionIndex, { virusScanStatus: 'clean', virusScanAt: new Date() });
            return res.status(200).json({ success: true, status: 'clean' });
        }

        // Upload each file to VirusTotal — fast, just gets analysis ID back
        const analysisIds = [];
        for (const attachment of attachments) {
            try {
                const analysisId = await uploadToVirusTotal(attachment);
                analysisIds.push({ name: attachment.name, analysisId });
            } catch(e) {
                console.warn('VT upload failed for', attachment.name, e.message);
            }
        }

        // Save analysis IDs to Firestore — poll cron will check results
        await updateSubmission(projectId, submissionIndex, {
            virusScanStatus:  'pending',
            virusScanIds:     analysisIds,
            virusScanAt:      new Date()
        });

        console.log(`✅ Uploaded ${analysisIds.length} files to VirusTotal for project ${projectId}`);
        return res.status(200).json({ success: true, status: 'pending', analysisIds });

    } catch(e) {
        console.error('virus-scan error:', e.message);
        await updateSubmission(projectId, submissionIndex, { virusScanStatus: 'error' }).catch(() => {});
        return res.status(500).json({ error: e.message });
    }
}

async function uploadToVirusTotal(attachment) {
    const fileBuffer = Buffer.from(attachment.base64, 'base64');
    const formData   = new FormData();
    const blob       = new Blob([fileBuffer], { type: attachment.type || 'application/octet-stream' });
    formData.append('file', blob, attachment.name);

    const uploadRes = await fetch('https://www.virustotal.com/api/v3/files', {
        method: 'POST',
        headers: { 'x-apikey': VIRUSTOTAL_API_KEY },
        body: formData
    });

    if (!uploadRes.ok) throw new Error(`VT upload failed: ${uploadRes.status}`);
    const data = await uploadRes.json();
    const id   = data.data?.id;
    if (!id) throw new Error('No analysis ID returned');
    return id;
}

async function updateSubmission(projectId, submissionIndex, fields) {
    const projectRef  = db.collection('subprojects').doc(projectId);
    const snap        = await projectRef.get();
    if (!snap.exists) return;

    const submissions = snap.data().submissions || [];
    const idx = submissionIndex !== null && submissionIndex !== undefined
        ? submissionIndex
        : submissions.length - 1;

    if (submissions[idx]) {
        Object.assign(submissions[idx], fields);
        await projectRef.update({ submissions });
    }
}

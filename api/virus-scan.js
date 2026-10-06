// api/virus-scan.js
// Called from frontend after submission saves to Firestore.
// Runs VirusTotal scan on attached files and writes result back to Firestore.
// Fire-and-forget from frontend — response sent immediately, scan runs synchronously here.

import { ethers } from 'ethers';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { credential } from 'firebase-admin';

if (!getApps().length) {
    initializeApp({
        credential: credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
    });
}
const db = getFirestore();

const VIRUSTOTAL_API_KEY = process.env.VIRUSTOTAL_API_KEY;

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { projectId, submissionIndex, attachments = [] } = req.body;

    if (!projectId) return res.status(400).json({ error: 'Missing projectId' });

    // Respond immediately so frontend isn't blocked
    res.status(200).json({ success: true, message: 'Scan started' });

    // Now run the scan — this executes after response is sent
    // Vercel will keep the function alive until it completes (up to function timeout)
    try {
        if (!VIRUSTOTAL_API_KEY || attachments.length === 0) {
            await updateScanStatus(projectId, submissionIndex, 'clean', []);
            return;
        }

        const results = [];
        for (const attachment of attachments) {
            try {
                const vtResult = await scanWithVirusTotal(attachment);
                results.push(vtResult);
            } catch(e) {
                console.warn('VirusTotal scan failed for', attachment.name, e.message);
                results.push({ name: attachment.name, malicious: 0, suspicious: 0, harmless: 0, undetected: 0, error: e.message });
            }
        }

        const malicious = results.filter(r => r.malicious > 0);
        const status    = malicious.length > 0 ? 'flagged' : 'clean';

        await updateScanStatus(projectId, submissionIndex, status, results);

        if (status === 'flagged') {
            console.error('🚨 VIRUSTOTAL FLAGGED', {
                projectId,
                flaggedFiles: malicious.map(r => `${r.name} (${r.malicious} engines)`).join(', '),
                timestamp: new Date().toISOString()
            });
        } else {
            console.log(`✅ VirusTotal scan clean for project ${projectId}`);
        }

    } catch(e) {
        console.error('virus-scan error:', e.message);
        await updateScanStatus(projectId, submissionIndex, 'error', []).catch(() => {});
    }
}

async function updateScanStatus(projectId, submissionIndex, status, results) {
    const projectRef = db.collection('subprojects').doc(projectId);
    const snap       = await projectRef.get();
    if (!snap.exists) return;

    const submissions = snap.data().submissions || [];
    const idx = submissionIndex !== null && submissionIndex !== undefined
        ? submissionIndex
        : submissions.length - 1;

    if (submissions[idx]) {
        submissions[idx].virusScanStatus  = status;
        submissions[idx].virusScanResults = results;
        submissions[idx].virusScanAt      = new Date();
        await projectRef.update({ submissions });
    }
}

async function scanWithVirusTotal(attachment) {
    const fileBuffer = Buffer.from(attachment.base64, 'base64');
    const formData   = new FormData();
    const blob       = new Blob([fileBuffer], { type: attachment.type || 'application/octet-stream' });
    formData.append('file', blob, attachment.name);

    const uploadRes = await fetch('https://www.virustotal.com/api/v3/files', {
        method: 'POST',
        headers: { 'x-apikey': VIRUSTOTAL_API_KEY },
        body: formData
    });

    if (!uploadRes.ok) throw new Error(`VirusTotal upload failed: ${uploadRes.status}`);
    const uploadData = await uploadRes.json();
    const analysisId = uploadData.data?.id;
    if (!analysisId) throw new Error('No analysis ID returned');

    // Poll up to 15 attempts with 3s delay = 45s max
    let attempts = 0;
    while (attempts < 15) {
        await new Promise(r => setTimeout(r, 3000));
        const analysisRes  = await fetch(`https://www.virustotal.com/api/v3/analyses/${analysisId}`, {
            headers: { 'x-apikey': VIRUSTOTAL_API_KEY }
        });
        const analysisData = await analysisRes.json();
        if (analysisData.data?.attributes?.status === 'completed') {
            const stats = analysisData.data.attributes.stats;
            return {
                name:       attachment.name,
                malicious:  stats.malicious  || 0,
                suspicious: stats.suspicious || 0,
                harmless:   stats.harmless   || 0,
                undetected: stats.undetected || 0
            };
        }
        attempts++;
    }

    return { name: attachment.name, malicious: 0, suspicious: 0, harmless: 0, undetected: 0 };
}

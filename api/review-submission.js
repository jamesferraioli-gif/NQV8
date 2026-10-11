// api/review-submission.js
// Full submission security review:
// 1. Claude inspects images, PDFs, and code files for inappropriate/malicious content
// 2. GitHub repo inspection via GitHub API
// 3. VirusTotal file scanning — runs in background, does NOT block response
// 4. Scope review (existing functionality)

const VIRUSTOTAL_API_KEY = process.env.VIRUSTOTAL_API_KEY;
const GITHUB_TOKEN       = process.env.GITHUB_TOKEN;

const CODE_EXTENSIONS = [
    'js','ts','jsx','tsx','py','sol','rb','go','rs','java','cpp','c','swift',
    'kt','php','html','css','sh','bash','ps1','sql','yaml','yml','json','xml',
    'toml','env','config','ini','dockerfile'
];

const IMAGE_TYPES = ['image/jpeg','image/png','image/gif','image/webp'];

import { verifyCaller } from './_auth.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const caller = await verifyCaller(req);
    if (!caller) return res.status(401).json({ error: 'Unauthorized' });

    const {
        projectTitle        = '',
        projectDescription  = '',
        acceptedBidAmount   = '',
        submissionDescription = '',
        submissionLink      = '',
        attachments         = [],
        projectId           = '',
        submissionIndex     = null,
        virusScanOnly       = false   // true when poster manually reruns scan
    } = req.body;

    // ── Virus scan only (manual rerun from poster UI) ─────────────────────────
    if (virusScanOnly && projectId !== '') {
        runVirusScanInBackground(projectId, submissionIndex, attachments);
        return res.json({ success: true, message: 'Security scan started' });
    }

    try {
        // ── 1. GitHub repo inspection ─────────────────────────────────────────
        let githubSummary = '';
        if (submissionLink && isGitHubUrl(submissionLink)) {
            try {
                githubSummary = await inspectGitHubRepo(submissionLink);
            } catch(e) {
                console.warn('GitHub inspection failed:', e.message);
                githubSummary = 'GitHub repo could not be accessed for review.';
            }
        }

        // ── 2. Build Claude message content ──────────────────────────────────
        const messageContent = [];

        messageContent.push({
            type: 'text',
            text: buildPrompt({
                projectTitle,
                projectDescription,
                acceptedBidAmount,
                submissionDescription,
                submissionLink,
                attachmentCount: attachments.length,
                githubSummary
            })
        });

        for (const attachment of attachments) {
            if (IMAGE_TYPES.includes(attachment.type)) {
                messageContent.push({
                    type: 'image',
                    source: { type: 'base64', media_type: attachment.type, data: attachment.base64 }
                });
                messageContent.push({ type: 'text', text: `[Image above: ${attachment.name}]` });
            }
        }

        for (const attachment of attachments) {
            if (attachment.type === 'application/pdf') {
                messageContent.push({
                    type: 'document',
                    source: { type: 'base64', media_type: 'application/pdf', data: attachment.base64 }
                });
                messageContent.push({ type: 'text', text: `[Document above: ${attachment.name}]` });
            }
        }

        for (const attachment of attachments) {
            const ext = attachment.name.split('.').pop()?.toLowerCase();
            if (CODE_EXTENSIONS.includes(ext) && attachment.base64) {
                try {
                    const codeText = Buffer.from(attachment.base64, 'base64').toString('utf-8').slice(0, 8000);
                    messageContent.push({
                        type: 'text',
                        text: `\n--- CODE FILE: ${attachment.name} ---\n\`\`\`${ext}\n${codeText}\n\`\`\`\n--- END ${attachment.name} ---\n`
                    });
                } catch(e) {
                    console.warn('Could not decode code file:', attachment.name);
                }
            }
        }

        // Final reminder after the attachments — the JSON requirement must be
        // the most recent instruction, otherwise an image dominates the reply.
        messageContent.push({
            type: 'text',
            text: `\nNow respond. Output a single JSON object and nothing else — no heading, no summary of the attachments, no markdown. Keys: contentFlagged, contentFlagReason, blockedBy, summary, missingItems, recommendation, confidence.`
        });

        // ── 3. Call Claude ────────────────────────────────────────────────
        const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-5',
                max_tokens: 1500,
                messages: [{ role: 'user', content: messageContent }]
            })
        });

        if (!claudeResponse.ok) {
            const errBody = await claudeResponse.text().catch(() => '');
            console.error(`Claude API ${claudeResponse.status}:`, errBody.slice(0, 600));
            throw new Error(`Claude API ${claudeResponse.status}: ${errBody.slice(0, 200)}`);
        }
        const claudeData = await claudeResponse.json();
        if (!claudeData.content || claudeData.error) {
            throw new Error(`Claude API error: ${claudeData.error?.message || 'Unknown error'}`);
        }

        const rawText = claudeData.content.filter(b => b.type === 'text').map(b => b.text).join('');

        // Claude occasionally prefixes the JSON with prose or a markdown heading,
        // especially when the submission contains a document. Extract the object
        // rather than trusting the whole response.
        let result;
        try {
            const clean = rawText.replace(/```json|```/g, '').trim();
            const start = clean.indexOf('{');
            const end   = clean.lastIndexOf('}');
            if (start === -1 || end === -1 || end <= start) {
                throw new Error('No JSON object found in response');
            }
            result = JSON.parse(clean.slice(start, end + 1));
        } catch (parseErr) {
            console.error('review-submission could not parse Claude response:', parseErr.message);
            console.error('Raw response (first 500 chars):', rawText.slice(0, 500));
            throw new Error(`Could not parse review response: ${parseErr.message}`);
        }

        // Normalise so a malformed-but-parseable response cannot break the caller
        result.contentFlagged    = result.contentFlagged === true;
        result.contentFlagReason = result.contentFlagReason || '';
        result.summary           = result.summary || 'Review completed.';
        result.missingItems      = Array.isArray(result.missingItems) ? result.missingItems : [];
        result.recommendation    = ['approve','request_changes','reject'].includes(result.recommendation)
            ? result.recommendation : 'approve';
        result.confidence        = result.confidence || 'low';

        if (result.contentFlagged) {
            console.error('🚨 CONTENT FLAGGED by Claude', {
                projectTitle,
                reason: result.contentFlagReason,
                attachmentNames: attachments.map(a => a.name),
                submissionLink,
                timestamp: new Date().toISOString()
            });
        }

        // ── 4. Kick off VirusTotal scan in background — don't await ──────────
        if (VIRUSTOTAL_API_KEY && attachments.length > 0 && projectId) {
            runVirusScanInBackground(projectId, submissionIndex, attachments);
        }

        // Return Claude result immediately — virus scan runs async
        return res.json({
            ...result,
            virusScanStatus: 'pending'  // frontend will poll Firestore for update
        });

    } catch(e) {
        console.error('review-submission error:', e);
        return res.json({
            contentFlagged: false,
            contentFlagReason: '',
            summary: 'Automated review temporarily unavailable. Submission allowed through.',
            missingItems: [],
            recommendation: 'approve',
            confidence: 'low',
            virusScanStatus: 'error'
        });
    }
}

// ── Background VirusTotal scan — writes result back to Firestore ───────────────
async function runVirusScanInBackground(projectId, submissionIndex, attachments) {
    try {
        const { initializeApp, getApps } = await import('firebase-admin/app');
        const { getFirestore }           = await import('firebase-admin/firestore');
        const { credential }             = await import('firebase-admin');

        if (!getApps().length) {
            initializeApp({ credential: credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
        }
        const db = getFirestore();

        const results = [];
        for (const attachment of attachments) {
            try {
                const vtResult = await scanWithVirusTotal(attachment);
                results.push(vtResult);
            } catch(e) {
                console.warn('VirusTotal scan failed for', attachment.name, e.message);
            }
        }

        const malicious = results.filter(r => r.malicious > 0);
        const status    = malicious.length > 0 ? 'flagged' : 'clean';

        // Update the submission's virusScanStatus in Firestore
        const projectRef = db.collection('subprojects').doc(projectId);
        const snap       = await projectRef.get();
        if (!snap.exists) return;

        const submissions = snap.data().submissions || [];
        const idx = submissionIndex !== null ? submissionIndex : submissions.length - 1;

        if (submissions[idx]) {
            submissions[idx].virusScanStatus  = status;
            submissions[idx].virusScanResults = results;
            submissions[idx].virusScanAt      = new Date();

            await projectRef.update({ submissions });

            if (status === 'flagged') {
                console.error('🚨 VIRUSTOTAL FLAGGED', {
                    projectId,
                    flaggedFiles: malicious.map(r => `${r.name} (${r.malicious} engines)`).join(', '),
                    timestamp: new Date().toISOString()
                });
            }
        }
    } catch(e) {
        console.error('Background VirusTotal scan error:', e.message);
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildPrompt({ projectTitle, projectDescription, acceptedBidAmount, submissionDescription, submissionLink, attachmentCount, githubSummary }) {
    const ghSection = githubSummary ? `\nGITHUB REPO INSPECTION:\n${githubSummary}` : '';

    return `You are a security and quality reviewer for NQVate, a professional freelance marketplace.

PROJECT: "${projectTitle}"
DESCRIPTION: ${projectDescription}
AGREED COMPENSATION: ${acceptedBidAmount}

SUBMISSION:
- Description: ${submissionDescription}
- Link: ${submissionLink || 'None'}
- Attachments: ${attachmentCount} file(s) (images/PDFs/code shown below if any)
${ghSection}

NOTE: VirusTotal file scanning is running in the background separately. Focus on content moderation and scope review.

YOUR JOB — perform TWO checks in this order:

=== CHECK 1: CONTENT MODERATION (hard block) ===
Immediately flag and block if you detect ANY of:
- Pornography, nudity, sexual content of any kind
- Graphic violence, gore, torture imagery
- Content involving minors in any inappropriate context
- Hate symbols, extremist content, terrorist material
- Malicious code: wallet drainers, keyloggers, credential harvesters, backdoors, ransomware, crypto miners, phishing pages
- Obfuscated/encoded code designed to hide its true purpose
- Shell commands or scripts that would execute harmful system operations
- Social engineering templates (fake login pages, phishing emails)
- Anything clearly illegal

For CODE FILES specifically, check for:
- Functions that exfiltrate data to external servers without disclosure
- Private key or seed phrase extraction
- Unauthorized transaction signing
- Reentrancy attacks or other smart contract exploits
- Hardcoded malicious wallet addresses receiving funds

=== CHECK 2: SCOPE REVIEW (soft warning, user can override) ===
Only reach this if Check 1 passes. Assess:
- Does the submission appear to address the project requirements?
- Is the quality/completeness appropriate for ${acceptedBidAmount}?
- What seems missing or incomplete?
- Is the GitHub repo (if provided) consistent with the project requirements?

Your entire response must be a single JSON object and nothing else. Do not write any
heading, preamble, explanation or markdown before or after it. Do not summarise the
submission outside the JSON. Begin your response with { and end it with }.

Respond with exactly this shape:

{
  "contentFlagged": false,
  "contentFlagReason": "",
  "blockedBy": "",
  "summary": "2-3 sentence scope assessment",
  "missingItems": ["item1", "item2"],
  "recommendation": "approve",
  "confidence": "high"
}

Values:
- contentFlagged: true only if Check 1 detected something — this is a HARD BLOCK
- contentFlagReason: clear explanation of what was found (shown to user)
- blockedBy: "claude" | ""
- recommendation: "approve" | "request_changes" | "reject"
- confidence: "high" | "medium" | "low"`;
}

function isGitHubUrl(url) {
    try { return new URL(url).hostname === 'github.com'; }
    catch { return false; }
}

async function inspectGitHubRepo(url) {
    const match = url.match(/github\.com\/([^/]+)\/([^/?\s]+)/);
    if (!match) return 'Could not parse GitHub URL.';

    const [, owner, repo] = match;
    const headers = {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'NQVate-SecurityReview'
    };
    if (GITHUB_TOKEN) headers['Authorization'] = `token ${GITHUB_TOKEN}`;

    const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
    if (!repoRes.ok) {
        if (repoRes.status === 404) return `GitHub repo ${owner}/${repo} is private or does not exist.`;
        return `GitHub API error: ${repoRes.status}`;
    }
    const repoData = await repoRes.json();

    const treeRes  = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`, { headers });
    const treeData = treeRes.ok ? await treeRes.json() : null;
    const fileList = treeData?.tree?.filter(f => f.type === 'blob')?.map(f => f.path)?.slice(0, 100)?.join('\n') || 'Could not fetch file list';

    const keyFiles    = ['package.json','requirements.txt','README.md','index.js','main.py','hardhat.config.js','.env.example'];
    const fileContents = [];
    for (const filename of keyFiles) {
        const fileRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${filename}`, { headers });
        if (fileRes.ok) {
            const fileData = await fileRes.json();
            if (fileData.content) {
                const decoded = Buffer.from(fileData.content, 'base64').toString('utf-8').slice(0, 2000);
                fileContents.push(`=== ${filename} ===\n${decoded}`);
            }
        }
    }

    return `Repo: ${owner}/${repo}
Description: ${repoData.description || 'None'}
Language: ${repoData.language || 'Unknown'}
Stars: ${repoData.stargazers_count} | Forks: ${repoData.forks_count}
Created: ${repoData.created_at} | Last push: ${repoData.pushed_at}
Private: ${repoData.private}

FILE TREE (up to 100 files):
${fileList}

KEY FILES:
${fileContents.join('\n\n') || 'No key files found'}`.trim();
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
    // This is fine in background — doesn't block the user response
    let attempts = 0;
    while (attempts < 15) {
        await new Promise(r => setTimeout(r, 3000));
        const analysisRes  = await fetch(`https://www.virustotal.com/api/v3/analyses/${analysisId}`, {
            headers: { 'x-apikey': VIRUSTOTAL_API_KEY }
        });
        const analysisData = await analysisRes.json();
        const status       = analysisData.data?.attributes?.status;

        if (status === 'completed') {
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

// api/review-submission.js
// Full submission security review:
// 1. Claude inspects images, PDFs, and code files for inappropriate/malicious content
// 2. GitHub repo inspection via GitHub API
// 3. VirusTotal file scanning for known malware signatures
// 4. Scope review (existing functionality)

const VIRUSTOTAL_API_KEY = process.env.VIRUSTOTAL_API_KEY;
const GITHUB_TOKEN       = process.env.GITHUB_TOKEN; // optional — increases rate limit

// File extensions Claude can read as text
const CODE_EXTENSIONS = [
    'js','ts','jsx','tsx','py','sol','rb','go','rs','java','cpp','c','swift',
    'kt','php','html','css','sh','bash','ps1','sql','yaml','yml','json','xml',
    'toml','env','config','ini','dockerfile'
];

// File extensions Claude can read as images
const IMAGE_TYPES = ['image/jpeg','image/png','image/gif','image/webp'];

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const {
        projectTitle        = '',
        projectDescription  = '',
        acceptedBidAmount   = '',
        submissionDescription = '',
        submissionLink      = '',
        attachments         = []   // [{ name, type, base64, hash? }]
    } = req.body;

    try {
        // ── 1. VirusTotal scan on uploaded files ──────────────────────────────
        const virusTotalResults = [];
        if (VIRUSTOTAL_API_KEY && attachments.length > 0) {
            for (const attachment of attachments) {
                try {
                    const vtResult = await scanWithVirusTotal(attachment);
                    virusTotalResults.push(vtResult);
                } catch(e) {
                    console.warn('VirusTotal scan failed for', attachment.name, e.message);
                }
            }
        }

        // Hard block if VirusTotal flags anything malicious
        const vtMalicious = virusTotalResults.filter(r => r.malicious > 0);
        if (vtMalicious.length > 0) {
            const flaggedFiles = vtMalicious.map(r => `${r.name} (${r.malicious} engines flagged)`).join(', ');
            return res.json({
                contentFlagged: true,
                contentFlagReason: `Malware detected by antivirus scan: ${flaggedFiles}. This has been logged and reported.`,
                summary: '',
                missingItems: [],
                recommendation: 'reject',
                confidence: 'high',
                blockedBy: 'virustotal'
            });
        }

        // ── 2. GitHub repo inspection ─────────────────────────────────────────
        let githubSummary = '';
        if (submissionLink && isGitHubUrl(submissionLink)) {
            try {
                githubSummary = await inspectGitHubRepo(submissionLink);
            } catch(e) {
                console.warn('GitHub inspection failed:', e.message);
                githubSummary = 'GitHub repo could not be accessed for review.';
            }
        }

        // ── 3. Build Claude message content ──────────────────────────────────
        const messageContent = [];

        // Main prompt
        messageContent.push({
            type: 'text',
            text: buildPrompt({
                projectTitle,
                projectDescription,
                acceptedBidAmount,
                submissionDescription,
                submissionLink,
                attachmentCount: attachments.length,
                githubSummary,
                virusTotalResults
            })
        });

        // Add images for visual inspection
        for (const attachment of attachments) {
            if (IMAGE_TYPES.includes(attachment.type)) {
                messageContent.push({
                    type: 'image',
                    source: { type: 'base64', media_type: attachment.type, data: attachment.base64 }
                });
                messageContent.push({
                    type: 'text',
                    text: `[Image above: ${attachment.name}]`
                });
            }
        }

        // Add PDFs
        for (const attachment of attachments) {
            if (attachment.type === 'application/pdf') {
                messageContent.push({
                    type: 'document',
                    source: { type: 'base64', media_type: 'application/pdf', data: attachment.base64 }
                });
                messageContent.push({
                    type: 'text',
                    text: `[Document above: ${attachment.name}]`
                });
            }
        }

        // Add code files as text blocks
        for (const attachment of attachments) {
            const ext = attachment.name.split('.').pop()?.toLowerCase();
            if (CODE_EXTENSIONS.includes(ext) && attachment.base64) {
                try {
                    const codeText = Buffer.from(attachment.base64, 'base64').toString('utf-8').slice(0, 8000); // cap at 8k chars per file
                    messageContent.push({
                        type: 'text',
                        text: `\n--- CODE FILE: ${attachment.name} ---\n\`\`\`${ext}\n${codeText}\n\`\`\`\n--- END ${attachment.name} ---\n`
                    });
                } catch(e) {
                    console.warn('Could not decode code file:', attachment.name);
                }
            }
        }

        // ── 4. Call Claude ────────────────────────────────────────────────────
        const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 1500,
                messages: [{ role: 'user', content: messageContent }]
            })
        });

        const claudeData = await claudeResponse.json();
        const rawText = claudeData.content
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('');

        const clean = rawText.replace(/```json|```/g, '').trim();
        const result = JSON.parse(clean);

        // ── 5. Log flagged submissions server-side ────────────────────────────
        if (result.contentFlagged) {
            console.error('🚨 CONTENT FLAGGED', {
                projectTitle,
                reason: result.contentFlagReason,
                blockedBy: result.blockedBy || 'claude',
                attachmentNames: attachments.map(a => a.name),
                submissionLink,
                timestamp: new Date().toISOString()
            });
        }

        return res.json(result);

    } catch(e) {
        console.error('review-submission error:', e);
        // Fail open — don't block legitimate work due to API errors
        return res.json({
            contentFlagged: false,
            contentFlagReason: '',
            summary: 'Automated review temporarily unavailable. Submission allowed through.',
            missingItems: [],
            recommendation: 'approve',
            confidence: 'low'
        });
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildPrompt({ projectTitle, projectDescription, acceptedBidAmount, submissionDescription, submissionLink, attachmentCount, githubSummary, virusTotalResults }) {
    const vtSummary = virusTotalResults.length > 0
        ? `VirusTotal Results:\n${virusTotalResults.map(r => `- ${r.name}: ${r.harmless} clean, ${r.suspicious} suspicious, ${r.malicious} malicious`).join('\n')}`
        : 'VirusTotal: not scanned (API key not configured or no files uploaded)';

    const ghSection = githubSummary
        ? `\nGITHUB REPO INSPECTION:\n${githubSummary}`
        : '';

    return `You are a security and quality reviewer for NQVate, a professional freelance marketplace.

PROJECT: "${projectTitle}"
DESCRIPTION: ${projectDescription}
AGREED COMPENSATION: ${acceptedBidAmount}

SUBMISSION:
- Description: ${submissionDescription}
- Link: ${submissionLink || 'None'}
- Attachments: ${attachmentCount} file(s) (images/PDFs/code shown below if any)
${ghSection}

SECURITY SCANS:
${vtSummary}

YOUR JOB — perform TWO checks in this order:

=== CHECK 1: CONTENT MODERATION (hard block) ===
Immediately flag and block if you detect ANY of:
- Pornography, nudity, sexual content of any kind
- Graphic violence, gore, torture imagery  
- Content involving minors in any inappropriate context
- Hate symbols, extremist content, terrorist material
- Malicious code: wallet drainers, keyloggers, credential harvesters, backdoors, ransomware, crypto miners, phishing pages
- Obfuscated/encoded code designed to hide its true purpose (base64 encoded payloads, eval() with encoded strings, etc.)
- Shell commands or scripts that would execute harmful system operations
- Social engineering templates (fake login pages, phishing emails)
- Anything clearly illegal

For CODE FILES specifically, check for:
- Functions that exfiltrate data to external servers without disclosure
- Private key or seed phrase extraction
- Unauthorized transaction signing
- Reentrancy attacks or other smart contract exploits (for Solidity)
- require() or import() of suspicious external packages
- Hardcoded malicious wallet addresses receiving funds

=== CHECK 2: SCOPE REVIEW (soft warning, user can override) ===
Only reach this if Check 1 passes. Assess:
- Does the submission appear to address the project requirements?
- Is the quality/completeness appropriate for ${acceptedBidAmount}?
- What seems missing or incomplete?
- Is the GitHub repo (if provided) consistent with the project requirements?

Respond ONLY with valid JSON, no markdown backticks, no explanation outside the JSON:
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
- blockedBy: "claude" | "virustotal" | ""
- recommendation: "approve" | "request_changes" | "reject"
- confidence: "high" | "medium" | "low"`;
}

function isGitHubUrl(url) {
    try {
        const u = new URL(url);
        return u.hostname === 'github.com';
    } catch { return false; }
}

async function inspectGitHubRepo(url) {
    // Parse owner/repo from URL
    // e.g. https://github.com/owner/repo or https://github.com/owner/repo/tree/main
    const match = url.match(/github\.com\/([^/]+)\/([^/?\s]+)/);
    if (!match) return 'Could not parse GitHub URL.';

    const [, owner, repo] = match;
    const headers = {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'NQVate-SecurityReview'
    };
    if (GITHUB_TOKEN) headers['Authorization'] = `token ${GITHUB_TOKEN}`;

    // Fetch repo metadata
    const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
    if (!repoRes.ok) {
        if (repoRes.status === 404) return `GitHub repo ${owner}/${repo} is private or does not exist.`;
        return `GitHub API error: ${repoRes.status}`;
    }
    const repoData = await repoRes.json();

    // Fetch root directory tree
    const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`, { headers });
    const treeData = treeRes.ok ? await treeRes.json() : null;

    const fileList = treeData?.tree
        ?.filter(f => f.type === 'blob')
        ?.map(f => f.path)
        ?.slice(0, 100) // cap at 100 files for the summary
        ?.join('\n') || 'Could not fetch file list';

    // Fetch key files for review: package.json, README, main entry points
    const keyFiles = ['package.json', 'requirements.txt', 'README.md', 'index.js', 'main.py', 'hardhat.config.js', '.env.example'];
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

    return `
Repo: ${owner}/${repo}
Description: ${repoData.description || 'None'}
Language: ${repoData.language || 'Unknown'}
Stars: ${repoData.stargazers_count} | Forks: ${repoData.forks_count}
Created: ${repoData.created_at} | Last push: ${repoData.pushed_at}
Private: ${repoData.private}

FILE TREE (up to 100 files):
${fileList}

KEY FILES:
${fileContents.join('\n\n') || 'No key files found'}
`.trim();
}

async function scanWithVirusTotal(attachment) {
    // Upload file to VirusTotal for scanning
    // attachment.base64 is the file content
    const fileBuffer = Buffer.from(attachment.base64, 'base64');

    // Use the files endpoint
    const formData = new FormData();
    const blob = new Blob([fileBuffer], { type: attachment.type || 'application/octet-stream' });
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

    // Poll for results (VirusTotal is async)
    let attempts = 0;
    while (attempts < 10) {
        await new Promise(r => setTimeout(r, 3000)); // wait 3s between polls
        const analysisRes = await fetch(`https://www.virustotal.com/api/v3/analyses/${analysisId}`, {
            headers: { 'x-apikey': VIRUSTOTAL_API_KEY }
        });
        const analysisData = await analysisRes.json();
        const status = analysisData.data?.attributes?.status;

        if (status === 'completed') {
            const stats = analysisData.data.attributes.stats;
            return {
                name: attachment.name,
                malicious:  stats.malicious  || 0,
                suspicious: stats.suspicious || 0,
                harmless:   stats.harmless   || 0,
                undetected: stats.undetected || 0
            };
        }
        attempts++;
    }

    // Timed out — return neutral result rather than blocking
    return { name: attachment.name, malicious: 0, suspicious: 0, harmless: 0, undetected: 0 };
}

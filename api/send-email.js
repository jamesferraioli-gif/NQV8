export const config = { runtime: 'edge' };

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM = 'NQVate <noreply@nqvate.com>';
const BASE_URL = 'https://www.nqvate.com';

const templates = {

    // Someone bid on your posting
    bid_received: ({ posterName, bidderUsername, postingTitle, bidAmount, postingId }) => ({
        subject: `New bid on "${postingTitle}"`,
        html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#09090b;color:#f4f4f5;padding:32px;border-radius:16px;">
            <div style="text-align:center;margin-bottom:32px;">
                <div style="background:linear-gradient(135deg,#22d3ee,#8b5cf6);width:56px;height:56px;border-radius:14px;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;color:#000;">NQV8</div>
            </div>
            <h1 style="font-size:24px;font-weight:700;margin-bottom:8px;">You received a bid 💰</h1>
            <p style="color:#a1a1aa;margin-bottom:24px;">Hey ${posterName}, <strong style="color:#f4f4f5;">@${bidderUsername}</strong> placed a bid on your posting.</p>
            <div style="background:#18181b;border:1px solid #3f3f46;border-radius:12px;padding:20px;margin-bottom:24px;">
                <p style="color:#a1a1aa;font-size:12px;margin:0 0 4px;">Posting</p>
                <p style="font-weight:600;font-size:16px;margin:0 0 12px;">${postingTitle}</p>
                <p style="color:#a1a1aa;font-size:12px;margin:0 0 4px;">Bid Amount</p>
                <p style="color:#22d3ee;font-weight:700;font-size:20px;margin:0;">${bidAmount}</p>
            </div>
            <a href="${BASE_URL}" style="display:block;background:#fff;color:#000;text-align:center;padding:14px;border-radius:12px;font-weight:600;text-decoration:none;margin-bottom:24px;">Review Bid →</a>
            <p style="color:#52525b;font-size:12px;text-align:center;">NQVate · <a href="${BASE_URL}" style="color:#22d3ee;">nqvate.com</a></p>
        </div>`
    }),

    // Your bid was accepted
    bid_accepted: ({ builderName, posterUsername, postingTitle, compensation, postingId }) => ({
        subject: `Your bid was accepted on "${postingTitle}" 🎉`,
        html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#09090b;color:#f4f4f5;padding:32px;border-radius:16px;">
            <div style="text-align:center;margin-bottom:32px;">
                <div style="background:linear-gradient(135deg,#22d3ee,#8b5cf6);width:56px;height:56px;border-radius:14px;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;color:#000;">NQV8</div>
            </div>
            <h1 style="font-size:24px;font-weight:700;margin-bottom:8px;">Bid accepted! 🎉</h1>
            <p style="color:#a1a1aa;margin-bottom:24px;">Hey ${builderName}, <strong style="color:#f4f4f5;">@${posterUsername}</strong> accepted your bid. Funds are now locked in escrow.</p>
            <div style="background:#18181b;border:1px solid #3f3f46;border-radius:12px;padding:20px;margin-bottom:24px;">
                <p style="color:#a1a1aa;font-size:12px;margin:0 0 4px;">Project</p>
                <p style="font-weight:600;font-size:16px;margin:0 0 12px;">${postingTitle}</p>
                <p style="color:#a1a1aa;font-size:12px;margin:0 0 4px;">Your Compensation</p>
                <p style="color:#10b981;font-weight:700;font-size:20px;margin:0;">${compensation}</p>
            </div>
            <div style="background:#052e16;border:1px solid #10b981;border-radius:12px;padding:16px;margin-bottom:24px;">
                <p style="color:#34d399;font-size:14px;margin:0;">✅ Funds are locked in escrow and will be released automatically when your work is approved.</p>
            </div>
            <a href="${BASE_URL}" style="display:block;background:#fff;color:#000;text-align:center;padding:14px;border-radius:12px;font-weight:600;text-decoration:none;margin-bottom:24px;">Open Project →</a>
            <p style="color:#52525b;font-size:12px;text-align:center;">NQVate · <a href="${BASE_URL}" style="color:#22d3ee;">nqvate.com</a></p>
        </div>`
    }),

    // Work submitted for review
    work_submitted: ({ posterName, builderUsername, postingTitle }) => ({
        subject: `@${builderUsername} submitted work on "${postingTitle}"`,
        html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#09090b;color:#f4f4f5;padding:32px;border-radius:16px;">
            <div style="text-align:center;margin-bottom:32px;">
                <div style="background:linear-gradient(135deg,#22d3ee,#8b5cf6);width:56px;height:56px;border-radius:14px;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;color:#000;">NQV8</div>
            </div>
            <h1 style="font-size:24px;font-weight:700;margin-bottom:8px;">Work submitted for review 📦</h1>
            <p style="color:#a1a1aa;margin-bottom:24px;">Hey ${posterName}, <strong style="color:#f4f4f5;">@${builderUsername}</strong> has submitted deliverables for <strong style="color:#f4f4f5;">${postingTitle}</strong>.</p>
            <div style="background:#1c1400;border:1px solid #f59e0b;border-radius:12px;padding:16px;margin-bottom:24px;">
                <p style="color:#fbbf24;font-size:14px;margin:0;">⏱ Review within 7 days or funds will auto-release to the builder.</p>
            </div>
            <a href="${BASE_URL}" style="display:block;background:#fff;color:#000;text-align:center;padding:14px;border-radius:12px;font-weight:600;text-decoration:none;margin-bottom:24px;">Review Submission →</a>
            <p style="color:#52525b;font-size:12px;text-align:center;">NQVate · <a href="${BASE_URL}" style="color:#22d3ee;">nqvate.com</a></p>
        </div>`
    }),

    // Submission approved
    submission_approved: ({ builderName, postingTitle, compensation }) => ({
        subject: `Your work was approved — funds released! 💸`,
        html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#09090b;color:#f4f4f5;padding:32px;border-radius:16px;">
            <div style="text-align:center;margin-bottom:32px;">
                <div style="background:linear-gradient(135deg,#22d3ee,#8b5cf6);width:56px;height:56px;border-radius:14px;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;color:#000;">NQV8</div>
            </div>
            <h1 style="font-size:24px;font-weight:700;margin-bottom:8px;">Work approved! 💸</h1>
            <p style="color:#a1a1aa;margin-bottom:24px;">Hey ${builderName}, your submission for <strong style="color:#f4f4f5;">${postingTitle}</strong> was approved and funds have been released from escrow.</p>
            <div style="background:#18181b;border:1px solid #3f3f46;border-radius:12px;padding:20px;margin-bottom:24px;">
                <p style="color:#a1a1aa;font-size:12px;margin:0 0 4px;">Amount Released</p>
                <p style="color:#10b981;font-weight:700;font-size:24px;margin:0;">${compensation}</p>
                <p style="color:#52525b;font-size:11px;margin:4px 0 0;">96.5% of agreed compensation after platform fee</p>
            </div>
            <a href="${BASE_URL}" style="display:block;background:#fff;color:#000;text-align:center;padding:14px;border-radius:12px;font-weight:600;text-decoration:none;margin-bottom:24px;">View Profile →</a>
            <p style="color:#52525b;font-size:12px;text-align:center;">NQVate · <a href="${BASE_URL}" style="color:#22d3ee;">nqvate.com</a></p>
        </div>`
    }),

    // Changes requested
    changes_requested: ({ builderName, posterUsername, postingTitle, feedback }) => ({
        subject: `Changes requested on "${postingTitle}"`,
        html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#09090b;color:#f4f4f5;padding:32px;border-radius:16px;">
            <div style="text-align:center;margin-bottom:32px;">
                <div style="background:linear-gradient(135deg,#22d3ee,#8b5cf6);width:56px;height:56px;border-radius:14px;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;color:#000;">NQV8</div>
            </div>
            <h1 style="font-size:24px;font-weight:700;margin-bottom:8px;">Changes requested 🔁</h1>
            <p style="color:#a1a1aa;margin-bottom:24px;">Hey ${builderName}, <strong style="color:#f4f4f5;">@${posterUsername}</strong> has requested changes on <strong style="color:#f4f4f5;">${postingTitle}</strong>.</p>
            <div style="background:#18181b;border:1px solid #3f3f46;border-radius:12px;padding:20px;margin-bottom:24px;">
                <p style="color:#a1a1aa;font-size:12px;margin:0 0 8px;">Feedback</p>
                <p style="color:#f4f4f5;font-size:14px;margin:0;">${feedback}</p>
            </div>
            <a href="${BASE_URL}" style="display:block;background:#fff;color:#000;text-align:center;padding:14px;border-radius:12px;font-weight:600;text-decoration:none;margin-bottom:24px;">Resubmit Work →</a>
            <p style="color:#52525b;font-size:12px;text-align:center;">NQVate · <a href="${BASE_URL}" style="color:#22d3ee;">nqvate.com</a></p>
        </div>`
    }),

    // Dispute resolved
    dispute_resolved: ({ recipientName, postingTitle, yourPct, ruling }) => ({
        subject: `Dispute resolved on "${postingTitle}"`,
        html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#09090b;color:#f4f4f5;padding:32px;border-radius:16px;">
            <div style="text-align:center;margin-bottom:32px;">
                <div style="background:linear-gradient(135deg,#22d3ee,#8b5cf6);width:56px;height:56px;border-radius:14px;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;color:#000;">NQV8</div>
            </div>
            <h1 style="font-size:24px;font-weight:700;margin-bottom:8px;">Dispute resolved ⚖️</h1>
            <p style="color:#a1a1aa;margin-bottom:24px;">Hey ${recipientName}, Claude AI has reviewed the dispute for <strong style="color:#f4f4f5;">${postingTitle}</strong> and issued a ruling.</p>
            <div style="background:#18181b;border:1px solid #3f3f46;border-radius:12px;padding:20px;margin-bottom:24px;">
                <p style="color:#a1a1aa;font-size:12px;margin:0 0 4px;">Your Share</p>
                <p style="color:#22d3ee;font-weight:700;font-size:24px;margin:0 0 12px;">${yourPct}%</p>
                <p style="color:#a1a1aa;font-size:12px;margin:0 0 8px;">Claude's Ruling</p>
                <p style="color:#f4f4f5;font-size:13px;margin:0;">${ruling}</p>
            </div>
            <p style="color:#52525b;font-size:12px;margin-bottom:24px;text-align:center;">This ruling is final. Funds have been distributed on-chain automatically.</p>
            <a href="${BASE_URL}" style="display:block;background:#fff;color:#000;text-align:center;padding:14px;border-radius:12px;font-weight:600;text-decoration:none;margin-bottom:24px;">View Project →</a>
            <p style="color:#52525b;font-size:12px;text-align:center;">NQVate · <a href="${BASE_URL}" style="color:#22d3ee;">nqvate.com</a></p>
        </div>`
    }),

    // New bounty matching skills
    new_bounty_match: ({ recipientName, postingTitle, compensation, category, matchedSkills, posterUsername }) => ({
        subject: `New ${category} bounty matches your skills — ${compensation}`,
        html: `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#09090b;color:#f4f4f5;padding:32px;border-radius:16px;">
            <div style="text-align:center;margin-bottom:32px;">
                <div style="background:linear-gradient(135deg,#22d3ee,#8b5cf6);width:56px;height:56px;border-radius:14px;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;color:#000;">NQV8</div>
            </div>
            <h1 style="font-size:24px;font-weight:700;margin-bottom:8px;">New bounty matches your skills 🎯</h1>
            <p style="color:#a1a1aa;margin-bottom:24px;">Hey ${recipientName}, a new bounty was posted that matches your skills.</p>
            <div style="background:#18181b;border:1px solid #3f3f46;border-radius:12px;padding:20px;margin-bottom:16px;">
                <p style="font-weight:600;font-size:16px;margin:0 0 8px;">${postingTitle}</p>
                <p style="color:#22d3ee;font-weight:700;font-size:18px;margin:0 0 8px;">${compensation}</p>
                <p style="color:#a1a1aa;font-size:12px;margin:0 0 8px;">Posted by @${posterUsername} · ${category}</p>
                <div style="display:flex;flex-wrap:wrap;gap:6px;">
                    ${matchedSkills.map(s => `<span style="background:#1e3a3a;color:#22d3ee;padding:2px 10px;border-radius:20px;font-size:11px;">${s}</span>`).join('')}
                </div>
            </div>
            <a href="${BASE_URL}" style="display:block;background:#fff;color:#000;text-align:center;padding:14px;border-radius:12px;font-weight:600;text-decoration:none;margin-bottom:24px;">View & Bid →</a>
            <p style="color:#52525b;font-size:11px;text-align:center;margin-bottom:8px;">You're receiving this because your skills match this bounty's requirements.</p>
            <p style="color:#52525b;font-size:12px;text-align:center;">NQVate · <a href="${BASE_URL}" style="color:#22d3ee;">nqvate.com</a></p>
        </div>`
    })
};

export default async function handler(req) {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    try {
        const { type, to, data } = await req.json();

        if (!type || !to || !data) {
            return new Response(JSON.stringify({ error: 'Missing type, to, or data' }), { status: 400 });
        }

        const template = templates[type];
        if (!template) {
            return new Response(JSON.stringify({ error: `Unknown template: ${type}` }), { status: 400 });
        }

        const { subject, html } = template(data);

        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${RESEND_API_KEY}`
            },
            body: JSON.stringify({ from: FROM, to, subject, html })
        });

        const result = await res.json();

        if (!res.ok) {
            console.error('Resend error:', result);
            return new Response(JSON.stringify({ error: result }), { status: 500 });
        }

        return new Response(JSON.stringify({ success: true, id: result.id }), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch(e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
}

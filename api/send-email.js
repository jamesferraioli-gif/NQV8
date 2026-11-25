// api/send-email.js
//
// Sends NQVate's notification emails.
//
// WHO AN EMAIL GOES TO is decided here, not by the browser.
//
//   A signed-in member may only ask for one of the templates below to be sent
//   to another MEMBER, named by their user id. The address is looked up on
//   the server from Firebase Authentication — which is the only place a
//   member's email now lives. It is no longer stored in the public `users`
//   records, and it never travels through the browser.
//
//   Only the platform's own jobs (which hold the server secret) may send to a
//   raw address or send free-form text — the ops-wallet warning and the daily
//   error digest.
//
// This used to accept any address and any text from any signed-in user, which
// made it a way to send arbitrary email from noreply@nqvate.com to anyone.
//
// How often, and whether the member wants email at all, is decided in
// _mail.js — the same rules apply to every email the platform sends.
//
// Everything a member supplies for a template (names, titles, amounts) is
// HTML-escaped before it is placed in the message, so a posting title cannot
// carry markup or links into someone's inbox.

import { verifyCaller } from './_auth.js';
import { templates, escapeHtml, emailForUid, sendMemberEmail, sendRaw, MEMBER_TEMPLATES } from './_mail.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const caller = await verifyCaller(req);
    if (!caller) return res.status(401).json({ error: 'Unauthorized' });

    try {
        const payload = req.body || {};
        const { type } = payload;

        if (!caller.service) {
            // A member: a known template, to another member, by id.
            if (!type || !MEMBER_TEMPLATES.includes(type)) return res.status(400).json({ error: 'Unknown template' });
            const toUid = payload.toUid;
            if (typeof toUid !== 'string' || !toUid || toUid.length > 128) return res.status(400).json({ error: 'toUid required' });
            if (!payload.data || typeof payload.data !== 'object') return res.status(400).json({ error: 'Missing data for template' });
            // What the email is about, so repeats can be held back. Bids are
            // grouped by posting; everything else by posting and sender.
            const about = String(payload.data.postingId || payload.data.postingTitle || payload.data.companyName || '').slice(0, 120);
            const key = type === 'bid_received' ? about : about + ':' + caller.uid;
            const out = await sendMemberEmail({ toUid, type, data: payload.data, key });
            // Whether it went, was held back or had no address is not told to
            // the sender: any of those would say something about the recipient.
            if (!out.sent && (out.why === 'provider' || out.why === 'error')) return res.status(500).json({ error: 'The email could not be sent' });
            return res.status(200).json({ success: true });
        }

        // The platform's own jobs.
        if (payload.toUid && type && !payload.to) {
            // To a member, through the same settings and limits as everything else.
            if (!templates[type]) return res.status(400).json({ error: `Unknown template: ${type}` });
            if (!payload.data)   return res.status(400).json({ error: 'Missing data for template' });
            const out = await sendMemberEmail({ toUid: String(payload.toUid), type, data: payload.data, key: payload.key });
            return res.status(200).json({ success: true, sent: out.sent, why: out.why });
        }
        // To an operator's address: a raw address, and free-form text if wanted.
        let to = payload.to, subject, html;
        if (!to && payload.toUid) to = await emailForUid(String(payload.toUid));
        if (!to) return res.status(400).json({ error: 'Missing recipient' });
        if (type) {
            if (!templates[type]) return res.status(400).json({ error: `Unknown template: ${type}` });
            if (!payload.data)   return res.status(400).json({ error: 'Missing data for template' });
            ({ subject, html } = templates[type](payload.data));
        } else if (payload.subject && payload.body) {
            subject = payload.subject;
            html = `<pre style="font-family:ui-monospace,Menlo,monospace;font-size:13px;line-height:1.5;white-space:pre-wrap">${escapeHtml(payload.body)}</pre>`;
        } else {
            return res.status(400).json({ error: 'Provide either a template type with data, or subject and body' });
        }
        const out = await sendRaw({ to, subject, html });
        if (!out.ok) return res.status(500).json({ error: 'The email could not be sent' });
        return res.status(200).json({ success: true, id: out.id });

    } catch (e) {
        console.error('send-email failed:', e.message);
        return res.status(500).json({ error: 'The email could not be sent' });
    }
}

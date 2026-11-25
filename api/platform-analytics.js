// api/platform-analytics.js
//
// Everything that has happened on NQVate, counted in one place. Admin only.
//
//   GET /api/platform-analytics?days=30        days: 7, 30, 90 or 0 (all time)
//   GET /api/platform-analytics?days=30&fresh=1   skip the five-minute cache
//
// WHO MAY CALL IT
//   Only a signed-in admin (ADMIN_UIDS). The check is here, against the
//   caller's verified Firebase token. The button in index.html only decides
//   whether it is drawn.
//
// WHAT COMES BACK
//   Counts, sums, daily series and a list of recent events. Usernames appear
//   (they are public); email addresses and wallet addresses never do.
//
// HOW IT WORKS
//   It reads the collections with the Admin SDK and counts. That is the right
//   trade while the site is young: no extra writes anywhere, nothing to keep
//   in step, and the numbers cannot drift from the records. The result is
//   kept for five minutes (adminCache/analytics-<days>, which has no rule and
//   so is server-only), so reopening the panel costs one read.
//   WHEN TO CHANGE IT: once `scanned` in the reply passes ~50,000 records,
//   move the daily series to counters written as things happen.

export const config = { maxDuration: 60 };

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { verifyCaller } from './_auth.js';

/// Must match ADMIN_UIDS in index.html and api/features.js.
const ADMIN_UIDS = ['5t0gD2wVnqXXPAQEzfoahx3EIPp2'];
const CACHE_MS = 5 * 60 * 1000;
const DAY = 86400;
const WINDOWS = [7, 30, 90, 0];
const FEED_MAX = 120;

function db() {
    if (!getApps().length) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    return getFirestore();
}

/// Seconds since 1970 from any of the shapes a time is stored in here:
/// a Firestore Timestamp, a Date, an ISO string, or milliseconds.
export function secs(t) {
    if (!t) return 0;
    if (typeof t.seconds === 'number') return t.seconds;
    if (typeof t._seconds === 'number') return t._seconds;
    if (typeof t.toMillis === 'function') return Math.floor(t.toMillis() / 1000);
    if (t instanceof Date) return Math.floor(t.getTime() / 1000);
    if (typeof t === 'number') return Math.floor(t > 1e11 ? t / 1000 : t);
    if (typeof t === 'string') { const n = Date.parse(t); return isNaN(n) ? 0 : Math.floor(n / 1000); }
    return 0;
}
/// The dollar figure in "$1,250.00 USDC" or "$500 + 2% equity". 0 if none.
export function usd(s) {
    if (typeof s === 'number') return s;
    const m = /\$\s*([\d,]+(?:\.\d+)?)/.exec(String(s || ''));
    return m ? parseFloat(m[1].replace(/,/g, '')) : 0;
}
const dayKey = s => new Date(s * 1000).toISOString().slice(0, 10);
const clip = (s, n = 70) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

/// Work the report out from plain data. No database in here, so it can be
/// tested directly.  raw: { users: [{_id, ...}], subprojects: [...], ... }
export function buildAnalytics(raw, days, nowSecs = Math.floor(Date.now() / 1000)) {
    const R = k => raw[k] || [];
    const allTime = !days;
    const from = allTime ? 0 : nowSecs - days * DAY;
    const prevFrom = allTime ? 0 : from - days * DAY;
    const inWin = s => s > from && s <= nowSecs;
    const inPrev = s => !allTime && s > prevFrom && s <= from;

    const names = new Map();
    R('users').forEach(u => names.set(u._id, u.username || 'member'));
    const who = uid => '@' + (names.get(uid) || 'member');

    // ── the daily series ────────────────────────────────────────────────
    // All time is drawn over the last 90 days; the totals still cover everything.
    const seriesDays = allTime ? 90 : days;
    const seriesFrom = nowSecs - seriesDays * DAY;
    const SERIES = ['signups', 'listings', 'bids', 'accepted', 'completed', 'posts', 'comments', 'messages', 'follows'];
    const daily = new Map();
    for (let i = seriesDays - 1; i >= 0; i--) { const o = { day: dayKey(nowSecs - i * DAY) }; SERIES.forEach(k => o[k] = 0); daily.set(o.day, o); }

    const now = {}, prev = {};
    const active = new Map();                  // uid → actions in the window
    const feed = [];
    /// One thing that happened: counted in its period, on its day, against
    /// whoever did it, and kept for the recent-activity list.
    function hit(key, at, uid, icon, text) {
        if (!at) return;
        if (inWin(at)) {
            now[key] = (now[key] || 0) + 1;
            if (uid) active.set(uid, (active.get(uid) || 0) + 1);
        } else if (inPrev(at)) prev[key] = (prev[key] || 0) + 1;
        if (at > seriesFrom && at <= nowSecs) { const d = daily.get(dayKey(at)); if (d && key in d) d[key]++; }
        if (text && at <= nowSecs) feed.push({ t: at, icon, text });
    }

    // ── members ─────────────────────────────────────────────────────────
    const members = { total: R('users').length, withWallet: 0, withSkills: 0, withBio: 0, referred: 0 };
    R('users').forEach(u => {
        if (u.walletAddress) members.withWallet++;
        if (Array.isArray(u.skills) && u.skills.length) members.withSkills++;
        if (u.bio) members.withBio++;
        if (u.referredBy || u.referrerUid) members.referred++;
        hit('signups', secs(u.createdAt), null, '👋', `@${u.username || 'member'} joined`);
    });

    // ── companies ───────────────────────────────────────────────────────
    const companies = { total: R('companies').length, live: 0, verified: 0, metricsVerified: 0, withTeam: 0, teamSeats: 0 };
    const companyNames = new Map();
    R('companies').forEach(c => {
        companyNames.set(c._id, c.name || 'a company');
        if (c.projectStatus === 'live') companies.live++;
        if (c.verificationStatus === 'verified' || c.equityUnlocked) companies.verified++;
        if (c.metricsVerified) companies.metricsVerified++;
        const seats = Array.isArray(c.teamUids) ? c.teamUids.length : 0;
        if (seats) { companies.withTeam++; companies.teamSeats += seats; }
        hit('companies', secs(c.createdAt), c.ownerUid, '🏢', `${who(c.ownerUid)} created ${clip(c.name, 40)}`);
    });

    // ── the marketplace ─────────────────────────────────────────────────
    const market = {
        total: 0, open: 0, inProgress: 0, completed: 0, refunded: 0, disputed: 0, planParts: 0, fundingRequests: 0, privateListings: 0,
        openNoBids: 0, bidsTotal: 0, valueOpen: 0, valueInEscrow: 0, valuePaidAllTime: 0,
        postedValue: 0, paidValue: 0, prevPaidValue: 0, equityUnitsPaid: 0, bondsRequired: 0,
        fillDays: [], deliverDays: [], byCategory: {}
    };
    const posterDone = new Map(), builderDone = new Map(), companyDone = new Map();
    R('subprojects').forEach(p => {
        if (p.planNode === true) { market.planParts++; return; }
        const funding = p.type === 'fund' || p.type === 'funding';
        const made = secs(p.createdAt), accepted = secs(p.acceptedAt || p.escrowLockedAt), done = secs(p.completedAt), refunded = secs(p.refundedAt);
        const poster = p.posterUid || p.ownerUid, title = '“' + clip(p.title, 50) + '”';
        if (funding) { market.fundingRequests++; hit('fundingRequests', made, poster, '💰', `${who(poster)} posted a funding request`); return; }
        market.total++;
        if (p.isPrivate === true) market.privateListings++;
        if (Number(p.bondNQV8) > 0) market.bondsRequired++;
        const bids = Array.isArray(p.bids) ? p.bids : [];
        const amount = usd((p.acceptedBid && p.acceptedBid.amount) || p.compensation);
        market.bidsTotal += bids.length;
        // A private listing is counted, never named.
        const label = p.isPrivate === true ? 'a private bounty' : title;
        hit('listings', made, poster, '📋', `${who(poster)} posted ${label}${amount ? ' · $' + Math.round(amount).toLocaleString() : ''}`);
        if (inWin(made)) { market.postedValue += usd(p.compensation); const c = p.category || 'Other'; market.byCategory[c] = (market.byCategory[c] || 0) + 1; }
        bids.forEach(b => hit('bids', secs(b.timestamp || b.createdAt), b.bidderUid, '🙋', `${who(b.bidderUid)} bid on ${label}`));
        if (p.acceptedBidderUid) hit('accepted', accepted, poster, '🤝', `${who(poster)} accepted ${who(p.acceptedBidderUid)} on ${label}`);
        if (p.disputeFiled || p.claudeRuling) { market.disputed++; hit('disputes', secs(p.disputeFiledAt), p.disputeFiledBy, '⚖️', `${who(p.disputeFiledBy)} opened a dispute on ${label}`); }
        if (p.status === 'completed') {
            market.completed++; market.valuePaidAllTime += amount;
            hit('completed', done, p.acceptedBidderUid, '✅', `${who(p.acceptedBidderUid)} completed ${label}${amount ? ' · $' + Math.round(amount).toLocaleString() : ''}`);
            if (inWin(done)) {
                market.paidValue += amount; market.equityUnitsPaid += Number(p.equityUnits) || 0;
                if (accepted && done >= accepted) market.deliverDays.push((done - accepted) / DAY);
                const bump = (m, k, label2) => { if (!k) return; const x = m.get(k) || { label: label2, n: 0, usd: 0 }; x.n++; x.usd += amount; m.set(k, x); };
                bump(builderDone, p.acceptedBidderUid, who(p.acceptedBidderUid)); bump(posterDone, poster, who(poster));
                bump(companyDone, p.companyId, companyNames.get(p.companyId) || p.projectName || 'a company');
            } else if (inPrev(done)) market.prevPaidValue += amount;
        } else if (p.status === 'in-progress') { market.inProgress++; market.valueInEscrow += amount; }
        else if (p.status === 'refunded' || p.status === 'cancelled') { market.refunded++; hit('refunds', refunded, null, '↩️', `${label} was refunded`); }
        else { market.open++; market.valueOpen += usd(p.compensation); if (!bids.length) market.openNoBids++; }
        if (p.acceptedBidderUid && inWin(accepted) && made && accepted >= made) market.fillDays.push((accepted - made) / DAY);
    });
    const avg = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    const started = market.inProgress + market.completed + market.refunded;
    market.avgBids = market.total ? market.bidsTotal / market.total : null;
    market.avgFillDays = avg(market.fillDays); market.avgDeliverDays = avg(market.deliverDays);
    market.completionRate = started ? market.completed / started : null;
    market.disputeRate = started ? market.disputed / started : null;
    market.byCategory = Object.entries(market.byCategory).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, n]) => ({ name, n }));
    delete market.fillDays; delete market.deliverDays;

    // ── posts, comments, shows ──────────────────────────────────────────
    const content = { posts: R('posts').length, byType: {}, likes: 0, comments: 0, liveNow: 0, boosted: 0, removed: R('removedPosts').length };
    R('posts').forEach(p => {
        const type = p.type || 'idea';
        content.byType[type] = (content.byType[type] || 0) + 1;
        content.likes += Number(p.likes) || 0;
        if (p.type === 'stream' && p.liveStatus === 'live' && (!p.liveExpiresAt || nowSecs * 1000 < p.liveExpiresAt)) content.liveNow++;
        if (p.isSponsoredBoost && p.sponsoredBoostUntil > nowSecs * 1000) content.boosted++;
        const verb = type === 'stream' ? 'went live' : type === 'podcast' ? 'released an episode' : 'posted';
        hit('posts', secs(p.createdAt), p.posterUid, type === 'stream' ? '📡' : type === 'podcast' ? '🎙️' : '💬', `@${p.username || 'member'} ${verb}: “${clip(p.title, 50)}”`);
        (Array.isArray(p.comments) ? p.comments : []).forEach(c => { content.comments++; hit('comments', secs(c.createdAt), c.uid, '🗨️', `@${c.username || 'member'} commented on “${clip(p.title, 40)}”`); });
    });
    R('removedPosts').forEach(p => hit('removals', secs(p.removedAt || p.createdAt), null, '🛑', 'A post was removed by moderation'));

    // ── chat: how much, never what ──────────────────────────────────────
    const chat = { chats: R('chats').length, groups: 0, messages: 0 };
    R('chats').forEach(c => {
        if (c.type === 'group') chat.groups++;
        hit('chats', secs(c.createdAt), null, null, null);
        (Array.isArray(c.messages) ? c.messages : []).forEach(m => { chat.messages++; hit('messages', secs(m.timestamp || m.createdAt), m.senderUid, null, null); });
    });

    // ── follows, reviews, bookmarks ─────────────────────────────────────
    R('follows').forEach(f => hit('follows', secs(f.createdAt), f.followerUid, null, null));
    let stars = 0, rated = 0;
    R('reviews').forEach(r => { if (r.rating) { stars += Number(r.rating); rated++; } hit('reviews', secs(r.createdAt), r.reviewerUid, '⭐', `${r.reviewerUsername ? '@' + r.reviewerUsername : 'A member'} left a ${r.rating || '?'}-star review`); });
    const social = { follows: R('follows').length, reviews: R('reviews').length, avgRating: rated ? stars / rated : null,
                     bookmarks: R('bookmarks').length, blocks: R('blocks').length, listingAlerts: R('listingAlerts').length };

    // ── money the platform took in ──────────────────────────────────────
    // protocolFees is written by the page as each NQV8 fee is paid;
    // depositedEscrowFees by the server for the 3.5% on each USDC payout.
    const fees = { nqv8: 0, usdc: 0, prevNqv8: 0, prevUsdc: 0, nqv8AllTime: 0, usdcAllTime: 0, byType: {} };
    const addFee = (at, type, currency, amount) => {
        if (!(amount > 0)) return;
        const k = currency === 'NQV8' ? 'nqv8' : 'usdc';
        fees[k + 'AllTime'] += amount;
        if (inWin(at) || allTime) { fees[k] += amount; const t = fees.byType[type] = fees.byType[type] || { type, n: 0, nqv8: 0, usdc: 0 }; t.n++; t[k] += amount; }
        else if (inPrev(at)) fees[k === 'nqv8' ? 'prevNqv8' : 'prevUsdc'] += amount;
    };
    R('protocolFees').forEach(f => { if (f.feeType === 'escrow-release') return; addFee(secs(f.collectedAt), f.feeType || 'fee', f.currency === 'NQV8' ? 'NQV8' : 'USDC', Number(f.amount) || 0); });
    R('depositedEscrowFees').forEach(f => addFee(secs(f.createdAt), 'escrow-payout (3.5%)', 'USDC', Number(f.fee) / 1e6 || 0));
    fees.byType = Object.values(fees.byType).sort((a, b) => (b.usdc + b.nqv8 / 100) - (a.usdc + a.nqv8 / 100));

    // ── equity, subscriptions, ads, referrals ───────────────────────────
    const equity = { listings: R('equityListings').length, activeListings: R('equityListings').filter(l => l.active === true || l.status === 'active').length,
                     offers: R('equityOffers').length, transfers: R('equityTransfers').length, holders: R('equityHolders').length };
    R('equityListings').forEach(l => hit('equityListings', secs(l.createdAt), null, '📈', 'An equity stake was listed'));
    R('equityOffers').forEach(o => hit('equityOffers', secs(o.createdAt), null, '📨', 'An offer was made on an equity stake'));
    R('equityTransfers').forEach(t => hit('equityTransfers', secs(t.createdAt), t.initiatedBy, '🔁', `${(Number(t.units) / 100 || 0).toFixed(2)}% equity changed hands`));
    const subs = { total: R('subscriptions').length, current: R('subscriptions').filter(s => secs(s.paidUntil) > nowSecs).length };
    const ads = { campaigns: R('adCampaigns').length, active: 0, impressions: 0, clicks: 0 };
    R('adCampaigns').forEach(a => { if (a.status === 'active') ads.active++; ads.impressions += Number(a.impressions) || 0; ads.clicks += Number(a.clicks) || 0; hit('adCampaigns', secs(a.createdAt), a.advertiserUid, '📢', `${who(a.advertiserUid)} started an ad campaign`); });
    const referrals = { claims: R('referralBonuses').length, nqv8: R('referralBonuses').reduce((s, r) => s + (Number(r.bonusAmount) || 0), 0) };

    // ── support, reports, AI, errors ────────────────────────────────────
    const support = { open: 0, closed: 0, reportsOpen: 0, reports: 0, byReason: {} };
    R('supportTickets').forEach(t => {
        const report = t.category === 'content-report', open = t.status === 'open';
        if (report) { support.reports++; if (open) support.reportsOpen++; if (inWin(secs(t.createdAt)) || allTime) { const r = t.reportReason || 'Other'; support.byReason[r] = (support.byReason[r] || 0) + 1; } }
        else if (open) support.open++; else support.closed++;
        hit(report ? 'reports' : 'tickets', secs(t.createdAt), t.uid, report ? '🚩' : '🎫', report ? `@${t.username || 'member'} reported a ${t.reportKind || 'post'}` : `@${t.username || 'member'} opened a support ticket`);
    });
    support.byReason = Object.entries(support.byReason).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n }));
    const ai = { jobs: 0, failed: 0, nqv8: 0, byKind: {} };
    R('aiJobs').forEach(j => { const at = secs(j.createdAt); if (!(inWin(at) || allTime)) return; ai.jobs++; if (j.status === 'failed' || j.status === 'refunded') ai.failed++; else ai.nqv8 += Number(j.priceNQV8) || 0; ai.byKind[j.kind || 'other'] = (ai.byKind[j.kind || 'other'] || 0) + 1; });
    ai.byKind = Object.entries(ai.byKind).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n }));
    const errors = { total: 0, byEndpoint: {} };
    R('errorLog').forEach(e => { if (!(inWin(secs(e.createdAt)) || allTime)) return; errors.total++; const k = (e.endpoint || 'unknown') + (e.status ? ' · ' + e.status : ''); errors.byEndpoint[k] = (errors.byEndpoint[k] || 0) + 1; });
    errors.byEndpoint = Object.entries(errors.byEndpoint).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, n]) => ({ name, n }));
    const today = dayKey(nowSecs);
    const emailsToday = R('emailLog').reduce((s, l) => s + (l.day === today && l.counts ? Object.values(l.counts).reduce((a, b) => a + (Number(b) || 0), 0) : 0), 0);

    // ── who was active ──────────────────────────────────────────────────
    members.active = active.size;
    const top = m => [...m.entries()].map(([id, x]) => ({ id, label: x.label, n: x.n, usd: Math.round(x.usd) })).sort((a, b) => b.n - a.n || b.usd - a.usd).slice(0, 8);
    const leaders = {
        active: [...active.entries()].map(([id, n]) => ({ id, label: who(id), n })).sort((a, b) => b.n - a.n).slice(0, 10),
        builders: top(builderDone), posters: top(posterDone), companies: top(companyDone)
    };

    feed.sort((a, b) => b.t - a.t);
    const KEYS = ['signups', 'companies', 'listings', 'bids', 'accepted', 'completed', 'disputes', 'refunds', 'fundingRequests', 'posts', 'comments', 'messages', 'chats',
                  'follows', 'reviews', 'reports', 'tickets', 'removals', 'equityListings', 'equityOffers', 'equityTransfers', 'adCampaigns'];
    const activity = {};
    KEYS.forEach(k => activity[k] = { now: now[k] || 0, prev: allTime ? null : (prev[k] || 0) });

    return {
        days: days || 0, generatedAt: nowSecs, seriesDays,
        scanned: Object.values(raw).reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0),
        activity, members, companies, market, content, chat, social, fees, equity, subs, ads, referrals, support, ai, errors, emailsToday, leaders,
        daily: [...daily.values()], feed: feed.slice(0, FEED_MAX)
    };
}

const COLLECTIONS = ['users', 'companies', 'subprojects', 'posts', 'chats', 'follows', 'reviews', 'bookmarks', 'blocks', 'listingAlerts', 'protocolFees', 'depositedEscrowFees',
    'equityListings', 'equityOffers', 'equityTransfers', 'equityHolders', 'subscriptions', 'adCampaigns', 'referralBonuses', 'supportTickets', 'removedPosts', 'aiJobs', 'errorLog', 'emailLog'];

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    // A person, not a server secret.
    const caller = await verifyCaller(req, { allowService: false });
    if (!caller || !caller.uid) return res.status(401).json({ error: 'Unauthorized' });
    if (!ADMIN_UIDS.includes(caller.uid)) return res.status(403).json({ error: 'Admins only' });

    const asked = parseInt((req.query && req.query.days) || '30', 10);
    const days = WINDOWS.includes(asked) ? asked : 30;
    const fresh = !!(req.query && req.query.fresh);

    try {
        const store = db(), cacheRef = store.collection('adminCache').doc('analytics-' + days);
        if (!fresh) {
            const hit = await cacheRef.get();
            if (hit.exists && Date.now() - (hit.data().at || 0) < CACHE_MS) return res.status(200).json(JSON.parse(hit.data().json));
        }
        const raw = {};
        await Promise.all(COLLECTIONS.map(async c => {
            const snap = await store.collection(c).get();
            raw[c] = snap.docs.map(d => Object.assign({ _id: d.id }, d.data()));
        }));
        const out = buildAnalytics(raw, days);
        const json = JSON.stringify(out);
        // A cache that cannot be written must not cost the admin the report.
        if (json.length < 900000) await cacheRef.set({ at: Date.now(), json }).catch(e => console.warn('platform-analytics: cache not saved:', e.message));
        return res.status(200).json(out);
    } catch (e) {
        console.error('platform-analytics failed:', e.message);
        return res.status(500).json({ error: 'Could not build the report' });
    }
}

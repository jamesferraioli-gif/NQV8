// api/nqverse.js
//
// The NQVerse's data, built once on the server and shared by everyone.
//
// The landing page used to make every visitor's browser download whole
// collections — every member, company, stake, bounty, follow and review — and
// work the map out for itself. That is fine for a handful of members and
// hopeless for thousands: slow to appear, and every visit paid to read every
// record. Now the map is worked out HERE, at most once every couple of
// minutes, and browsers fetch one compact summary that a CDN hands out.
//
//   GET /api/nqverse               the summary: companies, the people tied to
//                                  them, the most active unattached members,
//                                  open listings, recent activity, and what is
//                                  trending this week
//   GET /api/nqverse?company=<id>  that company's stakes, read from the
//                                  EquityRegistry contract (the authority)
//
// WHAT IS LEFT OUT, ON PURPOSE
//
//   - Wallet addresses and emails. Nothing in the summary carries either. A
//     holder with no account shows as "0x1234…abcd" under an opaque key. The
//     contract check that needs real addresses happens here, on the server.
//   - Private listings. The summary is the same for everyone, so it can only
//     hold what everyone may see. A private bounty stays visible to its poster
//     and invitees on the Marketplace page; here it adds to the totals of
//     work done and nothing else — never its title.
//
// HOW IT STAYS SMALL
//
//   A company lists its leading MEMBERS_PER_COMPANY people (founder first,
//   then by stake, then by work) with a count of the rest — the map shows
//   fewer than that as moons anyway. Company members take up to TIED_MAX
//   places, leading companies first; the rest of the PEOPLE_MAX places go to
//   the most active members overall, tied to a company or not, so the
//   rankings and the belt are never crowded out. Whoever is left out is
//   counted. Those limits are far above today's numbers; they exist so the
//   file cannot grow without bound.
//
// Public, read-only, no secrets: everything here was already public.

export const config = { maxDuration: 60 };

import crypto from 'crypto';
import { ethers } from 'ethers';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const ARBITRUM_RPC            = 'https://arb1.arbitrum.io/rpc';
const EQUITY_REGISTRY_ADDRESS = '0x726a5EEa94C6d3117bbCd05336A0Cfdaf3c9327a';
const REGISTRY_ABI            = ['function balances(bytes32 companyId, address holder) view returns (uint256)'];
const OPS_WALLET              = '0x2c6309ed2e36222e7e0ce3c1376941a0d6340f4d';

const SNAPSHOT_TTL_MS     = 120000;   // rebuild at most this often per server instance
const CHAIN_TTL_MS        = 60000;
const PEOPLE_MAX          = 9000;
const TIED_MAX            = 6000;
const MEMBERS_PER_COMPANY = 60;
const EVENTS_MAX          = 80;
const LISTINGS_MAX        = 1500;
const CLOSED_STATUS       = ['in-progress', 'completed', 'refunded', 'disputed', 'resolved'];
const TREND_DAYS          = 7;        // "trending" means: in the last week
const POSTS_LOOKBACK_DAYS = 30;       // how far back posts are read, to catch an older one that has come alive
const HOT_POSTS_MAX       = 120;
const TREND_KEEP          = 300;      // trending members always make the file, however new they are

function getAdminDb() {
    if (!getApps().length) {
        initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    }
    return getFirestore();
}

const secs    = t => (t && (t.seconds || t._seconds)) || 0;
const dollars = v => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.]/g, '')); return isFinite(n) ? n : 0; };
// The cash part of an amount like "$500 USDC" or "$500 + 2% equity".
const cash = v => {
    const str = String(v == null ? '' : v), m = str.match(/\$\s*([\d,]+(?:\.\d+)?)/);
    if (m) return parseFloat(m[1].replace(/,/g, '')) || 0;
    return str.includes('%') ? 0 : dollars(str);
};
const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) : s; };
// Seconds since 1970 from anything a document might hold a time as: a
// Firestore timestamp, a Date, a number of milliseconds or an ISO string.
const when = t => {
    if (!t) return 0;
    if (typeof t === 'object') {
        if (t.seconds || t._seconds) return t.seconds || t._seconds;
        if (typeof t.toMillis === 'function') return Math.floor(t.toMillis() / 1000);
        if (t instanceof Date) return Math.floor(t.getTime() / 1000);
        return 0;
    }
    if (typeof t === 'number') return t > 1e11 ? Math.floor(t / 1000) : t;
    const ms = Date.parse(String(t));
    return isFinite(ms) ? Math.floor(ms / 1000) : 0;
};

/**
 * Work the whole map out from the raw collections. Pure: no I/O, so it can be
 * tested with plain objects.
 *
 * `raw` is { users: Map(uid → doc), companies: Map(id → doc), holders: [],
 *            subprojects: [], sales: [], follows: [], reviews: [] }
 * where list entries carry their document id as `_id`.
 *
 * Returns { snapshot, wallets } — `snapshot` is what is sent to browsers;
 * `wallets` (company id → [{ key, wallet }]) never leaves the server.
 */
export function buildSnapshot(raw, now = Date.now()) {
    const { users, companies, holders, subprojects, sales, follows, reviews } = raw;
    const posts = raw.posts || [];
    const nowS = Math.floor(now / 1000), week = nowS - TREND_DAYS * 86400;
    const bump = (map, key, by = 1) => { if (key) map.set(key, (map.get(key) || 0) + by); };
    // This week's movement, counted as the collections are walked.
    const wk = { userFollows: new Map(), companyFollows: new Map(), done: new Map(), posts: new Map(), coPosted: new Map(), coDone: new Map() };
    const bounties = subprojects.filter(p => p.type === 'build');
    const fundAll  = subprojects.filter(p => p.type === 'fund');
    const funding  = fundAll.filter(f => f.status === 'completed');

    const userFollowers = new Map(), companyFollowers = new Map();
    follows.forEach(f => {
        if (f.followingUid) userFollowers.set(f.followingUid, (userFollowers.get(f.followingUid) || 0) + 1);
        if (f.followingCompanyId) companyFollowers.set(f.followingCompanyId, (companyFollowers.get(f.followingCompanyId) || 0) + 1);
        if (when(f.createdAt) >= week) { bump(wk.userFollows, f.followingUid); bump(wk.companyFollows, f.followingCompanyId); }
    });

    // ── People ─────────────────────────────────────────────────────────────
    const people = new Map();          // internal key → person
    const walletToUid = new Map();
    // A wallet with no account behind it gets a key that says nothing about it.
    const walletKey = w => 'w:' + crypto.createHash('sha256').update(w).digest('hex').slice(0, 16);

    const personFor = (uid, wallet) => {
        const w = wallet ? String(wallet).toLowerCase() : null;
        const id = uid || (w && walletToUid.get(w)) || null;
        const key = id ? 'u:' + id : walletKey(w);
        if (!people.has(key)) {
            const isOps = !id && w === OPS_WALLET;
            people.set(key, {
                key, uid: id, ops: isOps, wallet: w,
                label: isOps ? 'NQVate (platform)' : (w ? w.slice(0, 6) + '…' + w.slice(-4) : 'Unknown'),
                name: '', known: false, appearances: [], bounties: [], nb: 0,
                stats: { done: 0, usdc: 0, stakes: 0, stakeValue: 0, followers: 0, funded: 0, fundedValue: 0, ratingTotal: 0, ratingCount: 0 },
                score: 0
            });
        }
        return people.get(key);
    };

    users.forEach((u, uid) => { if (u.walletAddress) walletToUid.set(String(u.walletAddress).toLowerCase(), uid); });
    // A stake may sit in a wallet the member used before their current one.
    users.forEach((u, uid) => {
        (Array.isArray(u.walletHistory) ? u.walletHistory : []).forEach(w => {
            const k = String(w).toLowerCase();
            if (!walletToUid.has(k)) walletToUid.set(k, uid);
        });
    });
    users.forEach((u, uid) => {
        const p = personFor(uid, u.walletAddress);
        p.known = true;
        p.label = '@' + (u.username || 'user');
        p.name  = u.fullName || '';
        if (u.walletAddress) p.wallet = String(u.walletAddress).toLowerCase();
    });

    // ── Companies ──────────────────────────────────────────────────────────
    // Only companies that are live or verified become planets. A Studio
    // project someone is still planning is theirs to reveal, not the map's.
    const list = [...companies.entries()]
        .map(([id, c]) => ({ id, ...c }))
        .filter(c => c.projectStatus === 'live' || c.verificationStatus === 'verified')
        .sort((a, b) => secs(a.createdAt) - secs(b.createdAt) || a.id.localeCompare(b.id));

    const planets = list.map(c => ({
        id: c.id, name: c.name || 'Unnamed company', entityType: c.entityType || c.type || '',
        verified: c.verificationStatus === 'verified', live: c.projectStatus === 'live',
        ownerUid: c.ownerUid || null, createdAt: secs(c.createdAt), members: new Map(),
        bountyCounts: { open: 0, active: 0, done: 0 }, bountyTitles: [],
        value: 0, valueFrom: '', valueAt: 0, raised: 0, followers: companyFollowers.get(c.id) || 0
    }));
    const planetById = new Map(planets.map(p => [p.id, p]));

    const member = (planet, person) => {
        if (!planet.members.has(person.key)) planet.members.set(person.key, { person, roles: new Set(), units: 0, nb: 0, wallet: null });
        return planet.members.get(person.key);
    };

    planets.forEach(pl => { if (pl.ownerUid) member(pl, personFor(pl.ownerUid, null)).roles.add('founder'); });

    holders.forEach(h => {
        const pl = planetById.get(h.projectId);
        const units = Number(h.units) || 0;
        if (!pl || !h.wallet || units <= 0) return;
        const m = member(pl, personFor(null, h.wallet));
        m.roles.add('holder');
        m.units = Math.max(m.units, units);
        m.wallet = String(h.wallet).toLowerCase();
    });

    bounties.forEach(b => {
        if (b.planNode) return;
        const pl = planetById.get(b.companyId);
        const done = b.status === 'completed';
        const builderUid = b.acceptedBidderUid || null;
        // A private bounty counts as work done, but its title is not the
        // map's to show, and while open it is not counted as open either.
        const title = b.isPrivate ? 'Private bounty' : clip(b.title || 'Untitled bounty', 120);
        if (pl && !b.isPrivate && when(b.createdAt) >= week) bump(wk.coPosted, pl.id);
        if (done && when(b.completedAt) >= week) { bump(wk.done, builderUid); if (pl) bump(wk.coDone, pl.id); }
        if (pl) {
            if (done) pl.bountyCounts.done++; else if (builderUid) pl.bountyCounts.active++; else if (!b.isPrivate) pl.bountyCounts.open++;
            if (!b.isPrivate && pl.bountyTitles.length < 6) pl.bountyTitles.push({ title, done, active: !!builderUid && !done });
        }
        if (!builderUid) return;
        const person = personFor(builderUid, null);
        person.nb++;
        if (person.bounties.length < 8) person.bounties.push({ title, done, company: pl ? pl.name : '' });
        if (done) {
            person.stats.done++;
            // Cash actually paid for finished work. Equity-only bounties add nothing here.
            const amt = (b.acceptedBid && b.acceptedBid.amount) || b.compensation || '';
            person.stats.usdc += b.compensationType === 'equity' ? 0 : cash(amt);
        }
        if (pl) { const m = member(pl, person); m.roles.add('builder'); m.nb++; }
    });

    // What a company is worth, as far as the platform can tell: the price of
    // the most recent completed deal in its equity, scaled up to the whole
    // company (10,000 units). No deal, no figure — the map never estimates one.
    const price = (pl, perUnit, at, from) => {
        if (!(perUnit > 0) || at < pl.valueAt) return;
        pl.value = perUnit * 10000; pl.valueAt = at; pl.valueFrom = from;
    };
    sales.forEach(l => {
        const pl = planetById.get(l.projectId);
        const units = Number(l.units) || 0;
        if (!pl || l.status !== 'sold' || units <= 0) return;
        const total = Number(l.finalSaleValue) || 0;
        price(pl, total > 0 ? total / units : Number(l.pricePerUnit) || 0, secs(l.soldAt), 'last equity sale');
    });
    funding.forEach(f => {
        const pl = planetById.get(f.companyId || f.projectId);
        const units = Number(f.equityUnits) || 0;
        if (!pl) return;
        const amount = dollars((f.acceptedBid && f.acceptedBid.amount) || f.compensation);
        pl.raised += amount;
        if (units > 0) price(pl, amount / units, secs(f.completedAt) || secs(f.createdAt), 'last funding round');
    });
    // The other side of a funding round: who put the money in.
    funding.forEach(f => {
        if (!f.acceptedBidderUid || !users.has(f.acceptedBidderUid)) return;
        const st = personFor(f.acceptedBidderUid, null).stats;
        st.funded++;
        st.fundedValue += dollars((f.acceptedBid && f.acceptedBid.amount) || f.compensation);
    });
    // Star ratings left after finished work. Only for members the map knows.
    reviews.forEach(rv => {
        const p = rv.revieweeUid && people.get('u:' + rv.revieweeUid);
        const stars = Number(rv.rating);
        if (!p || !(stars >= 1 && stars <= 5)) return;
        p.stats.ratingTotal += stars;
        p.stats.ratingCount++;
    });

    planets.forEach(pl => {
        const work = pl.bountyCounts.done + pl.bountyCounts.active;
        pl.work = work;
        pl.score = 1.1 * Math.log2(1 + pl.members.size) + 0.6 * Math.log2(1 + work) + 0.9 * Math.log10(1 + pl.value)
                 + 0.9 * Math.log2(1 + pl.followers);
        pl.members.forEach(m => m.person.appearances.push({ planet: pl, member: m }));
    });

    // A member's standing across the whole platform.
    people.forEach(p => {
        const st = p.stats;
        st.followers = (p.uid && userFollowers.get(p.uid)) || 0;
        p.appearances.forEach(a => {
            if (!a.member.roles.has('holder') || a.member.units <= 0) return;
            st.stakes++;
            st.stakeValue += a.member.units / 10000 * a.planet.value;
        });
        p.score = 0.9 * Math.log2(1 + st.done) + 0.6 * Math.log10(1 + st.usdc) + 0.8 * Math.log2(1 + st.stakes)
                + 0.6 * Math.log10(1 + st.stakeValue) + 1.0 * Math.log2(1 + st.followers);
    });

    // ── Trending: what moved in the last week ──────────────────────────────
    // Posts, episodes and streams, by this week's likes and comments. A like
    // is dated only on posts liked since likes began being dated (likeDays);
    // for the rest, a post made this week counts all its likes.
    const dayOf = sec => new Date(sec * 1000).toISOString().slice(0, 10);
    const firstDay = dayOf(week);
    const hot = [];
    posts.forEach(p => {
        const t = when(p.createdAt), fresh = t >= week;
        let l7 = 0;
        if (p.likeDays && typeof p.likeDays === 'object') {
            Object.keys(p.likeDays).forEach(d => { if (d >= firstDay) l7 += Number(p.likeDays[d]) || 0; });
            l7 = Math.max(0, l7);
        } else if (fresh) l7 = Math.max(0, Number(p.likes) || 0);
        const c7 = (Array.isArray(p.comments) ? p.comments : []).filter(c => when(c && c.createdAt) >= week).length;
        const live = p.type === 'stream' && p.liveStatus === 'live' && (!p.liveExpiresAt || now < Number(p.liveExpiresAt));
        if (fresh) bump(wk.posts, p.posterUid);
        // A new post starts with one point so it can appear at all; a stream
        // that is on air right now is worth three times its score.
        const score = (l7 + 2 * c7 + (fresh ? 1 : 0) + (live ? 2 : 0)) * (live ? 3 : 1);
        if (score <= 0) return;
        hot.push({ id: p._id, type: p.type || 'idea', title: clip(p.title || 'Untitled', 120), by: clip(p.username || 'user', 40),
                   uid: p.posterUid || null, l7, c7, live: live ? 1 : 0, t, score });
    });
    hot.sort((a, b) => b.score - a.score || b.t - a.t);

    // People: new followers, bounties finished, things posted.
    people.forEach(p => {
        const f7 = (p.uid && wk.userFollows.get(p.uid)) || 0, d7 = (p.uid && wk.done.get(p.uid)) || 0, p7 = (p.uid && wk.posts.get(p.uid)) || 0;
        p.trend = [2 * f7 + 3 * d7 + p7, f7, d7, p7];
    });

    // ── Who goes in the file ───────────────────────────────────────────────
    const ROLE_BIT = { founder: 1, holder: 2, builder: 4 };
    const order = (a, b) => (b.roles.has('founder') - a.roles.has('founder')) || (b.units - a.units) || (b.nb - a.nb) || a.person.key.localeCompare(b.person.key);
    const listed = new Map();          // planet id → members sent
    const keep = new Set();
    // 1. Each company's leading members, leading companies first. Once the
    //    places for company members run out, a company lists its founder only.
    [...planets].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).forEach(pl => {
        const all = [...pl.members.values()].sort(order);
        const top = all.slice(0, keep.size < TIED_MAX ? MEMBERS_PER_COMPANY : 1);
        listed.set(pl.id, top);
        top.forEach(m => keep.add(m.person.key));
    });
    // 1b. Whoever is trending this week, so a newcomer having a moment is
    //     not left out for being new. Added to their company if they have one.
    const addLoose = p => {
        keep.add(p.key);
        if (p.appearances.length) {
            const a = [...p.appearances].sort((x, y) => y.planet.score - x.planet.score)[0];
            listed.get(a.planet.id).push(a.member);
        }
    };
    [...people.values()].filter(p => p.trend[0] > 0 && !keep.has(p.key) && (p.known || p.appearances.length))
        .sort((a, b) => b.trend[0] - a.trend[0] || a.key.localeCompare(b.key)).slice(0, TREND_KEEP).forEach(addLoose);
    // 2. Then the most active of everyone else, until the file is full. If
    //    one of them belongs to a company but was beyond its leading members,
    //    they are added to that company's list so the map can still find them.
    const others = [...people.values()].filter(p => !keep.has(p.key) && (p.known || p.appearances.length))
        .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
    for (const p of others) {
        if (keep.size >= PEOPLE_MAX) break;
        addLoose(p);
    }

    const kept = [...people.values()].filter(p => keep.has(p.key));
    const index = new Map(kept.map((p, i) => [p.key, i]));
    const round2 = n => Math.round(n * 100) / 100;

    const outPeople = kept.map(p => ({
        k: p.key, uid: p.uid || null, label: clip(p.label, 60), name: clip(p.name, 80),
        known: p.known ? 1 : 0, ops: p.ops ? 1 : 0, nb: p.nb, b: p.bounties,
        st: {
            done: p.stats.done, usdc: round2(p.stats.usdc), stakes: p.stats.stakes, stakeValue: round2(p.stats.stakeValue),
            followers: p.stats.followers, funded: p.stats.funded, fundedValue: round2(p.stats.fundedValue),
            rt: p.stats.ratingTotal, rc: p.stats.ratingCount
        },
        score: Math.round(p.score * 1000) / 1000,
        // [score, new followers, bounties finished, posts] this week — only when there is something to say.
        ...(p.trend[0] > 0 ? { tr: p.trend } : {})
    }));

    const outPlanets = planets.map(pl => ({
        id: pl.id, name: clip(pl.name, 80), et: clip(pl.entityType, 40), ver: pl.verified ? 1 : 0, live: pl.live ? 1 : 0,
        owner: pl.ownerUid, value: round2(pl.value), vf: pl.valueFrom, raised: round2(pl.raised), fol: pl.followers,
        bc: [pl.bountyCounts.open, pl.bountyCounts.active, pl.bountyCounts.done], bt: pl.bountyTitles,
        score: Math.round(pl.score * 1000) / 1000, work: pl.work, mc: pl.members.size,
        m: listed.get(pl.id).map(m => [index.get(m.person.key),
            [...m.roles].reduce((bits, r) => bits | ROLE_BIT[r], 0), m.units, m.nb])
    }));

    // Never sent: the addresses the contract check needs.
    const wallets = new Map();
    planets.forEach(pl => wallets.set(pl.id, listed.get(pl.id)
        .map(m => ({ key: m.person.key, wallet: m.wallet || m.person.wallet }))
        .filter(x => x.wallet && /^0x[0-9a-f]{40}$/.test(x.wallet))));

    // ── Open listings (public ones only) ───────────────────────────────────
    // The Marketplace's own rule for "open", minus anything private.
    const listings = [];
    const take = (p, type) => {
        if (CLOSED_STATUS.includes(p.status) || p.isPrivate) return;
        if (p.planNode === true && !p.acceptedBidderUid) return;
        const coId = type === 'fund' ? (p.companyId || p.projectId) : p.companyId;
        const pl = planetById.get(coId) || null;
        listings.push({
            id: p._id, type, co: pl ? pl.id : null,
            title: clip(p.title || (type === 'fund' ? 'Untitled funding request' : 'Untitled bounty'), 140),
            pay: clip(p.compensation, 80), value: cash(p.compensation),
            poster: clip(p.posterUsername || p.posterName || '', 40), bids: Array.isArray(p.bids) ? p.bids.length : 0,
            t: secs(p.createdAt),
            text: clip([p.title, p.description, p.category, p.posterUsername, p.compensation, (p.tags || []).join(' '), pl ? pl.name : '']
                .join(' ').toLowerCase().replace(/\s+/g, ' '), 400)
        });
    };
    bounties.forEach(p => take(p, 'build'));
    fundAll.forEach(p => take(p, 'fund'));
    listings.sort((a, b) => b.t - a.t);

    // Companies: new followers, bounties posted and finished this week, and
    // what is open right now.
    const openBy = new Map();
    listings.forEach(l => bump(openBy, l.co));
    outPlanets.forEach(o => {
        const f7 = wk.companyFollows.get(o.id) || 0, b7 = wk.coPosted.get(o.id) || 0, d7 = wk.coDone.get(o.id) || 0, open = openBy.get(o.id) || 0;
        const score = 2 * f7 + 2 * b7 + 3 * d7 + open;
        if (score > 0) o.tr = [score, f7, b7, d7, open];
    });

    // ── Recent activity, for the feed ──────────────────────────────────────
    const uname = uid => { const u = users.get(uid); return u ? '@' + (u.username || 'user') : 'Someone'; };
    const shown = new Map(planets.map(p => [p.id, p.name]));
    const events = [];
    const push = (t, icon, text, actors, comps, target) => {
        if (t > 0) events.push({ t, icon, text: clip(text, 220), actors: actors.filter(Boolean), comps: comps.filter(Boolean), target });
    };
    bounties.forEach(b => {
        if (b.planNode || b.isPrivate) return;
        const owner = b.ownerUid || b.posterUid, builder = b.acceptedBidderUid;
        const co = shown.has(b.companyId) ? b.companyId : null;
        const title = '“' + clip(b.title || 'Untitled bounty', 100) + '”', forCo = co ? ' for ' + shown.get(co) : '';
        push(secs(b.createdAt), '📋', `${uname(owner)} posted a bounty: ${title}`, [owner], [co], co ? { node: 'c:' + co } : { uid: owner });
        if (builder) push(secs(b.acceptedAt), '🤝', `${uname(builder)} was chosen for ${title}${forCo}`, [builder, owner], [co], { uid: builder });
        if (builder && b.status === 'completed') push(secs(b.completedAt), '✅', `${uname(builder)} completed ${title}${forCo}`, [builder, owner], [co], { uid: builder });
    });
    planets.forEach(p => push(p.createdAt, '🚀', `${uname(p.ownerUid)} started ${p.name}`, [p.ownerUid], [p.id], { node: 'c:' + p.id }));
    sales.forEach(l => { if (l.status === 'sold' && shown.has(l.projectId)) push(secs(l.soldAt), '📈', `A stake in ${shown.get(l.projectId)} changed hands`, [], [l.projectId], { node: 'c:' + l.projectId }); });
    funding.forEach(f => {
        const id = f.companyId || f.projectId;
        if (shown.has(id)) push(secs(f.completedAt) || secs(f.createdAt), '💰', `${shown.get(id)} closed a funding round`, [f.ownerUid], [id], { node: 'c:' + id });
    });
    events.sort((a, b) => b.t - a.t);

    const tied = [...people.values()];
    const snapshot = {
        v: 1, at: now,
        counts: {
            members: users.size, companies: planets.length,
            holders: tied.filter(p => p.appearances.some(a => a.member.roles.has('holder'))).length,
            builders: tied.filter(p => p.nb > 0).length,
            // Members who exist but were not sent because the file was full.
            peopleLeftOut: tied.filter(p => p.known && !keep.has(p.key)).length,
            listings: listings.length
        },
        people: outPeople, planets: outPlanets,
        listings: listings.slice(0, LISTINGS_MAX), events: events.slice(0, EVENTS_MAX),
        hot: hot.slice(0, HOT_POSTS_MAX)
    };
    return { snapshot, wallets };
}

// ── Loading and caching ────────────────────────────────────────────────────
let CACHE = null;          // { at, body, etag, wallets }
let BUILDING = null;       // one build at a time, shared by everyone waiting
const CHAIN = new Map();   // company id → { at, body }

async function loadRaw(db) {
    const asMap  = snap => { const m = new Map(); snap.forEach(d => m.set(d.id, d.data())); return m; };
    const asList = snap => { const a = []; snap.forEach(d => a.push(Object.assign({ _id: d.id }, d.data()))); return a; };
    // Only the fields the map uses are fetched, which keeps this quick even
    // when the documents themselves are large.
    const [users, companies, holders, subprojects, sales, follows, reviews, posts] = await Promise.all([
        db.collection('users').select('username', 'fullName', 'walletAddress', 'walletHistory').get(),
        db.collection('companies').select('name', 'entityType', 'type', 'verificationStatus', 'projectStatus', 'ownerUid', 'createdAt').get(),
        db.collection('equityHolders').select('projectId', 'wallet', 'units').get(),
        db.collection('subprojects').where('type', 'in', ['build', 'fund'])
            .select('type', 'status', 'planNode', 'isPrivate', 'companyId', 'projectId', 'ownerUid', 'posterUid', 'posterUsername', 'posterName',
                    'acceptedBidderUid', 'acceptedBid', 'compensation', 'compensationType', 'equityUnits', 'title', 'description', 'category',
                    'tags', 'bids', 'createdAt', 'acceptedAt', 'completedAt').get(),
        db.collection('equityListings').where('status', '==', 'sold').select('projectId', 'status', 'units', 'finalSaleValue', 'pricePerUnit', 'soldAt').get(),
        db.collection('follows').select('followingUid', 'followingCompanyId', 'createdAt').get(),
        db.collection('reviews').select('revieweeUid', 'rating').get(),
        // Recent posts only, for what is trending.
        db.collection('posts').where('createdAt', '>=', new Date(Date.now() - POSTS_LOOKBACK_DAYS * 86400000))
            .select('title', 'type', 'username', 'posterUid', 'likes', 'likeDays', 'comments', 'createdAt', 'liveStatus', 'liveExpiresAt').get()
    ]);
    return {
        users: asMap(users), companies: asMap(companies), holders: asList(holders), subprojects: asList(subprojects),
        sales: asList(sales), follows: asList(follows), reviews: asList(reviews), posts: asList(posts)
    };
}

async function getSnapshot() {
    if (CACHE && Date.now() - CACHE.at < SNAPSHOT_TTL_MS) return CACHE;
    if (!BUILDING) {
        BUILDING = (async () => {
            const { snapshot, wallets } = buildSnapshot(await loadRaw(getAdminDb()));
            const body = JSON.stringify(snapshot);
            CACHE = { at: Date.now(), body, wallets, etag: '"' + crypto.createHash('sha1').update(body.replace(/"at":\d+/, '')).digest('hex').slice(0, 20) + '"' };
            return CACHE;
        })().finally(() => { BUILDING = null; });
    }
    try { return await BUILDING; }
    catch (e) {
        // A failed rebuild should not take the map down while an older
        // summary is still in hand.
        if (CACHE) { console.error('nqverse: rebuild failed, serving the last summary:', e.message); return CACHE; }
        throw e;
    }
}

async function companyStakes(companyId) {
    const hit = CHAIN.get(companyId);
    if (hit && Date.now() - hit.at < CHAIN_TTL_MS) return hit.body;
    const cache = await getSnapshot();
    const members = cache.wallets.get(companyId);
    if (!members) return null;
    const provider = new ethers.providers.JsonRpcProvider(ARBITRUM_RPC);
    const registry = new ethers.Contract(EQUITY_REGISTRY_ADDRESS, REGISTRY_ABI, provider);
    const cid = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(companyId));
    const units = {};
    await Promise.all(members.slice(0, 80).map(async x => { units[x.key] = (await registry.balances(cid, x.wallet)).toNumber(); }));
    const body = { ok: true, company: companyId, units, at: Date.now() };
    CHAIN.set(companyId, { at: Date.now(), body });
    if (CHAIN.size > 500) CHAIN.delete(CHAIN.keys().next().value);
    return body;
}

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const company = req.query && req.query.company;
    try {
        if (company !== undefined) {
            if (typeof company !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(company)) return res.status(400).json({ error: 'Bad company id' });
            const body = await companyStakes(company);
            if (!body) return res.status(404).json({ error: 'Unknown company' });
            res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
            return res.status(200).json(body);
        }

        const cache = await getSnapshot();
        // The CDN answers for a minute, and keeps answering with the last copy
        // while it fetches a new one, so visitors never wait on a rebuild.
        res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=600');
        res.setHeader('ETag', cache.etag);
        if (req.headers['if-none-match'] === cache.etag) return res.status(304).end();
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.status(200).send(cache.body);

    } catch (e) {
        console.error('nqverse error:', e.message);
        return res.status(500).json({ error: company !== undefined ? 'Could not read the contract' : 'Could not build the NQVerse' });
    }
}

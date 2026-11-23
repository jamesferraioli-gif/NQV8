// api/remove-post.js
//
// Admin removal of an Explore post — including a podcast episode or a live
// stream — that breaks the content rules.
//
// Firestore's rules let only a post's author delete it, which is right for
// ordinary use and leaves no way to take down something that should not be
// there. This is that way. The admin check is here, against the caller's
// verified Firebase token; the button in the page only decides what is drawn.
//
// For a live stream the Daily room is deleted as well, which ends the
// broadcast for everyone watching. A removed post is kept in removedPosts
// with who removed it and why, so a takedown can always be reviewed.

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { verifyCaller } from './_auth.js';

/// Must match ADMIN_UIDS in index.html.
const ADMIN_UIDS = ['5t0gD2wVnqXXPAQEzfoahx3EIPp2'];

function db() {
    if (!getApps().length) {
        initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    }
    return getFirestore();
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const caller = await verifyCaller(req, { allowService: false });
    if (!caller || !caller.uid) return res.status(401).json({ error: 'Unauthorized' });
    if (!ADMIN_UIDS.includes(caller.uid)) return res.status(403).json({ error: 'Admins only' });

    const { postId, reason } = req.body || {};
    if (!postId || typeof postId !== 'string' || postId.includes('/')) return res.status(400).json({ error: 'postId required' });
    const why = String(reason || '').trim().slice(0, 500);
    if (why.length < 3) return res.status(400).json({ error: 'A reason is required' });

    try {
        const store = db();
        const ref   = store.collection('posts').doc(postId);
        const snap  = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Post not found' });
        const post = snap.data();

        // End a live broadcast first: the video is the urgent part.
        let roomClosed = null;
        if (post.type === 'stream' && post.liveRoomName && process.env.DAILY_API_KEY) {
            try {
                const r = await fetch(`https://api.daily.co/v1/rooms/${encodeURIComponent(post.liveRoomName)}`, {
                    method: 'DELETE', headers: { 'Authorization': `Bearer ${process.env.DAILY_API_KEY}` }
                });
                roomClosed = r.ok || r.status === 404;
            } catch (e) { roomClosed = false; }
        }

        await store.collection('removedPosts').doc(postId).set({
            post, removedBy: caller.uid, reason: why, roomClosed, removedAt: FieldValue.serverTimestamp()
        });
        await ref.delete();

        if (post.posterUid) {
            await store.collection('notifications').add({
                recipientUid: post.posterUid, type: 'moderation', read: false,
                message: `Your ${post.type === 'stream' ? 'stream' : post.type === 'podcast' ? 'episode' : 'post'} “${String(post.title || '').slice(0, 80)}” was removed for breaking the content rules: ${why}`,
                createdAt: FieldValue.serverTimestamp()
            }).catch(e => console.warn('remove-post: notify failed:', e.message));
        }

        console.log('Post removed by', caller.uid, postId, '|', why);
        return res.status(200).json({ success: true, roomClosed });
    } catch (e) {
        console.error('remove-post failed:', e.message);
        return res.status(500).json({ error: 'Could not remove the post' });
    }
}

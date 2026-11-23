// api/create-stream.js
//
// Opens a live stream room: one broadcaster, everyone else watching.
//
// It is the same Daily.co service the 1:1 video chat uses (create-room.js),
// set up differently:
//
//   - The room's default permission is "cannot send". Anyone who opens the
//     room link can watch and listen, and cannot turn on a camera or mic.
//   - The streamer gets an owner token, returned only to them, which is what
//     lets them broadcast. Without it the room link is view-only.
//   - Daily's built-in chat is off. Comments happen under the stream on
//     NQVate, where they are moderated and cost 1 NQV8 like any other comment.
//
// COST. Daily bills per participant-minute and every viewer counts: 50
// viewers for one hour is 3,000 minutes. The two caps below bound what a
// single stream can cost. Raise them deliberately.

import { verifyCaller } from './_auth.js';

const MAX_VIEWERS      = 50;             // people in the room at once, streamer included
const MAX_SECONDS      = 2 * 60 * 60;    // a stream is cut off after two hours
const DAILY            = 'https://api.daily.co/v1';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // A signed-in person, not a server secret: a stream belongs to someone.
    const caller = await verifyCaller(req, { allowService: false });
    if (!caller || !caller.uid) return res.status(401).json({ error: 'Unauthorized' });

    if (!process.env.DAILY_API_KEY) {
        return res.status(500).json({ error: 'Live video is not configured' });
    }
    const auth = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DAILY_API_KEY}` };
    const displayName = String((req.body && req.body.displayName) || 'Host').replace(/[^\w @.\-]/g, '').slice(0, 40) || 'Host';

    try {
        const exp  = Math.floor(Date.now() / 1000) + MAX_SECONDS;
        const name = `nqvate-live-${String(caller.uid).replace(/[^a-zA-Z0-9]/g, '').slice(0, 10)}-${Date.now()}`;

        const roomRes = await fetch(`${DAILY}/rooms`, {
            method: 'POST', headers: auth,
            body: JSON.stringify({
                name,
                privacy: 'public',
                properties: {
                    exp,
                    eject_at_room_exp:  true,
                    max_participants:   MAX_VIEWERS,
                    permissions:        { canSend: false },     // viewers watch; only the owner token can broadcast
                    enable_chat:        false,
                    enable_screenshare: true,
                    enable_recording:   false,
                    start_video_off:    true,
                    start_audio_off:    true,
                    lang:               'en'
                }
            })
        });
        if (!roomRes.ok) {
            const err = await roomRes.json().catch(() => ({}));
            console.error('create-stream: room failed:', roomRes.status, JSON.stringify(err));
            return res.status(502).json({ error: err.info || err.error || 'Could not open a live room' });
        }
        const room = await roomRes.json();

        const tokRes = await fetch(`${DAILY}/meeting-tokens`, {
            method: 'POST', headers: auth,
            body: JSON.stringify({
                properties: {
                    room_name: room.name, is_owner: true, exp, eject_at_token_exp: true,
                    user_name: displayName, start_video_off: false, start_audio_off: false
                }
            })
        });
        if (!tokRes.ok) {
            const err = await tokRes.json().catch(() => ({}));
            console.error('create-stream: token failed:', tokRes.status, JSON.stringify(err));
            // Do not leave a room nobody can broadcast in.
            await fetch(`${DAILY}/rooms/${room.name}`, { method: 'DELETE', headers: auth }).catch(() => {});
            return res.status(502).json({ error: 'Could not start the broadcast' });
        }
        const { token } = await tokRes.json();

        return res.status(200).json({ url: room.url, name: room.name, token, expires: exp, maxViewers: MAX_VIEWERS });
    } catch (e) {
        console.error('create-stream failed:', e.message);
        return res.status(500).json({ error: 'Could not start the stream' });
    }
}

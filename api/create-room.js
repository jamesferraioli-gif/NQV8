// api/create-room.js
// Creates a Daily.co video room for a chat session.
// Room expires after 1 hour automatically.
// Free tier: 2,000 participant minutes/month.

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { chatId } = req.body;
    if (!chatId) return res.status(400).json({ error: 'chatId required' });

    if (!process.env.DAILY_API_KEY) {
        return res.status(500).json({ error: 'Daily.co API key not configured' });
    }

    try {
        const expiry = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

        const response = await fetch('https://api.daily.co/v1/rooms', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.DAILY_API_KEY}`
            },
            body: JSON.stringify({
                name:       `nqvate-${chatId}-${Date.now()}`,
                privacy:    'public',
                properties: {
                    exp:                    expiry,
                    max_participants:       2,
                    enable_chat:            false,
                    enable_screenshare:     true,
                    enable_recording:       false,
                    start_video_off:        false,
                    start_audio_off:        false,
                    lang:                   'en'
                }
            })
        });

        if (!response.ok) {
            const err = await response.json();
            return res.status(500).json({ error: err.error || 'Failed to create room' });
        }

        const room = await response.json();
        return res.json({ url: room.url, name: room.name, expires: expiry });

    } catch(e) {
        console.error('create-room failed:', e.message);
        return res.status(500).json({ error: e.message });
    }
}

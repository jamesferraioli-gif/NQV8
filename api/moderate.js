async function moderateContent(text, contentType = 'post') {
        try {
            const response = await fetch('/api/moderate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, contentType })
            });
            if (!response.ok) throw new Error('API unavailable - status: ' + response.status);
            const result = await response.json();
            console.log('Moderation result:', JSON.stringify(result), 'for text:', text.substring(0, 50));
            return result;
        } catch(e) {
            console.warn('Moderation check failed:', e.message);
            return { approved: true };
        }
    }

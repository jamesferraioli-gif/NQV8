// api/_ai.js
// One Anthropic caller for every AI feature.
//
// Every endpoint used to inline its own fetch and then do:
//     const text = data.content?.find(c => c.type === 'text')?.text || '';
//     JSON.parse(text)
// which turned a bad model name, a missing API key, a rate limit, an
// overloaded_error and a malformed completion into the same opaque
// "Unexpected end of JSON input". This surfaces the real cause instead.

const ANTHROPIC_URL     = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Keep every feature on one model string so a deprecation is a one-line fix
// rather than a hunt through five files. generate-flowmap sat on a retired
// snapshot for months precisely because it was declared locally.
export const AI_MODEL = 'claude-sonnet-5';

/**
 * Errors worth another attempt. Anything else is a bug, not bad luck.
 *
 * Takes the thrown Error so it can read the status code we attached, rather
 * than grepping the message for "500" — a message like "received 5041
 * characters" or "truncated at the 4500-token limit" contains those digits and
 * would be misclassified as a retryable server error.
 */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

export function isRetryableAIError(err) {
    if (err && typeof err === 'object' && typeof err.status === 'number') {
        return RETRYABLE_STATUS.has(err.status);
    }
    // Fallback for transport failures, which carry no status. Only distinctive
    // phrases — never bare numbers.
    const m = String(err?.message ?? err ?? '').toLowerCase();
    return m.includes('rate limit')
        || m.includes('overloaded')
        || m.includes('timed out')
        || m.includes('fetch failed')
        || m.includes('econnreset')
        || m.includes('socket hang up')
        || m.includes('network');
}

/**
 * Call Anthropic and return the assistant's text.
 * Throws with a message that names the actual failure.
 */
export async function callAnthropicText({ messages, system, maxTokens = 4000, model = AI_MODEL, timeoutMs = 240000 }) {
    if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY is not configured');
    }

    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
        response = await fetch(ANTHROPIC_URL, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'Content-Type':      'application/json',
                'x-api-key':         process.env.ANTHROPIC_API_KEY,
                'anthropic-version': ANTHROPIC_VERSION
            },
            body: JSON.stringify({
                model,
                max_tokens: maxTokens,
                ...(system ? { system } : {}),
                messages
            })
        });
    } catch (e) {
        clearTimeout(timer);
        if (e.name === 'AbortError') throw new Error(`Anthropic request timed out after ${timeoutMs}ms`);
        throw new Error(`Anthropic request failed: ${e.message}`);
    }
    clearTimeout(timer);

    if (!response.ok) {
        const raw = await response.text().catch(() => '');
        let detail = raw.slice(0, 300);
        try {
            const parsed = JSON.parse(raw);
            if (parsed?.error?.message) detail = parsed.error.message;
        } catch { /* keep the raw body */ }
        const err = new Error(`Anthropic API ${response.status}: ${detail}`);
        err.status = response.status;
        throw err;
    }

    const data = await response.json();
    if (data.error) throw new Error(`Anthropic API error: ${data.error.message || 'unknown'}`);

    const text = data.content?.find(c => c.type === 'text')?.text || '';
    if (!text) throw new Error('Anthropic returned no text content');

    // A completion cut off at the token ceiling is the single most confusing
    // failure to debug, because the text that comes back looks fine until the
    // parser reaches the end. Name it rather than letting it surface as
    // "did not return valid JSON".
    if (data.stop_reason === 'max_tokens') {
        throw new Error(
            `Response was truncated at the ${maxTokens}-token limit — raise maxTokens for this job kind ` +
            `(received ${text.length} characters)`
        );
    }

    return text;
}

/** Same call, but the completion is expected to be a JSON object. */
export async function callAnthropicJSON(opts) {
    const text  = await callAnthropicText(opts);
    const clean = text.replace(/```json|```/g, '').trim();
    try {
        return JSON.parse(clean);
    } catch {
        throw new Error(`Model did not return valid JSON: ${clean.slice(0, 200)}`);
    }
}

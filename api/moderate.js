export default async function handler(req) {
    return new Response(JSON.stringify({ 
        approved: false, 
        reason: 'Function is alive - key: ' + (process.env.ANTHROPIC_API_KEY ? 'present' : 'missing')
    }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
    });
}

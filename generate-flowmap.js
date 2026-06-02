export const config = { runtime: 'edge' };

export default async function handler(req) {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    try {
        const { name, description, stack } = await req.json();

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 4000,
                messages: [{
                    role: 'user',
                    content: `You are a senior software architect and product manager. Generate a detailed development flow map for the following project.

Project Name: ${name}
Tech Stack: ${stack || 'Not specified'}
Description: ${description}

Return ONLY a JSON object with this exact structure (no markdown, no explanation):
{
  "nodes": [
    {
      "title": "Short node title",
      "description": "2-3 sentence description of what this step involves",
      "category": "one of: Frontend, Backend, Database, Auth, API, Infrastructure, Testing, Design, Marketing, Legal, Other",
      "priority": "high or normal",
      "estimatedHours": number or null,
      "dependencies": ["titles of nodes this depends on"],
      "instructions": "Detailed step-by-step instructions for completing this node. Be specific and technical. 3-6 sentences.",
      "bestPractices": ["array of 3-5 specific best practices for this step"],
      "pitfalls": ["array of 2-4 common mistakes to avoid"],
      "tools": ["array of recommended libraries, tools, or services"],
      "status": "todo"
    }
  ]
}

Generate 8-16 nodes ordered logically from foundation to launch. Each node should be a discrete, buildable unit of work. Be specific to the tech stack and project type described.`
                }]
            })
        });

        const data = await response.json();
        const text = data.content?.find(c => c.type === 'text')?.text || '';
        const clean = text.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(clean);

        return new Response(JSON.stringify(parsed), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch(e) {
        return new Response(JSON.stringify({ error: e.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

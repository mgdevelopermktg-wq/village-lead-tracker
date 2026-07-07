/**
 * ai-chat.js
 * Handles AI Lead Intelligence chat via the Anthropic API.
 * Accepts { messages, leadsContext } from the frontend.
 * Supports multi-turn conversation history.
 */

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const body = JSON.parse(event.body || '{}');

    // Accept either { messages, leadsContext } (frontend) or { query, leads_summary } (legacy)
    const messages     = body.messages || [];
    const leadsContext = body.leadsContext || body.leads_summary || '';
    const query        = body.query || (messages.filter(m => m.role === 'user').pop()?.content) || '';

    if (!query) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'query is required' }) };
    }

    const systemPrompt = `You are a luxury real estate sales intelligence assistant for The Village at Coral Gables — a $3M+ residence development by MG Developer in Miami. You help the sales team analyze their lead pipeline.

Current lead data:
${leadsContext || 'No lead data available.'}

Ranks: HOT (high intent), WARM (engaged), COLD (no engagement yet).
Funnel stages: new → contacted → presentation → sale.

Be concise and data-driven. Highlight actionable insights. Use a confident, professional tone matching a premium brand. Avoid listing raw contact info.`;

    // Build messages for multi-turn — use full history if provided, else single query
    const anthropicMessages = messages.length
      ? messages.map(m => ({ role: m.role, content: m.content }))
      : [{ role: 'user', content: query }];

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        system: systemPrompt,
        messages: anthropicMessages,
      }),
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error?.message || 'Anthropic API error');

    const reply = data.content?.[0]?.text || 'No response generated.';

    // Return as `reply` — matches frontend's data.reply check
    return { statusCode: 200, headers, body: JSON.stringify({ reply }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

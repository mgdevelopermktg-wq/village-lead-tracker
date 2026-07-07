/**
 * ai-chat.js
 * Handles AI Lead Intelligence chat via the Anthropic API.
 * Accepts { messages, leadsContext } from the frontend.
 * Returns { reply, filter_ids } — filter_ids is an array of lead IDs to highlight on the dashboard, or null.
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

Current lead data (leads include [ID:X] format for filtering):
${leadsContext || 'No lead data available.'}

Ranks: HOT (high intent), WARM (engaged), COLD (no engagement yet).
Funnel stages: new → contacted → presentation → sale.

IMPORTANT: You MUST respond with valid JSON only — no markdown, no code blocks, no extra text. Use this exact format:
{"reply":"your response here","filter_ids":null}

Rules for filter_ids:
- Set to an array of numeric lead IDs (e.g. [12, 47, 83]) when the user asks to SHOW, FIND, FILTER, LIST, or HIGHLIGHT specific leads on the dashboard
- Set to null for general questions, analysis, strategy advice, or summaries that don't require filtering the list
- Extract IDs from the [ID:X] tags in the lead data above

In your reply: be concise and data-driven. Use a confident, professional tone matching a premium brand. Avoid listing raw contact info. Use line breaks for readability.`;

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
        max_tokens: 1000,
        system: systemPrompt,
        messages: anthropicMessages,
      }),
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error?.message || 'Anthropic API error');

    const rawText = data.content?.[0]?.text || '{}';
    let reply = 'No response generated.';
    let filter_ids = null;

    try {
      // Strip any accidental markdown fences
      const cleaned = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
      const parsed = JSON.parse(cleaned);
      reply = parsed.reply || rawText;
      filter_ids = Array.isArray(parsed.filter_ids) ? parsed.filter_ids : null;
    } catch (e) {
      // Fallback: use raw text as reply, no filter
      reply = rawText;
    }

    return { statusCode: 200, headers, body: JSON.stringify({ reply, filter_ids }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

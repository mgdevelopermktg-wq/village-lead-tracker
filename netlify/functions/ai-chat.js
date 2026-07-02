/**
 * ai-chat.js
 * Handles AI Lead Intelligence chat queries via the Anthropic API.
 * Receives the user query + a compact leads summary, returns a text answer.
 */

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { query, leads_summary } = JSON.parse(event.body || '{}');

    if (!query) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'query is required' }) };
    }

    const systemPrompt = `You are a luxury real estate sales intelligence assistant for The Village at Coral Gables — a $3M+ residence development by MG Developer in Miami. You help the sales team analyze their lead pipeline.

You have access to a CSV-style leads summary (name|rank|funnel|source|agent|last_note_date).

Ranks: HOT (high intent), WARM (engaged), COLD (no engagement yet).
Funnel stages: new → contacted → presentation → sale.

Be concise and data-driven. Highlight actionable insights. When listing leads, use names sparingly and avoid raw PII in summaries. Use a confident, professional tone that matches a premium brand.`;

    const userMessage = `Lead data (name|rank|funnel|source|agent|last_note_date):
${leads_summary || 'No leads available.'}

Question: ${query}`;

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
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      throw new Error(data.error?.message || 'Anthropic API error');
    }

    const answer = data.content?.[0]?.text || 'No response generated.';
    return { statusCode: 200, headers, body: JSON.stringify({ answer }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

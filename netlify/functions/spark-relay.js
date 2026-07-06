/**
 * spark-relay.js
 * Posts a note to the Spark CRM Notes section.
 * Requires a valid contact_id — name-based search was removed (unreliable).
 */

const SPARK_API = 'https://api.spark.re/v2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function sparkAuth() {
  return {
    'Authorization': `Token token="${process.env.SPARK_API_KEY}"`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

function flattenError(obj) {
  if (!obj) return 'unknown';
  if (typeof obj === 'string') return obj;
  if (obj.errors)  return Array.isArray(obj.errors) ? obj.errors.join(', ') : String(obj.errors);
  if (obj.error)   return typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error);
  if (obj.message) return obj.message;
  return JSON.stringify(obj);
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { contact_id, note, timestamp } = JSON.parse(event.body || '{}');

    if (!contact_id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'contact_id is required' }) };
    if (!note)       return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'note is required' }) };

    const occurred_at = timestamp || new Date().toISOString();
    const teamId = parseInt(process.env.SPARK_TEAM_MEMBER_ID) || undefined;

    // POST to /v2/notes (flat payload, "text" field)
    const resp = await fetch(`${SPARK_API}/notes`, {
      method: 'POST',
      headers: sparkAuth(),
      body: JSON.stringify({
        contact_id,
        text: note,
        occurred_at,
        ...(teamId && { team_member_id: teamId }),
      }),
    });

    if (resp.status === 200 || resp.status === 201) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
    }

    const errData = await resp.json().catch(() => ({}));
    return { statusCode: resp.status, headers: CORS, body: JSON.stringify({ error: flattenError(errData) }) };

  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};

/**
 * spark-relay.js
 * Posts a free-form note to Spark CRM.
 * Tries /v2/notes first; falls back to /v2/contacts/{id}/notes.
 * Returns detailed error strings so the UI can display them.
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
  if (!obj) return 'unknown error';
  if (typeof obj === 'string') return obj;
  // Spark returns { errors: ["msg"] } or { error: "msg" } or { message: "msg" }
  if (obj.errors) return Array.isArray(obj.errors) ? obj.errors.join(', ') : String(obj.errors);
  if (obj.error)   return typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error);
  if (obj.message) return obj.message;
  return JSON.stringify(obj);
}

async function findContactByName(name) {
  const url = `${SPARK_API}/contacts?filters[search]=${encodeURIComponent(name)}&per_page=10`;
  const resp = await fetch(url, { headers: sparkAuth() });
  if (!resp.ok) return null;
  const data = await resp.json();
  const list = data.contacts || data.data || (Array.isArray(data) ? data : []);
  if (!list.length) return null;

  const target = name.toLowerCase().trim();
  const exact = list.find(c =>
    `${c.first_name||''} ${c.last_name||''}`.toLowerCase().trim() === target
  );
  if (exact) return exact;
  return list.find(c => {
    const full = `${c.first_name||''} ${c.last_name||''}`.toLowerCase().trim();
    return full.includes(target) || target.includes(full);
  }) || list[0];
}

async function postNote(sparkId, note, teamMemberId, timestamp) {
  const occurred_at = timestamp || new Date().toISOString();
  const attempts = [
    // Attempt 1: flat /v2/notes with contact_id
    {
      url: `${SPARK_API}/notes`,
      body: { note: { contact_id: sparkId, body: note, team_member_id: teamMemberId, occurred_at } },
    },
    // Attempt 2: nested /v2/contacts/{id}/notes
    {
      url: `${SPARK_API}/contacts/${sparkId}/notes`,
      body: { note: { body: note, team_member_id: teamMemberId, occurred_at } },
    },
    // Attempt 3: nested without team_member_id (may be optional)
    {
      url: `${SPARK_API}/contacts/${sparkId}/notes`,
      body: { note: { body: note, occurred_at } },
    },
  ];

  let lastErr = null;
  for (const attempt of attempts) {
    const resp = await fetch(attempt.url, {
      method: 'POST',
      headers: sparkAuth(),
      body: JSON.stringify(attempt.body),
    });
    if (resp.status === 200 || resp.status === 201) {
      const data = await resp.json().catch(() => ({}));
      return { ok: true, data, endpoint: attempt.url };
    }
    const errBody = await resp.json().catch(() => ({}));
    lastErr = { status: resp.status, body: errBody, endpoint: attempt.url };
  }
  return { ok: false, error: lastErr };
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { contact_id, note, name, timestamp } = JSON.parse(event.body || '{}');
    if (!note) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'note is required' }) };

    let sparkId = contact_id || null;
    let resolvedFromSearch = false;

    if (!sparkId && name) {
      const contact = await findContactByName(name);
      if (contact) { sparkId = contact.id; resolvedFromSearch = true; }
    }

    if (!sparkId) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({
        error: name ? `"${name}" not found in Spark` : 'No contact_id or name provided',
      })};
    }

    const teamMemberId = parseInt(process.env.SPARK_TEAM_MEMBER_ID) || null;
    const result = await postNote(sparkId, note, teamMemberId, timestamp);

    if (result.ok) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({
        success: true,
        spark_id: sparkId,
        resolved_from_search: resolvedFromSearch,
        endpoint_used: result.endpoint,
      })};
    }

    return { statusCode: result.error.status || 500, headers: CORS, body: JSON.stringify({
      error: `Spark ${result.error.status}: ${flattenError(result.error.body)} (tried ${result.error.endpoint})`,
    })};

  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};

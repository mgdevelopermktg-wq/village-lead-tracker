/**
 * spark-relay.js — posts a note to Spark CRM
 * Tries endpoints in order, returns the first success.
 * Returns the actual Spark error string if all fail.
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
  if (obj.errors) return Array.isArray(obj.errors) ? obj.errors.join(', ') : String(obj.errors);
  if (obj.error)  return typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error);
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

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { contact_id, note, name, timestamp } = JSON.parse(event.body || '{}');
    if (!note) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'note is required' }) };

    // Resolve Spark contact ID
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

    const occurred_at = timestamp || new Date().toISOString();
    const teamId   = parseInt(process.env.SPARK_TEAM_MEMBER_ID) || undefined;
    const projectId = process.env.SPARK_PROJECT_ID || undefined;
    const typeId   = parseInt(process.env.SPARK_INTERACTION_TYPE_ID) || undefined;

    // Try endpoints in order — first success wins
    // Spark uses flat (unwrapped) payloads; notes use "text" not "body"
    const attempts = [
      // 1. Notes endpoint — "text" is the required field name
      {
        url: `${SPARK_API}/notes`,
        body: { contact_id: sparkId, text: note, occurred_at, ...(teamId && {team_member_id: teamId}) },
      },
      // 2. Interactions endpoint — flat payload, contact_id at root
      {
        url: `${SPARK_API}/interactions`,
        body: { contact_id: sparkId, note, occurred_at, ...(teamId && {team_member_id: teamId}), ...(typeId && {interaction_type_id: typeId}) },
      },
      // 3. Project-scoped notes
      ...(projectId ? [{
        url: `${SPARK_API}/projects/${projectId}/contacts/${sparkId}/notes`,
        body: { contact_id: sparkId, text: note, occurred_at, ...(teamId && {team_member_id: teamId}) },
      }] : []),
    ];

    const errors = [];
    for (const attempt of attempts) {
      const resp = await fetch(attempt.url, {
        method: 'POST', headers: sparkAuth(), body: JSON.stringify(attempt.body),
      });
      if (resp.status === 200 || resp.status === 201) {
        const data = await resp.json().catch(() => ({}));
        return { statusCode: 200, headers: CORS, body: JSON.stringify({
          success: true, spark_id: sparkId, resolved_from_search: resolvedFromSearch,
          endpoint_used: attempt.url,
        })};
      }
      const errBody = await resp.json().catch(() => ({}));
      errors.push(`${resp.status} @ ${attempt.url}: ${flattenError(errBody)}`);
    }

    return { statusCode: 422, headers: CORS, body: JSON.stringify({
      error: 'All Spark endpoints failed',
      detail: errors.join(' | '),
    })};

  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};

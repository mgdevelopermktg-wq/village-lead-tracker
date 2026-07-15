/**
 * spark-relay.js
 * Posts a note to Spark CRM Notes section.
 * Automatically attributes each note to the lead's assigned team member
 * by looking up the contact before posting. Falls back to
 * SPARK_TEAM_MEMBER_ID env var if no assignment is found.
 */

const SPARK_API = 'https://api.spark.re/v2';
const PROJECT_ID = process.env.SPARK_PROJECT_ID || '2167';

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
  if (obj.error) return typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error);
  if (obj.message) return obj.message;
  return JSON.stringify(obj);
}

function normName(s) {
  return (s || '').toLowerCase().replace(/[^a-z\s]/g, '').trim().replace(/\s+/, ' ');
}

async function findContactByName(name) {
  const target = normName(name);
  const parts = name.trim().split(/\s+/);
  const last = parts.slice(1).join(' ');
  const params = new URLSearchParams({ per_page: '50', 'filters[search]': last || name });
  const url = `${SPARK_API}/contacts?${params}`;
  const r = await fetch(url, { headers: sparkAuth() });
  if (!r.ok) return null;
  const data = await r.json();
  const list = data.contacts || data.data || (Array.isArray(data) ? data : []);
  if (!list.length) return null;
  return list.find(c =>
    normName(`${c.first_name || ''} ${c.last_name || ''}`) === target
  ) || null;
}

/** Returns the Spark team_member id assigned to this contact, or null. */
async function getContactTeamMemberId(sparkId) {
  try {
    const r = await fetch(`${SPARK_API}/contacts/${sparkId}`, { headers: sparkAuth() });
    if (!r.ok) return null;
    const contact = await r.json();
    const members = contact.team_members || [];
    return members.length ? members[0].id : null;
  } catch {
    return null;
  }
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { contact_id, note, name, timestamp } = JSON.parse(event.body || '{}');
    if (!note) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'note is required' }) };

    let sparkId = contact_id || null;
    let resolvedFromSearch = false;

    // Auto-search by name if no spark_id stored
    if (!sparkId && name) {
      const contact = await findContactByName(name);
      if (contact) { sparkId = contact.id; resolvedFromSearch = true; }
    }

    if (!sparkId) {
      return {
        statusCode: 404, headers: CORS,
        body: JSON.stringify({
          error: name
            ? `"${name}" not found in Spark — link manually below`
            : 'contact_id required',
        }),
      };
    }

    // Look up team member for correct attribution; fall back to env var default
    const assignedId = await getContactTeamMemberId(sparkId);
    const teamId = assignedId || parseInt(process.env.SPARK_TEAM_MEMBER_ID) || undefined;

    const resp = await fetch(`${SPARK_API}/notes`, {
      method: 'POST',
      headers: sparkAuth(),
      body: JSON.stringify({
        contact_id: sparkId,
        text: note,
        occurred_at: timestamp || new Date().toISOString(),
        ...(teamId && { team_member_id: teamId }),
      }),
    });

    if (resp.status === 200 || resp.status === 201) {
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({
          success: true,
          spark_id: sparkId,
          resolved_from_search: resolvedFromSearch,
        }),
      };
    }

    const errData = await resp.json().catch(() => ({}));
    return { statusCode: resp.status, headers: CORS, body: JSON.stringify({ error: flattenError(errData) }) };

  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};

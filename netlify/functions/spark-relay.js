/**
 * spark-relay.js
 * Posts a note to Spark CRM.
 * If contact_id is missing, searches Spark by name to find the contact.
 * Returns the resolved spark_id so the frontend can cache it.
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

async function findContactByName(name) {
  const url = `${SPARK_API}/contacts?filters[search]=${encodeURIComponent(name)}&per_page=10`;
  const resp = await fetch(url, { headers: sparkAuth() });
  if (!resp.ok) return null;
  const data = await resp.json();
  const list = data.contacts || data.data || (Array.isArray(data) ? data : []);
  if (!list.length) return null;

  const target = name.toLowerCase().trim();
  // Exact match first
  const exact = list.find(c => `${c.first_name||''} ${c.last_name||''}`.toLowerCase().trim() === target);
  if (exact) return exact;
  // Partial fallback
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

    let sparkId = contact_id || null;
    let resolvedFromSearch = false;

    if (!sparkId && name) {
      const contact = await findContactByName(name);
      if (contact) { sparkId = contact.id; resolvedFromSearch = true; }
    }

    if (!sparkId) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({
        error: 'Contact not found in Spark',
        detail: name ? `No contact matched "${name}"` : 'No contact_id or name provided'
      })};
    }

    const payload = {
      interaction: {
        contact_id: sparkId,
        interaction_type_id: parseInt(process.env.SPARK_INTERACTION_TYPE_ID),
        team_member_id: parseInt(process.env.SPARK_TEAM_MEMBER_ID),
        note,
        occurred_at: timestamp || new Date().toISOString(),
      }
    };

    const resp = await fetch(`${SPARK_API}/interactions`, {
      method: 'POST',
      headers: sparkAuth(),
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) return { statusCode: resp.status, headers: CORS, body: JSON.stringify({ error: data }) };

    return { statusCode: 200, headers: CORS, body: JSON.stringify({
      success: true,
      interaction: data,
      spark_id: sparkId,
      resolved_from_search: resolvedFromSearch,
    })};

  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};

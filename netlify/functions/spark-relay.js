/**
 * spark-relay.js
 * Proxies note POST requests from the browser to the Spark API.
 * Replaces the local spark_relay.py server.
 *
 * Automatically attributes each note to the lead's assigned team member
 * by fetching the contact from Spark before creating the interaction.
 * Falls back to SPARK_TEAM_MEMBER_ID env var if no assignment is found.
 */

const SPARK_API = 'https://api.spark.re/v2';

async function sparkGet(path) {
  const resp = await fetch(`${SPARK_API}${path}`, {
    headers: {
      Authorization: `Token token="${process.env.SPARK_API_KEY}"`,
      Accept: 'application/json',
    },
  });
  if (!resp.ok) throw new Error(`Spark ${path} → ${resp.status}`);
  return resp.json();
}

export const handler = async (event) => {
  // CORS headers so the browser can call this function
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { contact_id, note, timestamp } = JSON.parse(event.body || '{}');

    if (!contact_id || !note) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'contact_id and note are required' }) };
    }

    // Look up the contact's assigned team member so the note is attributed correctly.
    // Fall back to the default env var if Spark returns no assignment.
    let teamMemberId = parseInt(process.env.SPARK_TEAM_MEMBER_ID);
    try {
      const contact = await sparkGet(`/contacts/${contact_id}`);
      if (contact.team_members && contact.team_members.length > 0) {
        teamMemberId = contact.team_members[0].id;
      }
    } catch (lookupErr) {
      console.warn(`Could not fetch team member for contact ${contact_id}:`, lookupErr.message);
      // Non-fatal — proceed with the default team member
    }

    const payload = {
      interaction: {
        contact_id,
        interaction_type_id: parseInt(process.env.SPARK_INTERACTION_TYPE_ID),
        team_member_id: teamMemberId,
        note,
        occurred_at: timestamp || new Date().toISOString(),
      }
    };

    const resp = await fetch(`${SPARK_API}/interactions`, {
      method: 'POST',
      headers: {
        'Authorization': `Token token="${process.env.SPARK_API_KEY}"`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await resp.json();

    if (!resp.ok) {
      return { statusCode: resp.status, headers, body: JSON.stringify({ error: data }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, interaction: data }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

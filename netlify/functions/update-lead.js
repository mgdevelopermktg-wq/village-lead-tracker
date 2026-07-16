/**
 * update-lead.js
 * Saves edits to a lead (rank, agent, funnel, notes, etc.) to Supabase.
 * Called from the tracker whenever a user saves changes.
 */

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Tracker-Key',
  'Content-Type': 'application/json',
};

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const key = event.headers?.['x-tracker-key'] || event.queryStringParameters?.key;
  if (!key || key !== process.env.TRACKER_KEY) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { id, ...fields } = JSON.parse(event.body || '{}');

    if (!id) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Lead id is required' }) };
    }

    // Only allow safe fields to be updated
    const allowed = ['rank', 'funnel', 'agent', 'notes', 'last_note_date', 'rating', 'source', 'type'];
    const update = {};
    for (const key of allowed) {
      if (fields[key] !== undefined) update[key] = fields[key];
    }
    update.updated_at = new Date().toISOString();

    const { error } = await supabase
      .from('leads')
      .update(update)
      .eq('spark_id', id);

    if (error) throw error;

    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

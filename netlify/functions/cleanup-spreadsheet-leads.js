/**
 * cleanup-spreadsheet-leads.js — ONE-TIME USE, DELETE AFTER RUNNING
 * Removes all leads that have no spark_id (came from spreadsheet, not Spark CRM).
 * Call via: GET /.netlify/functions/cleanup-spreadsheet-leads
 */

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

export const handler = async (event) => {
  // Safety check — must pass ?confirm=yes
  const confirm = event.queryStringParameters?.confirm;
  if (confirm !== 'yes') {
    // First: show what WOULD be deleted, without deleting anything
    const { data: preview, error: previewError } = await supabase
      .from('leads')
      .select('id, name, rank, funnel, cls, week')
      .is('spark_id', null)
      .order('rank');

    if (previewError) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: previewError.message }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: `DRY RUN — ${preview.length} leads would be deleted. Add ?confirm=yes to actually delete.`,
        leads: preview,
      }),
    };
  }

  // Actually delete
  const { data: deleted, error } = await supabase
    .from('leads')
    .delete()
    .is('spark_id', null)
    .select('id, name, rank, cls');

  if (error) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      message: `Done: deleted ${deleted.length} spreadsheet-only leads. Spark leads remain untouched.`,
      deleted,
    }),
  };
};

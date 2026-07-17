/**
 * migrate-to-new-supabase.js — TEMPORARY, DELETE AFTER USE
 *
 * Copies all rows from the OLD Supabase leads table to the NEW one.
 * Old credentials: SUPABASE_URL + SUPABASE_SECRET_KEY (current env vars)
 * New credentials: NEW_SUPABASE_URL + NEW_SUPABASE_SECRET_KEY (new env vars)
 *
 * Run once, then delete this file.
 */

import { createClient } from '@supabase/supabase-js';

const headers = {
  'Content-Type': 'application/json',
};

export const handler = async (event) => {
  const key = event.headers?.['x-tracker-key'] || event.queryStringParameters?.key;
  if (!key || key !== process.env.TRACKER_KEY) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    // Old Supabase client (source)
    const oldSupabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SECRET_KEY
    );

    // New Supabase client (destination)
    const newSupabase = createClient(
      process.env.NEW_SUPABASE_URL,
      process.env.NEW_SUPABASE_SECRET_KEY
    );

    // Read all leads from old project
    const { data: leads, error: readError } = await oldSupabase
      .from('leads')
      .select('*')
      .order('created_at', { ascending: true });

    if (readError) throw new Error(`Read error: ${readError.message}`);
    if (!leads || leads.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'No leads found in old database', count: 0 }),
      };
    }

    // Strip the auto-generated id so new project assigns its own
    const rows = leads.map(({ id, ...rest }) => rest);

    // Insert into new project in batches of 50
    const batchSize = 50;
    let inserted = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const { error: writeError } = await newSupabase
        .from('leads')
        .upsert(batch, { onConflict: 'spark_id' });
      if (writeError) throw new Error(`Write error at batch ${i}: ${writeError.message}`);
      inserted += batch.length;
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        total: leads.length,
        inserted,
        message: `Migrated ${inserted} leads to new Supabase project`,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};

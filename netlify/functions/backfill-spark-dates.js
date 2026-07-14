/**
 * backfill-spark-dates.js
 * One-time admin function — fixes created_at for leads that were bulk-imported
 * via the old Python script without a Spark date (Supabase used server default).
 *
 * Trigger: GET /.netlify/functions/backfill-spark-dates?secret=<BACKFILL_SECRET>
 * Add BACKFILL_SECRET as a Netlify environment variable (any string you choose).
 *
 * Safe to re-run: skips leads that already have a valid Spark date
 * (created_at without microsecond precision).
 */

import { createClient } from '@supabase/supabase-js';

const SPARK_API = 'https://api.spark.re/v2';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

async function sparkGet(path) {
  const resp = await fetch(`${SPARK_API}${path}`, {
    headers: {
      Authorization: `Token token="${process.env.SPARK_API_KEY}"`,
      Accept: 'application/json',
    },
  });
  if (!resp.ok) throw new Error(`Spark ${path} => ${resp.status}`);
  return resp.json();
}

// Microsecond-precision timestamps (.123456) indicate the Supabase
// server default was used rather than the real Spark date.
function isFallbackDate(ts) {
  return typeof ts === 'string' && /\.\d{6}/.test(ts);
}

export const handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };

  const secret = event.queryStringParameters?.secret;
  if (!secret || secret !== process.env.BACKFILL_SECRET) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const { data: leads, error: fetchErr } = await supabase
      .from('leads')
      .select('id, spark_id, created_at');

    if (fetchErr) throw fetchErr;

    const toFix = leads.filter(l => isFallbackDate(l.created_at));
    console.log(`${leads.length} total leads; ${toFix.length} need backfill`);

    if (!toFix.length) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Nothing to backfill', total: leads.length }),
      };
    }

    const results = { updated: 0, skipped: 0, errors: [] };

    for (const lead of toFix) {
      try {
        const contact = await sparkGet(`/contacts/${lead.spark_id}`);
        const sparkDate = contact.created_at;

        if (!sparkDate) {
          results.skipped++;
          continue;
        }

        const { error: updateErr } = await supabase
          .from('leads')
          .update({ created_at: sparkDate })
          .eq('id', lead.id);

        if (updateErr) throw updateErr;
        results.updated++;
      } catch (err) {
        results.errors.push({ spark_id: lead.spark_id, error: err.message });
      }

      await new Promise(r => setTimeout(r, 50));
    }

    console.log('Backfill complete:', results);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: `Backfill complete: ${results.updated} updated, ${results.skipped} skipped, ${results.errors.length} errors`,
        details: results,
      }),
    };

  } catch (err) {
    console.error('Backfill failed:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

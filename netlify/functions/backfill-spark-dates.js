/**
 * backfill-spark-dates.js
 * One-time admin function — fixes created_at for leads bulk-imported without a
 * Spark date (Supabase used server default, identifiable by microsecond precision).
 *
 * Processes in batches of 20 (parallel) to stay within Netlify's 30s timeout.
 * Run each batch sequentially by incrementing ?batch=0, ?batch=1, etc.
 *
 * Usage:
 *   GET /.netlify/functions/backfill-spark-dates?secret=<BACKFILL_SECRET>&batch=0
 *   GET /.netlify/functions/backfill-spark-dates?secret=<BACKFILL_SECRET>&batch=1
 *   ... repeat until message says "Nothing to backfill"
 *
 * Safe to re-run: skips leads that already have a valid Spark date.
 */

import { createClient } from '@supabase/supabase-js';

const SPARK_API = 'https://api.spark.re/v2';
const BATCH_SIZE = 20;

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

// Microsecond-precision timestamps (.123456) = Supabase server default fallback
function isFallbackDate(ts) {
  return typeof ts === 'string' && /\.\d{6}/.test(ts);
}

export const handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };

  const secret = event.queryStringParameters?.secret;
  if (!secret || secret !== process.env.BACKFILL_SECRET) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const batchNum = parseInt(event.queryStringParameters?.batch || '0', 10);

  try {
    const { data: leads, error: fetchErr } = await supabase
      .from('leads')
      .select('id, spark_id, created_at');

    if (fetchErr) throw fetchErr;

    const toFix = leads.filter(l => isFallbackDate(l.created_at));
    const totalToFix = toFix.length;

    if (!totalToFix) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Nothing to backfill — all dates are correct', total: leads.length }),
      };
    }

    const batch = toFix.slice(batchNum * BATCH_SIZE, (batchNum + 1) * BATCH_SIZE);
    const hasMore = totalToFix > (batchNum + 1) * BATCH_SIZE;

    if (!batch.length) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: `Batch ${batchNum} out of range — backfill complete`, totalRemaining: totalToFix }),
      };
    }

    console.log(`Batch ${batchNum}: processing ${batch.length} of ${totalToFix} leads`);

    const results = await Promise.all(batch.map(async (lead) => {
      try {
        const contact = await sparkGet(`/contacts/${lead.spark_id}`);
        const sparkDate = contact.created_at;

        if (!sparkDate) {
          return { spark_id: lead.spark_id, status: 'skipped', reason: 'no Spark date' };
        }

        const { error: updateErr } = await supabase
          .from('leads')
          .update({ created_at: sparkDate })
          .eq('id', lead.id);

        if (updateErr) throw updateErr;
        return { spark_id: lead.spark_id, status: 'updated', date: sparkDate };

      } catch (err) {
        return { spark_id: lead.spark_id, status: 'error', error: err.message };
      }
    }));

    const updated = results.filter(r => r.status === 'updated').length;
    const skipped = results.filter(r => r.status === 'skipped').length;
    const errors  = results.filter(r => r.status === 'error').length;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        batch: batchNum,
        processed: batch.length,
        updated,
        skipped,
        errors,
        totalRemaining: hasMore ? totalToFix - (batchNum + 1) * BATCH_SIZE : 0,
        hasMore,
        nextBatch: hasMore ? batchNum + 1 : null,
      }),
    };

  } catch (err) {
    console.error('Backfill failed:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

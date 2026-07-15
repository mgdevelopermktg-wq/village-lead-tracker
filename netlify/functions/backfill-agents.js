/**
 * backfill-agents.js
 * One-time admin function — refreshes the agent field for ALL leads from Spark.
 * Fetches team_members[0] from Spark's /contacts/{id} detail endpoint and writes
 * the result back to Supabase regardless of the current agent value.
 *
 * Processes in batches of 20 (parallel) to stay within Netlify's 30s timeout.
 * Always use ?batch=0 — the DB shrinks between calls as leads are processed.
 *
 * Usage:
 *   GET /.netlify/functions/backfill-agents?secret=<BACKFILL_SECRET>&batch=0
 *   ... repeat until totalRemaining === 0
 *
 * Safe to re-run: already-correct agent values will simply be overwritten with
 * the same value from Spark.
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
  if (!resp.ok) throw new Error(`Spark ${path} → ${resp.status}`);
  return resp.json();
}

function deriveAgent(contact) {
  const members = contact.team_members;
  if (!members || !members.length) return '';
  return `${members[0].first_name || ''} ${members[0].last_name || ''}`.trim();
}

export const handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };

  const secret = event.queryStringParameters?.secret;
  if (!secret || secret !== process.env.BACKFILL_SECRET) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  // Track which spark_ids have already been processed in this run
  // (passed as comma-separated query param so repeated batch=0 calls don't re-process)
  const doneParam = event.queryStringParameters?.done || '';
  const alreadyDone = new Set(doneParam ? doneParam.split(',') : []);

  try {
    const { data: leads, error: fetchErr } = await supabase
      .from('leads')
      .select('id, spark_id, agent, name');

    if (fetchErr) throw fetchErr;

    // Exclude leads processed in this run
    const toProcess = leads.filter(l => !alreadyDone.has(String(l.spark_id)));
    const total = leads.length;
    const remaining = toProcess.length;

    if (!remaining) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'All leads processed', total }),
      };
    }

    const batch = toProcess.slice(0, BATCH_SIZE);
    const hasMore = remaining > BATCH_SIZE;

    console.log(`Processing ${batch.length} of ${remaining} remaining leads`);

    const results = await Promise.all(batch.map(async (lead) => {
      try {
        const contact = await sparkGet(`/contacts/${lead.spark_id}`);
        const agent = deriveAgent(contact);

        const { error: updateErr } = await supabase
          .from('leads')
          .update({ agent })
          .eq('id', lead.id);

        if (updateErr) throw updateErr;
        return { spark_id: lead.spark_id, name: lead.name, status: 'updated', agent };

      } catch (err) {
        return { spark_id: lead.spark_id, name: lead.name, status: 'error', error: err.message };
      }
    }));

    const updated = results.filter(r => r.status === 'updated').length;
    const errors  = results.filter(r => r.status === 'error').length;
    const newDone = [...alreadyDone, ...batch.map(l => String(l.spark_id))].join(',');

    console.log(`Batch done: ${updated} updated, ${errors} errors`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        processed: batch.length,
        updated,
        errors,
        totalLeads: total,
        remaining: remaining - batch.length,
        hasMore,
        // Pass nextDone back so the caller can include it in the next request
        nextDone: hasMore ? newDone : null,
        details: results,
      }),
    };

  } catch (err) {
    console.error('Agent backfill failed:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

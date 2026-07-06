/**
 * bulk-link-spark.js
 * One-time endpoint: fetches ALL contacts from Spark, matches them
 * against leads in Supabase that have no spark_id, and updates the DB.
 */

import { createClient } from '@supabase/supabase-js';

const SPARK_API  = 'https://api.spark.re/v2';
const PROJECT_ID = process.env.SPARK_PROJECT_ID;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

function sparkAuth() {
  return {
    'Authorization': `Token token="${process.env.SPARK_API_KEY}"`,
    'Accept': 'application/json',
  };
}

function normName(s) {
  return (s || '').toLowerCase().replace(/[^a-z\s]/g,'').trim().replace(/\s+/,' ');
}

async function fetchAllSparkContacts() {
  const contacts = [];
  let page = 1;
  const debugPages = [];

  while (true) {
    // Try both the project-scoped and global endpoints
    const url = `${SPARK_API}/contacts?project_id=${PROJECT_ID}&per_page=100&page=${page}`;
    const r = await fetch(url, { headers: sparkAuth() });
    const status = r.status;
    const data = await r.json().catch(() => ({}));
    debugPages.push({ page, status, url, keys: Object.keys(data) });

    if (!r.ok) {
      return { contacts, debugPages, error: `Spark ${status}: ${JSON.stringify(data)}` };
    }

    const list = data.contacts || data.data || (Array.isArray(data) ? data : []);
    if (!list.length) break;
    contacts.push(...list);
    if (list.length < 100) break;
    page++;
  }
  return { contacts, debugPages };
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SECRET_KEY
    );

    const { contacts: sparkContacts, debugPages, error: fetchErr } = await fetchAllSparkContacts();

    if (fetchErr || !sparkContacts.length) {
      return {
        statusCode: 500, headers: CORS,
        body: JSON.stringify({ error: fetchErr || 'No Spark contacts returned', project_id: PROJECT_ID, debugPages }),
      };
    }

    // Build name → id map
    const sparkMap = {};
    for (const c of sparkContacts) {
      const full = normName(`${c.first_name||''} ${c.last_name||''}`);
      const rev  = normName(`${c.last_name||''} ${c.first_name||''}`);
      if (full) sparkMap[full] = c.id;
      if (rev && rev !== full) sparkMap[rev] = c.id;
    }

    // Fetch leads from Supabase with no spark_id
    const { data: leads, error: leadsErr } = await supabase
      .from('leads')
      .select('id, name, spark_id')
      .is('spark_id', null);

    if (leadsErr) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: leadsErr.message }) };

    // Match and update
    const matched = [], unmatched = [];
    for (const lead of leads) {
      const key    = normName(lead.name);
      const sparkId = sparkMap[key] || null;
      if (sparkId) {
        await supabase.from('leads').update({ spark_id: sparkId }).eq('id', lead.id);
        matched.push({ name: lead.name, spark_id: sparkId });
      } else {
        unmatched.push(lead.name);
      }
    }

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        spark_contacts_fetched: sparkContacts.length,
        leads_without_spark_id: leads.length,
        matched: matched.length,
        unmatched: unmatched.length,
        matched_list: matched,
        unmatched_list: unmatched,
      }),
    };

  } catch (err) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};

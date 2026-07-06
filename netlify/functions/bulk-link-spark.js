/**
 * bulk-link-spark.js
 * One-time endpoint: fetches ALL contacts from Spark project, matches them
 * against leads in Supabase that have no spark_id, and updates the DB.
 * GET /.netlify/functions/bulk-link-spark
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
  while (true) {
    const url = `${SPARK_API}/projects/${PROJECT_ID}/contacts?per_page=100&page=${page}`;
    const r = await fetch(url, { headers: sparkAuth() });
    if (!r.ok) break;
    const data = await r.json();
    const list = data.contacts || data.data || (Array.isArray(data) ? data : []);
    if (!list.length) break;
    contacts.push(...list);
    // If fewer than 100 returned, we've hit the last page
    if (list.length < 100) break;
    page++;
  }
  return contacts;
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // 1. Fetch all Spark contacts for this project
    const sparkContacts = await fetchAllSparkContacts();
    if (!sparkContacts.length) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'No Spark contacts returned', project_id: PROJECT_ID }) };
    }

    // Build name → id map (full name and last,first variants)
    const sparkMap = {};
    for (const c of sparkContacts) {
      const full = normName(`${c.first_name||''} ${c.last_name||''}`);
      const rev  = normName(`${c.last_name||''} ${c.first_name||''}`);
      if (full) sparkMap[full] = c.id;
      if (rev)  sparkMap[rev]  = c.id;
    }

    // 2. Fetch leads from Supabase with no spark_id
    const { data: leads, error: leadsErr } = await supabase
      .from('leads')
      .select('id, name, spark_id')
      .is('spark_id', null);

    if (leadsErr) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: leadsErr.message }) };

    // 3. Match and update
    const matched = [], unmatched = [];
    for (const lead of leads) {
      const key = normName(lead.name);
      const sparkId = sparkMap[key] || null;
      if (sparkId) {
        await supabase.from('leads').update({ spark_id: sparkId }).eq('id', lead.id);
        matched.push({ name: lead.name, spark_id: sparkId });
      } else {
        unmatched.push(lead.name);
      }
    }

    return {
      statusCode: 200,
      headers: CORS,
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

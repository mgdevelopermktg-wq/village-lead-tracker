/**
 * weekly-import.js
 * Scheduled Netlify Function — runs every Monday at 8am ET.
 * Fetches new contacts from Spark added in the last 7 days,
 * filters junk, and inserts valid leads into Supabase.
 *
 * Replaces weekly_import.py + run_weekly_import.bat entirely.
 * No computer needs to be on. No script needs to be run manually.
 */

import { createClient } from '@supabase/supabase-js';

const SPARK_API = 'https://api.spark.re/v2';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

// ── Junk filter ────────────────────────────────────────────────────────────────

const JUNK_RE = /^\d{3}[-.\.\s]?\d{3}[-.\.\s]?\d{4}$|^wireless caller|^tollfree|^unavailable|^unknown|^no name|^[A-Z\s]+\s+[A-Z]{2}$/i;

function isJunk(contact) {
  const first = (contact.first_name || '').trim();
  const last  = (contact.last_name  || '').trim();
  const full  = `${first} ${last}`.trim();
  if (!full || full === 'Unknown') return true;
  if (JUNK_RE.test(full)) return true;
  const hasContact = !!(contact.email || contact.phone || contact.mobile_phone);
  const hasRealLastName = !!last && last !== last.toUpperCase();
  return !hasContact && !hasRealLastName;
}

// ── Spark helpers ──────────────────────────────────────────────────────────────

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

// ── Field mapping ──────────────────────────────────────────────────────────────

function deriveSource(c)  { return (c.marketing_source || '').trim(); }
function deriveType(c)    { return c.agent ? 'Agent/Broker' : 'Client'; }
function deriveLastNote(c){ return (c.last_interaction_date || '').slice(0, 10); }
function deriveRank(c)    { return c.last_interaction_date ? 'WARM' : 'COLD'; }
function deriveFunnel(c)  { return c.last_interaction_date ? 'contacted' : 'new'; }

function deriveNotes(c) {
  const fields = c.question_answers || [];
  return fields
    .filter(f => f.name && f.value)
    .map(f => `${f.name}: ${f.value}`)
    .join(' | ');
}

function weekLabel(sinceDate) {
  const since = new Date(sinceDate);
  const now   = new Date();
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const s = `${months[since.getMonth()]} ${since.getDate()}`;
  const e = `${months[now.getMonth()]} ${now.getDate()}`;
  return `${s}-${e}`;
}

// ── Main ───────────────────────────────────────────────────────────────────────

export const handler = async () => {
  console.log('Weekly import started:', new Date().toISOString());

  try {
    // Determine since date (7 days ago)
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const sinceStr = since.toISOString().slice(0, 10);
    const label = weekLabel(sinceStr);
    console.log(`Fetching contacts since ${sinceStr}`);

    // Fetch existing spark_ids to avoid duplicates
    const { data: existingLeads } = await supabase.from('leads').select('spark_id');
    const existingIds = new Set((existingLeads || []).map(l => l.spark_id));

    // Fetch new contacts from Spark
    const newContacts = [];
    let page = 1;
    let reachedCutoff = false;

    while (!reachedCutoff) {
      const data = await sparkGet(`/contacts?per_page=100&page=${page}&order=created_at&direction=desc`);
      const batch = Array.isArray(data) ? data : (data.data || []);
      if (!batch.length) break;

      for (const c of batch) {
        const created = new Date(c.created_at || 0);
        if (created < since) { reachedCutoff = true; break; }
        newContacts.push(c);
      }

      if (batch.length < 100) break;
      page++;
    }

    console.log(`${newContacts.length} contacts found since ${sinceStr}`);

    // Filter junk and already-imported
    const toImport = newContacts
      .filter(c => !isJunk(c))
      .filter(c => !existingIds.has(c.id));

    console.log(`${toImport.length} valid new leads to import`);

    if (!toImport.length) {
      return { statusCode: 200, body: 'No new leads to import' };
    }

    // Fetch full detail for each (for team_members and question_answers)
    const rows = [];
    for (const c of toImport) {
      let full = c;
      try {
        full = await sparkGet(`/contacts/${c.id}`);
      } catch (e) {
        console.warn(`Could not fetch full detail for ${c.id}:`, e.message);
      }

      rows.push({
        spark_id:       full.id,
        week:           label,
        name:           `${(full.first_name || '').trim()} ${(full.last_name || '').trim()}`.trim() || 'Unknown',
        agent:          (full.team_members && full.team_members[0])
                          ? `${full.team_members[0].first_name} ${full.team_members[0].last_name}`.trim()
                          : '',
        source:         deriveSource(full),
        type:           deriveType(full),
        rating:         '',
        cls:            'MQL',
        rank:           deriveRank(full),
        funnel:         deriveFunnel(full),
        last_note_date: deriveLastNote(full),
        notes:          deriveNotes(full),
        created_at:     full.created_at || new Date().toISOString(),
        updated_at:     new Date().toISOString(),
      });
    }

    const { error } = await supabase.from('leads').insert(rows);
    if (error) throw error;

    console.log(`✓ ${rows.length} leads inserted into Supabase`);
    return { statusCode: 200, body: `Imported ${rows.length} leads` };

  } catch (err) {
    console.error('Weekly import failed:', err);
    return { statusCode: 500, body: err.message };
  }
};

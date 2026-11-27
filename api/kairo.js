// Kairo, the job-matching agent: AI chat with tools, single JSON answers, and live web job search.
// Uses the same ANTHROPIC_API_KEY as AI feedback. Only signed-in (registered) ARS members can use it.
import { json, fail, session } from '../lib/core.js';
import { getDoc, setDoc } from '../lib/store.js';

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.KAIRO_MODEL || process.env.AI_MODEL || 'claude-sonnet-5-5';
const MODEL_DEEP = process.env.KAIRO_MODEL_DEEP || MODEL;
const LIMIT = { chat: Number(process.env.KAIRO_DAILY || 300), hunt: Number(process.env.KAIRO_HUNTS || 8) };

export async function GET() { return json({ ready: !!KEY }); }

async function spend(uid, kind) {
  const day = new Date().toISOString().slice(0, 10), rk = `sys/rate/k${kind}-${uid}-${day}`;
  const used = ((await getDoc(rk)) || {}).n || 0;
  if (used >= LIMIT[kind]) return false;
  await setDoc(rk, { n: used + 1 }); return true;
}

export async function anthropic(body) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body)
  });
  if (!r.ok) { const t = await r.text(); const e = new Error(t.slice(0, 200)); e.code = r.status === 429 ? 'rate_limited' : 'ai_error'; throw e; }
  return r.json();
}
const textOf = out => (out.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
export function parseJson(text) {
  const s = String(text || '').trim();
  try { return JSON.parse(s); } catch {}
  const f = s.match(/```(?:json)?\s*([\s\S]*?)```/); if (f) { try { return JSON.parse(f[1]); } catch {} }
  const i = Math.min(...['{', '['].map(c => { const k = s.indexOf(c); return k < 0 ? Infinity : k; })), j = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (i < Infinity && j > i) { try { return JSON.parse(s.slice(i, j + 1)); } catch {} }
  return undefined;
}
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'job';
const https = u => /^https:\/\//i.test(String(u || '')) ? String(u) : '';

export async function POST(request) {
  const s = session(request); if (!s || !s.reg) return fail(401, 'no_session', 'Sign in to ARS to use Kairo.');
  if (!KEY) return fail(503, 'not_configured', 'Kairo is being switched on. Please try again soon.');
  const a = new URL(request.url).searchParams.get('a');
  const raw = await request.text(); if (raw.length > 400000) return fail(413, 'too_large');
  let b = {}; try { b = JSON.parse(raw); } catch { return fail(400, 'bad_json'); }
  if (process.env.MOCK_KAIRO) return mock(a, b);   // local test runs only

  try {
    if (a === 'chat') {
      if (!(await spend(s.uid, 'chat'))) return fail(429, 'rate_limited', "You've reached today's Kairo limit. It resets tomorrow.");
      const messages = Array.isArray(b.messages) ? b.messages : []; if (!messages.length) return fail(400, 'bad_messages');
      const body = { model: b.tier === 'complex' ? MODEL_DEEP : MODEL, max_tokens: 4000, messages };
      if (b.system) body.system = String(b.system).slice(0, 60000);
      if (Array.isArray(b.tools) && b.tools.length) body.tools = b.tools.slice(0, 16).map(t => ({ name: String(t.name), description: String(t.description || ''), input_schema: t.input_schema || { type: 'object', properties: {} } }));
      const out = await anthropic(body);
      return json({ content: out.content || [], stop_reason: out.stop_reason });
    }

    if (a === 'hunt') {
      if (!(await spend(s.uid, 'hunt'))) return fail(429, 'rate_limited', "You've used today's live searches. More tomorrow.");
      const brief = String(b.brief || '').slice(0, 600);
      const today = new Date().toISOString().slice(0, 10);
      const prompt = `Today is ${today}. Find currently open job vacancies for this candidate brief:\n${brief}\n${b.country ? 'Country: ' + b.country : ''}
Search the web (company careers pages and job boards such as LinkedIn, Indeed, Naukri, foundit, Glassdoor and the country's main boards). Only include postings that the search results show as posted within the last 30 days and still open. Never invent a posting, company, link, recruiter or salary.
Reply with only JSON: {"jobs":[{"company":"","title":"","reqId":"","experience":"as written","expMin":null,"expMax":null,"location":"","workMode":"On-site|Hybrid|Remote|","postedDate":"YYYY-MM-DD or empty","applyUrl":"https://...","sourceUrl":"https://...","domain":"","skills":["6-12 skills from the posting"],"jd":"your own 300-700 character summary of the posting"}]}
Up to 10 jobs, best fits first. If you find none, reply {"jobs":[]}.`;
      let messages = [{ role: 'user', content: prompt }], out, text = '';
      for (let round = 0; round < 3; round++) {
        out = await anthropic({ model: MODEL, max_tokens: 4000, messages, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }] });
        text += textOf(out);
        if (out.stop_reason !== 'pause_turn') break;
        messages = [...messages, { role: 'assistant', content: out.content }];
      }
      const got = parseJson(text) || {};
      const ids = [];
      for (const j of (Array.isArray(got.jobs) ? got.jobs : []).slice(0, 10)) {
        const applyUrl = https(j.applyUrl) || https(j.sourceUrl); if (!j.company || !j.title || !applyUrl) continue;
        const id = slug(`${j.company}-${j.title}-${j.reqId || ''}`);
        await setDoc('kjobs/' + id, {
          company: String(j.company), title: String(j.title), reqId: String(j.reqId || ''), experience: String(j.experience || ''),
          expMin: Number.isFinite(+j.expMin) && j.expMin !== null ? +j.expMin : null, expMax: Number.isFinite(+j.expMax) && j.expMax !== null ? +j.expMax : null,
          location: String(j.location || ''), workMode: String(j.workMode || ''), postedDate: String(j.postedDate || ''), verifiedOn: today, status: 'open',
          domain: String(j.domain || ''), applyUrl, sourceUrl: https(j.sourceUrl) || applyUrl, verifyNote: 'Found by live web search — confirm on the apply page',
          skills: (Array.isArray(j.skills) ? j.skills : []).map(String).slice(0, 14), jd: String(j.jd || '').slice(0, 1200),
          recruiter: {}, contact: {}, recruiterSearchUrl: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(j.company + ' talent acquisition')}`, addedOn: today
        });
        ids.push(id);
      }
      return json({ ids });
    }
    return fail(400, 'bad_request');
  } catch (e) {
    return fail(502, e.code || 'ai_error', e.code === 'rate_limited' ? 'Kairo is busy just now. Please try again in a minute.' : 'Kairo could not finish that. Please try again.');
  }
}

/* canned answers for local tests (MOCK_KAIRO=1) */
async function mock(a, b) {
  if (a === 'hunt') {
    const today = new Date().toISOString().slice(0, 10);
    await setDoc('kjobs/mock-bank-senior-ba-sql', { company: 'Mock Bank', title: 'Senior Business Analyst – Regulatory Reporting (SQL)', location: 'Pune', workMode: 'Hybrid', experience: '10–14 years', postedDate: today, verifiedOn: today, status: 'open', applyUrl: 'https://example.com/apply', sourceUrl: 'https://example.com/job', skills: ['SQL', 'COREP', 'Data lineage'], jd: 'Requirements, SQL reconciliation and COREP reporting.', recruiter: {}, contact: {}, addedOn: today });
    return json({ ids: ['mock-bank-senior-ba-sql'] });
  }
  const msgs = b.messages || [], last = msgs[msgs.length - 1] || {}, lastText = JSON.stringify(last.content || '');
  if (b.system) {
    if (lastText.includes('Assess this resume')) return json({ content: [{ type: 'text', text: JSON.stringify({ name: 'Test User', headline: 'Senior Business Analyst', seniority: 'senior', years: 12, location: 'Noida', country: 'IN', domain: 'Banking', known: {}, skills: ['SQL', 'Teradata', 'COREP', 'UAT', 'Data lineage', 'JIRA'], strengths: ['12 years regulatory reporting', 'Strong SQL reconciliation', 'Led UAT'], scores: { completeness: 70, impact: 55, skills: 85, ats: 78 }, overall: 71, missing: [{ key: 'roles', label: 'Target roles', why: 'Sharpens matches', kind: 'ask', prefKey: 'roles', multi: true, question: 'Which roles should I look for?', options: ['Senior BA', 'Lead BA', 'Data BA'] }, { key: 'loc', label: 'Where to work', why: 'Filters by city', kind: 'ask', prefKey: 'locations', multi: true, question: 'Where do you want to work?', options: ['Pune', 'Noida', 'Remote'] }, { key: 'impact', label: 'Measurable results', why: 'Recruiters scan for numbers', kind: 'resume', options: ["I'll update it", 'Skip'] }] }) }], stop_reason: 'end_turn' });
    return json({ content: [{ type: 'text', text: '{"skillsMatched":[{"area":"SQL","jd":"Advanced SQL","you":"12 yrs SQL"}],"mandatoryGaps":"None","optionalGaps":"","whyRelevant":"Direct fit","applyTip":"Lead with reconciliation","outreach":"Hi — keen on this role.","mock":[{"q":"Explain lineage","points":"HSBC EDW"}],"gapQuestion":"Python? Learning it."}' }], stop_reason: 'end_turn' });
  }
  const toolsUsed = msgs.some(m => Array.isArray(m.content) && m.content.some(c => c.type === 'tool_result'));
  if (!toolsUsed) return json({ content: [{ type: 'tool_use', id: 't1', name: 'search_web', input: { brief: 'Senior BA SQL regulatory reporting Pune' } }, { type: 'tool_use', id: 't2', name: 'list_jobs', input: {} }], stop_reason: 'tool_use' });
  const lists = msgs.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(c => c.type === 'tool_result');
  if (lists.length < 3) return json({ content: [{ type: 'tool_use', id: 't3', name: 'show_matches', input: { matches: [{ jobId: 'mock-bank-senior-ba-sql', match: 90, why: 'SQL + COREP regulatory reporting, as in your resume.' }] } }], stop_reason: 'tool_use' });
  return json({ content: [{ type: 'text', text: '1 strong fit at Mock Bank.\nOPTIONS: Prep me for the top one | Excel or PDF | Daily email alerts' }], stop_reason: 'end_turn' });
}

// Kairo daily run (Vercel Cron): emails each member their matched vacancies on the schedule they chose,
// and closes vacancies older than 45 days. Needs ANTHROPIC_API_KEY, GMAIL_USER, GMAIL_APP_PASSWORD; CRON_SECRET recommended.
import { json, fail } from '../lib/core.js';
import { getDoc, setDoc, listDocs } from '../lib/store.js';
import { anthropic, parseJson } from './kairo.js';

const USER = process.env.GMAIL_USER, PASS = process.env.GMAIL_APP_PASSWORD;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const https = u => /^https:\/\//i.test(String(u || '')) ? String(u) : '';
const MODEL = process.env.KAIRO_MODEL || process.env.AI_MODEL || 'claude-sonnet-5-5';

function dueToday(s, now) {
  const tz = s.timezone || 'Asia/Kolkata';
  let wd = 'Monday', day = now.toISOString().slice(0, 10);
  try {
    wd = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: tz }).format(now);
    day = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
  } catch {}
  if (s.lastSentDay === day) return null;
  if (s.frequency === 'weekdays' && /Saturday|Sunday/.test(wd)) return null;
  if (s.frequency === 'weekly' && wd !== (s.day || 'Monday')) return null;
  return day;
}

export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (secret && (request.headers.get('authorization') || '') !== 'Bearer ' + secret) return fail(401, 'unauthorized');
  const started = Date.now(), now = new Date(), log = [];
  const jobs = (await listDocs('kjobs')).map(d => ({ id: d.id, ...d.data }));
  // housekeeping: close vacancies older than 45 days
  for (const j of jobs) {
    const age = (now - Date.parse(j.postedDate || j.addedOn || 0)) / 864e5;
    if (j.status !== 'closed' && age > 45) { j.status = 'closed'; await setDoc('kjobs/' + j.id, { ...j, id: undefined }); }
  }
  const open = jobs.filter(j => j.status !== 'closed').slice(-60);
  if (!process.env.ANTHROPIC_API_KEY || !USER || !PASS) return json({ ok: false, reason: 'not_configured', open: open.length });
  const nodemailer = (await import('nodemailer')).default;
  const tx = nodemailer.createTransport({ service: 'gmail', auth: { user: USER, pass: PASS } });

  for (const { id, data: s } of await listDocs('kschedules')) {
    if (Date.now() - started > 48000) { log.push('time budget reached'); break; }
    if (!s || !s.active || !s.consent || !s.email || !s.resumeText) continue;
    const day = dueToday(s, now); if (!day) continue;
    const sent = new Set(s.sentJobIds || []);
    const pool = open.filter(j => !(s.onlyNew !== false && sent.has(j.id)));
    let picks = [];
    if (pool.length) {
      try {
        const out = await anthropic({ model: MODEL, max_tokens: 3000, system: 'Reply with only one valid JSON object.', messages: [{ role: 'user', content:
`Score each vacancy for this candidate strictly: role/title fit 25, skills/tools 30, industry/domain 15, seniority/experience 15, location/work mode 10, other preferences 5. A vacancy breaking a hard preference is not a match.
PREFERENCES: ${JSON.stringify(s.prefs || {})}
RESUME:\n${String(s.resumeText).slice(0, 10000)}
VACANCIES: ${JSON.stringify(pool.map(j => ({ id: j.id, company: j.company, title: j.title, experience: j.experience, location: j.location, workMode: j.workMode, skills: j.skills, jd: String(j.jd || '').slice(0, 400) })))}
Reply {"matches":[{"id":"","match":0,"why":"one line","gap":"main gap or None"}]} with only vacancies scoring ${s.minMatch || 80} or more, best first.` }] });
        const r = parseJson((out.content || []).filter(c => c.type === 'text').map(c => c.text).join('')) || {};
        picks = (r.matches || []).filter(m => m && pool.some(j => j.id === m.id) && Number(m.match) >= (s.minMatch || 80)).slice(0, s.maxRoles || 10);
      } catch (e) { log.push(id + ': scoring failed'); continue; }
    }
    if (!picks.length && s.skipEmpty) { await setDoc('kschedules/' + id, { ...s, lastSentDay: day, lastResult: 'Nothing new — skipped' }); continue; }
    const cards = picks.map(m => { const j = pool.find(x => x.id === m.id), u = https(j.applyUrl) || https(j.sourceUrl);
      return `<div style="border:1px solid #efe3d5;border-radius:14px;padding:14px 16px;margin:10px 0"><div style="color:${m.match >= 85 ? '#0e8a63' : '#b46a00'};font-weight:bold;font-size:20px">${esc(m.match)}%</div><b>${esc(j.title)}</b><br>${esc(j.company)} · ${esc(j.location || '')}${j.experience ? ' · ' + esc(j.experience) : ''}<br><span style="color:#6e6a86">${esc(m.why)}</span>${m.gap && !/^none/i.test(m.gap) ? `<br><span style="color:#6e6a86">Gap: ${esc(m.gap)}</span>` : ''}${u ? `<br><a href="${esc(u)}" style="color:#c2410c">Apply</a>` : ''}</div>`; }).join('');
    const site = process.env.SITE_URL || 'https://ars-learning-academy.vercel.app';
    const html = `<div style="font-family:Arial,sans-serif;max-width:640px;color:#1e1b3a"><div style="background:#1e1b3a;color:#fff;padding:16px 20px;border-bottom:4px solid #e2550f;font-size:18px;font-weight:bold">Kairo · your matched roles</div><p>${picks.length ? `${picks.length} new roles that fit you ${s.minMatch || 80}%+.` : 'No new roles reach your minimum match today. Try widening your locations or titles in Kairo.'}</p>${cards}<p style="font-size:12px;color:#6e6a86">Change or pause these alerts in <a href="${site}/kairo" style="color:#c2410c">Kairo</a> · Practise interviews on <a href="${site}/" style="color:#c2410c">ARS Learning Academy</a></p></div>`;
    try {
      await tx.sendMail({ from: `Kairo · ARS Learning Academy <${USER}>`, to: s.email, subject: `Kairo – ${picks.length} roles that fit you – ${day}`, html, text: picks.map(m => { const j = pool.find(x => x.id === m.id); return `${m.match}% ${j.title} — ${j.company}\n${https(j.applyUrl) || ''}`; }).join('\n\n') || 'No new matches today.' });
      await setDoc('kschedules/' + id, { ...s, lastSentDay: day, lastSent: day, lastResult: `Sent ${picks.length} roles`, sentJobIds: [...sent, ...picks.map(m => m.id)].slice(-300) });
      log.push(`${id}: sent ${picks.length}`);
    } catch (e) { await setDoc('kschedules/' + id, { ...s, lastResult: 'Send failed' }); log.push(id + ': send failed'); }
  }
  return json({ ok: true, open: open.length, log });
}

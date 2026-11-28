// Kairo's helper: answers questions about Kairo and ARS in the user's own words (free Gemini API),
// and sends the one-time welcome email after registration (Gmail App Password).
// Env: GEMINI_API_KEY (+ optional GEMINI_MODEL), GMAIL_USER, GMAIL_APP_PASSWORD, KAIRO_WHATSAPP (optional).
import { json, fail, session } from '../lib/core.js';
import { getDoc, setDoc } from '../lib/store.js';

const clean = v => String(v || '').trim().replace(/^["']|["']$/g, '').replace(/^\w+\s*=\s*/, '').replace(/^["']|["']$/g, '');
const KEY = clean(process.env.GEMINI_API_KEY);
const MODELS = [...new Set([clean(process.env.GEMINI_MODEL), 'gemini-flash-lite-latest', 'gemini-flash-latest'].filter(Boolean))];
const MAIL_USER = clean(process.env.GMAIL_USER), MAIL_PASS = clean(process.env.GMAIL_APP_PASSWORD).replace(/\s+/g, '');
const WA = (clean(process.env.KAIRO_WHATSAPP) || String(process.env.ADMIN_PHONES || '').split(/[,\s]+/)[0] || '').replace(/\D/g, '');
const DAILY = { reg: 60, anon: 20 };

const ACTIONS = ['none', 'upload', 'register', 'signin', 'answer_questions', 'show_matches', 'change_answers', 'start_over', 'practise', 'download', 'voice_on', 'voice_off', 'menu', 'sign_out', 'feedback'];

const SYS = `You are Kairo, the friendly voice and chat guide inside the "Kairo" web app, part of ARS Learning Academy.
Speak like a warm, clear Indian-English career coach in her late twenties. Understand the user's intent even with typos, Hinglish or very short phrasing.
Answer ONLY about Kairo and ARS Learning Academy. If a question is outside this app (news, coding help, other companies' policies, personal advice unrelated to using this app), say briefly that you can only help with Kairo and ARS, and offer the next useful step in the app.
Never invent features, jobs, salaries or numbers. If you don't know, say so and suggest the closest real feature.
Keep replies short: 1-3 sentences, plain words, no markdown, no lists. Give concrete on-screen directions (button names, colours, positions).
Return JSON {"reply": string, "action": one of ${ACTIONS.join(', ')}}. Use an action only when the user clearly wants that thing done or shown now; otherwise "none".

WHAT THE APP IS
- Kairo finds Business Analyst roles in banking regulatory reporting that need SQL (Teradata and Oracle), matches them to the user's resume, and links each role to its official job listing on the employer's own careers site.
- ARS Learning Academy (at /ars) is the sister module for interview practice: AI interviewers Meera (general), Claire (COREP / credit risk), Anjali (IFRS 9 / Basel 3.1), Sophie (SQL), Ritika (consulting); a SQL Lab with Teradata and Oracle practice data and a full-screen console; a 60-minute exam with a certificate; screen-share round; performance tracking.
- One account works for both (single sign-on). Signing out in one signs out of both.
- It is free to use.

FIRST PAGE (not signed in)
- Big orange orb at the top: tap it and Kairo talks. Speech bubble beside it.
- Orange "Upload resume" button under the headline: tap it, the phone/computer file picker opens, choose a PDF or Word resume. Kairo reads it instantly in the browser and shows a teaser: years of experience, skills spotted, and how many roles look like an 80%+ fit (titles blurred). Nothing is saved until they register.
- "Register free to unlock" opens the sign-up form, pre-filled from the resume (name, email, phone). The user adds a 4-digit PIN, total/BA/SQL/UK-regulatory years and ticks consent. Then "Register & see my matches".
- "Sign in" at the top right (phone + 4-digit PIN). Forgot PIN: message the admin on LinkedIn (link under the sign-in form).
- Three tiles: Find roles, Practise (ARS), Get certified (ARS exam). A moving strip of live BA roles and a sample match card.

AFTER SIGNING IN
- Kairo reads the resume, then asks up to 9 quick questions one at a time: target designation, cities, salary package, SQL level, SQL databases (Teradata/Oracle/SQL Server/Snowflake), regulatory areas (COREP/FINREP, Basel 3.1, IFRS 9, credit risk, liquidity, AML/KYC), work mode, notice period, match level (80/85/90%+). Total and BA experience are skipped if already given at sign-up.
- Answer by tapping an option or speaking: tap the orange mic at the bottom right, or just speak when Kairo is listening (hands-free). Kairo understands spoken numbers like "forty five to sixty lakh" or "eighty five percent".
- Then "Submit & see my matches" opens the Matches page.

MATCHES PAGE
- Lists every role, best fit first, with a rank number. Top tiles: roles to explore, how many meet the chosen bar, best fit %, and interview readiness from ARS (or "Get ready" if they haven't practised).
- Filters: All, 80%+ (their bar), Saved, Applied, Hidden.
- Each card: match % ring, company, title, location, work mode, experience, fit bars (Skills, SQL, Regulatory, Experience, Location) and a Gaps row = keywords the job description asks for that are not in the resume.
- Buttons: Apply (opens the employer's official listing in a new tab), Details, heart (Save), X (Not for me, with a reason).
- After Apply, when the user comes back Kairo asks "Did you apply?": Yes moves the role to the Applied tab and out of the main list; Not yet keeps it as Saved.
- Details panel: why you fit, skills you have, skills to brush up, about the role, your edge, a ready message for the hiring team with Copy, Find recruiters on LinkedIn, and Track: Saved / Applied, plus "Practise this interview" (opens the right ARS interviewer).
- Download button (top right) gives Excel or PDF of the matches.
- Back arrow (top left) returns to the chat.

HOW MATCH % WORKS
Score out of 100 from: role/title fit (25), skills in the job description found in the resume (30), regulatory domain (15), experience band (15), location/work mode (10), SQL level and Teradata/Oracle match (up to 7). It's a guide, not a guarantee.

ACCOUNT, MENU, OTHER
- After signing in, a slim bar under the header has "Back to home" (top left) and "Log out" (top right). The Matches page has the same two as round icons beside Download.
- "Back to home" (also tapping the Kairo logo, or saying "start over") asks to confirm, then clears the resume, answers and matches so the user starts fresh; they stay signed in and ARS practice is kept. "Log out" only signs out (of Kairo and ARS).
- The round initials badge at the top right shows the user's name, Feedback, and the privacy note (admins also see Insights).
- After the quick questions Kairo shows a one-line review of every answer and two choices: "Find roles to apply" or "Change an answer" (pick one field, e.g. Job cities, and only that question is asked again). Users can also say "change my salary" etc.
- Upload a new resume with the paperclip button at the bottom left of the chat.
- The Ask Kairo robot (bottom right on the first page and Matches page) listens as soon as it's tapped.
- Speaker icon at the top turns Kairo's voice on/off. Microphone: allow it when the browser asks; in Chrome click the icon left of the address bar, then Microphone, then Allow. The Claude app's built-in browser blocks the microphone; use Chrome. On iPhone, tapping answers works best.
- Privacy: the resume and answers are visible only to the user; the admin sees anonymous usage counts. Data is deleted 10 days after registering (they can register again).
- Job list: a small set of verified roles from employer sites, refreshed regularly; if a company isn't shown it's because no verified listing link was found.
- After registering, a welcome email is sent to the registered address (if email is switched on).`;

async function gemini(q, ctx, history) {
  const contents = [];
  for (const h of (history || []).slice(-6)) if (h && h.text) contents.push({ role: h.role === 'user' ? 'user' : 'model', parts: [{ text: String(h.text).slice(0, 600) }] });
  contents.push({ role: 'user', parts: [{ text: `Current screen and state: ${JSON.stringify(ctx || {}).slice(0, 800)}\n\nUser says: ${String(q).slice(0, 600)}` }] });
  const body = { systemInstruction: { parts: [{ text: SYS }] }, contents,
    generationConfig: { temperature: 0.4, maxOutputTokens: 350, responseMimeType: 'application/json',
      responseSchema: { type: 'OBJECT', properties: { reply: { type: 'STRING' }, action: { type: 'STRING', enum: ACTIONS } }, required: ['reply', 'action'] } } };
  let last = 'ai_failed'; const deadline = Date.now() + 12000;
  const call = async (m, gc, ms) => {
    const t0 = Date.now();
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY }, body: JSON.stringify({ ...body, generationConfig: gc }), signal: AbortSignal.timeout(ms) });
    const j = await r.json().catch(() => ({}));
    console.log(`[agent] model=${m} status=${r.status} ms=${Date.now() - t0}${r.ok ? '' : ' error=' + JSON.stringify((j.error && j.error.message) || '').slice(0, 200)}`);
    return { r, j };
  };
  for (const m of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = deadline - Date.now(); if (left < 1500) break;
      let gc = { ...body.generationConfig, thinkingConfig: { thinkingBudget: 0 } };
      let res;
      try {
        res = await call(m, gc, Math.min(6000, left));
        if (res.r.status === 400 && /thinking/i.test((res.j.error && res.j.error.message) || '')) { gc = body.generationConfig; res = await call(m, gc, Math.min(6000, deadline - Date.now())); }
      } catch (e) { last = String(e.message || e); continue; }
      const { r, j } = res;
      if (r.status === 404 || (r.status === 400 && /model|not found|not supported/i.test((j.error && j.error.message) || ''))) { last = 'model_not_found'; break; }
      if (r.status === 503 || r.status === 500) { last = (j.error && j.error.message) || 'busy'; await new Promise(z => setTimeout(z, 400)); continue; }
      if (!r.ok) throw Object.assign(new Error((j.error && j.error.message) || 'ai_failed'), { status: r.status });
      const t = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts.map(p => p.text || '').join('');
      let o = {}; try { o = JSON.parse(t); } catch { o = { reply: String(t || '').trim(), action: 'none' }; }
      if (!o.reply) { last = 'empty'; continue; }
      if (!ACTIONS.includes(o.action)) o.action = 'none';
      return { reply: String(o.reply || '').slice(0, 700), action: o.action };
    }
  }
  throw new Error(last || 'ai_failed');
}

async function welcome(s) {
  if (!s || !s.reg) return fail(401, 'no_session');
  if (!MAIL_USER || !MAIL_PASS) return json({ ok: false, reason: 'mail_off' });
  const flag = 'sys/welcome/' + s.uid;
  if (await getDoc(flag)) return json({ ok: true, already: true });
  const a = await getDoc('attempts/' + s.uid); const p = (a && a.profile) || {};
  if (!p.email) return json({ ok: false, reason: 'no_email' });
  const first = String(p.name || '').split(/\s+/)[0] || 'there';
  const site = 'https://ars-learning-academy.vercel.app';
  const text = `Dear ${p.name || first},\n\nThank you for registering with Kairo and ARS Learning Academy. Your account is ready.\n\n- Kairo matches you to Business Analyst roles in regulatory reporting (SQL, Teradata, Oracle) and links each one to the employer's official listing.\n- ARS lets you practise interviews with AI interviewers, run SQL in the SQL Lab and take the 60-minute exam.\n\nSign in any time with your mobile number and PIN: ${site}\n\nAll the best,\nKairo · ARS Learning Academy`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#1f1a2e"><div style="background:linear-gradient(135deg,#ff8a3d,#e4570e);padding:24px;border-radius:16px 16px 0 0;color:#fff"><h1 style="margin:0;font-size:24px">Welcome to Kairo, ${first}!</h1><p style="margin:6px 0 0;opacity:.9">Your BA job agent · ARS Learning Academy</p></div><div style="border:1px solid #f0e2d6;border-top:0;padding:24px;border-radius:0 0 16px 16px"><p>Dear ${p.name || first},</p><p>Thank you for registering. Your account is ready.</p><ul><li><b>Kairo</b> matches you to Business Analyst roles in regulatory reporting (SQL, Teradata, Oracle) and links each to the employer's official listing.</li><li><b>ARS</b> lets you practise with AI interviewers, run SQL in the SQL Lab and take the 60-minute exam.</li></ul><p><a href="${site}" style="display:inline-block;background:#e4570e;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:bold">Open Kairo</a></p><p style="color:#777;font-size:12px">Sign in with your mobile number and PIN. You received this because you registered on ARS Learning Academy.</p></div></div>`;
  if (process.env.MOCK_MAIL) { await setDoc(flag, { at: Date.now(), mock: true }); return json({ ok: true, mock: true, to: p.email }); }
  const nodemailer = (await import('nodemailer')).default;
  const tx = nodemailer.createTransport({ service: 'gmail', auth: { user: MAIL_USER, pass: MAIL_PASS } });
  await tx.sendMail({ from: `Kairo · ARS Learning Academy <${MAIL_USER}>`, to: p.email, subject: `Welcome to Kairo, ${first} — you're registered`, text, html });
  await setDoc(flag, { at: Date.now() });
  return json({ ok: true });
}

export async function GET() { return json({ ai: !!KEY, mail: !!(MAIL_USER && MAIL_PASS), wa: WA }); }

export async function POST(request) {
  const s = session(request); if (!s) return fail(401, 'no_session');
  let b = {}; try { b = await request.json(); } catch {}
  if (b.op === 'welcome') return welcome(s);
  if (b.op !== 'ask') return fail(400, 'bad_request');
  const q = String(b.q || '').trim(); if (!q) return fail(400, 'bad_q');
  if (!KEY) return fail(503, 'not_configured');
  const day = new Date().toISOString().slice(0, 10), rk = `sys/rate/agent-${s.uid}-${day}`;
  const used = ((await getDoc(rk)) || {}).n || 0;
  if (used >= (s.reg ? DAILY.reg : DAILY.anon)) return fail(429, 'rate_limited');
  try {
    const out = await gemini(q, b.ctx, b.history);
    await setDoc(rk, { n: used + 1 });
    return json(out);
  } catch (e) { console.error('[agent] failed:', String(e.message || e).slice(0, 300)); return fail(e.status === 429 ? 429 : 502, 'ai_failed', String(e.message || e).slice(0, 200)); }
}

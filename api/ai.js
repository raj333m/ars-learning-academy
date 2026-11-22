// AI feedback through the Anthropic API. Needs ANTHROPIC_API_KEY in the Vercel project settings.
import { json, fail, session } from '../lib/core.js';
import { getDoc, setDoc } from '../lib/store.js';

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.AI_MODEL || 'claude-sonnet-5-5';
const DAILY = { reg: Number(process.env.AI_DAILY_LIMIT || 150), anon: 15 };

export async function GET() { return json({ ready: !!KEY }); }

export async function POST(request) {
  const s = session(request); if (!s) return fail(401, 'no_session');
  if (!KEY) return fail(503, 'not_configured', 'AI feedback is not switched on yet.');
  let b = {}; try { b = await request.json(); } catch {}
  const prompt = String(b.prompt || '');
  if (!prompt || prompt.length > 40000) return fail(400, 'bad_prompt');
  // simple per-person daily limit
  const day = new Date().toISOString().slice(0, 10); const rk = `sys/rate/${s.uid}-${day}`;
  const used = ((await getDoc(rk)) || {}).n || 0;
  if (used >= (s.reg ? DAILY.reg : DAILY.anon)) return fail(429, 'rate_limited', "You've reached today's AI feedback limit. It resets tomorrow.");
  await setDoc(rk, { n: used + 1 });
  if (process.env.MOCK_AI) return json({ json: JSON.parse(process.env.MOCK_AI) });   // test runs only
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 2500, system: 'You are part of an interview-preparation app. Reply with only one valid JSON object and nothing else: no markdown, no code fences, no commentary.', messages: [{ role: 'user', content: prompt }] })
  });
  if (!r.ok) { const t = await r.text(); return fail(502, r.status === 429 ? 'rate_limited' : 'ai_error', 'AI feedback is busy just now. Please try again. ' + t.slice(0, 120)); }
  const out = await r.json();
  const text = (out.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const i = text.indexOf('{'), j = text.lastIndexOf('}');
  try { return json({ json: JSON.parse(text.slice(i, j + 1)) }); } catch { return fail(502, 'ai_error', 'The AI reply could not be read. Please try again.'); }
}

// Certificate emails, sent from the programme's Gmail using an App Password
// (GMAIL_USER and GMAIL_APP_PASSWORD in the Vercel project settings).
import { json, fail, session } from '../lib/core.js';
import { getDoc } from '../lib/store.js';

const USER = process.env.GMAIL_USER, PASS = process.env.GMAIL_APP_PASSWORD;
export async function GET() { return json({ ready: !!(USER && PASS) }); }

export async function POST(request) {
  const s = session(request); if (!s || !s.reg) return fail(401, 'no_session');
  if (!USER || !PASS) return fail(503, 'not_configured', 'Email sending is not switched on yet.');
  let b = {}; try { b = await request.json(); } catch {}
  const to = [].concat(b.to || []).map(String).filter(Boolean);
  if (!to.length || to.length > 5) return fail(400, 'bad_to');
  if (!s.adm) {   // candidates may only email themselves
    const me = await getDoc('attempts/' + s.uid); const mine = me && me.profile && String(me.profile.email || '').toLowerCase();
    if (!mine || to.some(t => t.toLowerCase() !== mine)) return fail(403, 'forbidden', 'Certificates can only be emailed to your registered address.');
  }
  if (process.env.MOCK_MAIL) { return json({ ok: true, mock: true, to }); }   // test runs only
  const nodemailer = (await import('nodemailer')).default;
  const tx = nodemailer.createTransport({ service: 'gmail', auth: { user: USER, pass: PASS } });
  await tx.sendMail({
    from: `ARS Learning Academy <${USER}>`, to: to.join(','), subject: String(b.subject || '').slice(0, 300),
    text: String(b.body || ''), html: b.htmlBody ? String(b.htmlBody) : undefined,
    attachments: (b.attachments || []).slice(0, 3).map(a => ({ filename: a.filename || 'attachment', content: Buffer.from(String(a.content || ''), 'base64'), contentType: a.mimeType || 'application/octet-stream' }))
  });
  return json({ ok: true });
}

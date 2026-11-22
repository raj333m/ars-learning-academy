// Shared helpers: sessions, JSON responses, PIN hashing, access rules.
import crypto from 'node:crypto';

const SECRET = process.env.SESSION_SECRET || 'local-dev-secret';
export const digits = s => String(s || '').replace(/\D/g, '');
export const ADMIN_PHONES = (process.env.ADMIN_PHONES || '').split(',').map(digits).filter(Boolean);

export function sign(obj) {
  const p = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const s = crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
  return p + '.' + s;
}
export function verify(tok) {
  if (!tok || tok.indexOf('.') < 0) return null;
  const [p, s] = tok.split('.');
  const want = crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
  if (s.length !== want.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want))) return null;
  try { return JSON.parse(Buffer.from(p, 'base64url').toString()); } catch { return null; }
}
export function session(request) {
  const h = request.headers.get('authorization') || '';
  return verify(h.replace(/^Bearer\s+/i, ''));
}
export const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});
export const fail = (status, code, error) => json({ code, error: error || code }, status);
export const newId = (p = 'u_') => p + crypto.randomBytes(12).toString('base64url');
export function pinHash(pin, salt) { return crypto.pbkdf2Sync(String(pin), salt, 120000, 32, 'sha256').toString('hex'); }
export const newSalt = () => crypto.randomBytes(16).toString('hex');
export function safeEq(a, b) { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); }

/* Same rules the app declared on Claude: longest matching prefix wins; {self} = the signed-in user's id. */
const L = { view: 1, interact: 2, admin: 3 };
const RULES = [
  ['', 'view', 'admin'], ['roster', 'view', 'admin'], ['questions', 'view', 'admin'], ['config', 'admin', 'admin'],
  ['likes', 'view', 'admin'], ['likes/{self}', 'view', 'interact'],
  ['requests', 'admin', 'admin'], ['requests/{self}', 'interact', 'interact'],
  ['attempts', 'admin', 'admin'], ['attempts/{self}', 'interact', 'interact'],
  ['certs', 'admin', 'admin'], ['certs/{self}', 'interact', 'interact'],
  ['help', 'view', 'admin'], ['help/{self}', 'view', 'interact'],
  ['phones', 'view', 'admin'], ['phones/{self}', 'view', 'interact'],
  ['reports', 'view', 'admin'], ['reports/{self}', 'view', 'interact'],
];
export function validPath(path) {
  return typeof path === 'string' && path.length < 300 && /^[A-Za-z0-9_\-]+(\/[A-Za-z0-9_\-]+)*$/.test(path) && !path.startsWith('auth') && !path.startsWith('sys');
}
function rule(path, uid) {
  const seg = path.split('/');
  // private per-person area: data/users/<id>/... only that person (not even the admin)
  if (seg[0] === 'data') return seg[1] === 'users' && seg[2] && seg[2] === uid ? { read: 0, write: 0, self: true } : { read: 99, write: 99 };
  let best = RULES[0], bestLen = 0;
  for (const r of RULES) {
    const ps = r[0] ? r[0].split('/') : [];
    if (ps.length > seg.length || ps.length < bestLen) continue;
    let ok = true;
    for (let i = 0; i < ps.length; i++) { if (ps[i] === '{self}' ? seg[i] !== uid : ps[i] !== seg[i]) { ok = false; break; } }
    if (ok && ps.length >= bestLen) { best = r; bestLen = ps.length; }
  }
  return { read: L[best[1]], write: L[best[2]] };
}
const level = s => (s ? (s.adm ? 3 : 2) : 0);
export const canRead = (path, s) => !!s && rule(path, s.uid).read <= level(s);
export const canWrite = (path, s) => !!s && rule(path, s.uid).write <= level(s);

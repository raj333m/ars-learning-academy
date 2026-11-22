// Sign-in with mobile number + 4-digit PIN. Every visitor first gets an anonymous id;
// registering binds a number + PIN to that id; signing in on another device returns the same id.
import { json, fail, sign, session, digits, ADMIN_PHONES, newId, pinHash, newSalt, safeEq } from '../lib/core.js';
import { getDoc, setDoc, delDoc } from '../lib/store.js';

const tokenFor = (uid, phoneDigits, reg) => sign({ uid, adm: !!(phoneDigits && ADMIN_PHONES.includes(phoneDigits)), reg: !!reg, iat: Date.now() });
const okPin = p => /^\d{4}$/.test(String(p || ''));
const okPhone = d => d.length >= 8 && d.length <= 15;
const profileExists = async uid => !!(await getDoc('attempts/' + uid));

export async function GET(request) {
  const a = new URL(request.url).searchParams.get('a');
  if (a === 'me') {
    const s = session(request); if (!s) return fail(401, 'no_session');
    return json({ uid: s.uid, admin: !!s.adm, reg: !!s.reg });
  }
  return fail(400, 'bad_request');
}

export async function POST(request) {
  const a = new URL(request.url).searchParams.get('a');
  let body = {}; try { body = await request.json(); } catch {}
  const s = session(request);

  if (a === 'anon') { const uid = newId(); return json({ uid, admin: false, reg: false, token: tokenFor(uid, null, false) }); }

  if (a === 'register') {
    if (!s) return fail(401, 'no_session');
    const d = digits(body.phone); if (!okPhone(d)) return fail(400, 'bad_phone', 'Enter a valid mobile number.');
    if (!okPin(body.pin)) return fail(400, 'bad_pin_format', 'Choose a 4-digit PIN.');
    const key = 'auth/phones/' + d; const rec = await getDoc(key);
    if (rec && rec.uid !== s.uid && await profileExists(rec.uid)) return fail(409, 'taken', 'This mobile number is already registered. Please sign in.');
    const me = await getDoc('auth/users/' + s.uid);
    if (me && me.phone && me.phone !== d) await delDoc('auth/phones/' + me.phone);
    const salt = newSalt();
    await setDoc(key, { uid: s.uid, salt, hash: pinHash(body.pin, salt), at: Date.now() });
    await setDoc('auth/users/' + s.uid, { phone: d });
    return json({ uid: s.uid, admin: ADMIN_PHONES.includes(d), reg: true, token: tokenFor(s.uid, d, true) });
  }

  if (a === 'changephone') {
    if (!s || !s.reg) return fail(401, 'no_session');
    const d = digits(body.phone); if (!okPhone(d)) return fail(400, 'bad_phone');
    const me = await getDoc('auth/users/' + s.uid); if (!me) return fail(404, 'not_found');
    if (me.phone === d) return json({ ok: true });
    const taken = await getDoc('auth/phones/' + d);
    if (taken && taken.uid !== s.uid && await profileExists(taken.uid)) return fail(409, 'taken', 'This mobile number is already registered.');
    const old = await getDoc('auth/phones/' + me.phone);
    await setDoc('auth/phones/' + d, { ...(old || {}), uid: s.uid, at: Date.now() });
    await delDoc('auth/phones/' + me.phone);
    await setDoc('auth/users/' + s.uid, { phone: d });
    return json({ ok: true, token: tokenFor(s.uid, d, true) });
  }

  if (a === 'signin') {
    const d = digits(body.phone); const key = 'auth/phones/' + d;
    const rec = await getDoc(key);
    if (!rec) return fail(404, 'not_found', "This number isn't registered yet.");
    if (!(await profileExists(rec.uid))) { await delDoc(key); await delDoc('auth/users/' + rec.uid); return fail(404, 'not_found', "This number isn't registered yet."); }
    if (rec.lockUntil && rec.lockUntil > Date.now()) return fail(429, 'locked', 'Too many wrong PINs. Try again in 15 minutes.');
    if (!okPin(body.pin)) return fail(400, 'bad_pin_format', 'Enter your 4-digit PIN.');
    if (rec.reset) {                       // admin reset: the next PIN entered becomes the new PIN
      rec.salt = newSalt(); rec.hash = pinHash(body.pin, rec.salt); rec.reset = false; rec.fails = 0; await setDoc(key, rec);
    } else if (!safeEq(pinHash(body.pin, rec.salt), rec.hash)) {
      rec.fails = (rec.fails || 0) + 1;
      let left = 5 - rec.fails;
      if (rec.fails >= 5) { rec.lockUntil = Date.now() + 15 * 60000; rec.fails = 0; left = 0; }
      await setDoc(key, rec);
      return fail(401, left ? 'bad_pin' : 'locked', left ? `That PIN doesn't match. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong PINs. Try again in 15 minutes.');
    } else if (rec.fails) { rec.fails = 0; await setDoc(key, rec); }
    return json({ uid: rec.uid, admin: ADMIN_PHONES.includes(d), reg: true, token: tokenFor(rec.uid, d, true) });
  }

  if (a === 'resetpin') {                  // admin only: lets a candidate who forgot their PIN choose a new one
    if (!s || !s.adm) return fail(403, 'forbidden');
    const key = 'auth/phones/' + digits(body.phone); const rec = await getDoc(key);
    if (!rec) return fail(404, 'not_found', 'No registration for that number.');
    rec.reset = true; rec.lockUntil = 0; rec.fails = 0; await setDoc(key, rec);
    return json({ ok: true });
  }
  return fail(400, 'bad_request');
}

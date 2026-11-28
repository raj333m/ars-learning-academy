// Document database with the same access rules as the Claude version of the app.
import { json, fail, session, validPath, canRead, canWrite } from '../lib/core.js';
import { getDoc, setDoc, delDoc, listDocs, treeDocs } from '../lib/store.js';

export async function GET(request) {
  const s = session(request); if (!s) return fail(401, 'no_session');
  const q = new URL(request.url).searchParams; const op = q.get('op'), path = q.get('path');
  if (!validPath(path)) return fail(400, 'bad_path');
  if (!canRead(path, s)) return fail(403, 'forbidden');
  if (op === 'get') return json({ data: await getDoc(path) });
  if (op === 'list') return json({ docs: await listDocs(path) });
  return fail(400, 'bad_request');
}

export async function POST(request) {
  const s = session(request); if (!s) return fail(401, 'no_session');
  const text = await request.text();
  if (text.length > 900000) return fail(413, 'too_large', 'That is too much data to save at once.');
  let b; try { b = JSON.parse(text); } catch { return fail(400, 'bad_json'); }
  const { op, path, data } = b || {};
  if (op === 'kairoReset') {
    // Owner only: delete all Kairo data (answers, matches, chats, usage, feedback). ARS accounts, practice, exams and help contacts are kept.
    if (!s.adm) return fail(403, 'forbidden');
    const kairoTop = ['kusage', 'kfeedback', 'ksearches', 'kschedules', 'kmeta'];
    const isKairoUserDoc = p => { const g = p.split('/'); return g[0] === 'data' && g[1] === 'users' && g.length >= 4 && (g[3] === 'profile' || g[3] === 'chat'); };
    const paths = [...(await Promise.all(kairoTop.map(treeDocs))).flat(), ...(await treeDocs('data/users/')).filter(isKairoUserDoc)];
    for (let i = 0; i < paths.length; i += 20) await Promise.all(paths.slice(i, i + 20).map(delDoc));
    return json({ ok: true, deleted: paths.length });
  }
  if (!validPath(path)) return fail(400, 'bad_path');
  if (!canWrite(path, s)) return fail(403, 'forbidden');
  if (op === 'set') { if (data == null || typeof data !== 'object') return fail(400, 'bad_data'); await setDoc(path, data); return json({ ok: true }); }
  if (op === 'update') { const cur = (await getDoc(path)) || {}; await setDoc(path, { ...cur, ...(data || {}) }); return json({ ok: true }); }
  if (op === 'delete') { await delDoc(path); return json({ ok: true }); }
  return fail(400, 'bad_request');
}

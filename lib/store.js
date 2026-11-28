// Document store. Production: private Vercel Blob (one JSON file per document).
// Tests: a local folder (STORE_DIR).
import fs from 'node:fs';
import nodePath from 'node:path';

const KEY = p => 'd/' + p + '.json';
let impl;

if (process.env.STORE_DIR) {
  const dir = process.env.STORE_DIR;
  const f = p => nodePath.join(dir, KEY(p));
  impl = {
    async get(p) { try { return JSON.parse(fs.readFileSync(f(p), 'utf8')); } catch { return null; } },
    async set(p, d) { fs.mkdirSync(nodePath.dirname(f(p)), { recursive: true }); fs.writeFileSync(f(p), JSON.stringify(d)); },
    async del(p) { try { fs.unlinkSync(f(p)); } catch {} },
    async tree(prefix) {
      const root = nodePath.join(dir, 'd'), out = [];
      const walk = d => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const f = nodePath.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name.endsWith('.json')) out.push(nodePath.relative(root, f).split(nodePath.sep).join('/').slice(0, -5)); } };
      walk(nodePath.join(root, prefix)); return out;
    },
    async ids(col) {
      const d = nodePath.join(dir, 'd', col);
      try { return fs.readdirSync(d).filter(n => n.endsWith('.json')).map(n => n.slice(0, -5)); } catch { return []; }
    }
  };
} else if (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) {
  // Upstash Redis (free tier: 500K commands/month). One key per document plus a set per folder listing its ids.
  const URL_ = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL).replace(/\/$/, '');
  const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  const call = async (path, body, tries = 3) => {
    try {
      const r = await fetch(URL_ + path, { method: 'POST', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok || (j && j.error)) throw new Error('redis: ' + ((j && j.error) || r.status));
      return j;
    } catch (e) { if (tries > 1) { await new Promise(r => setTimeout(r, 200)); return call(path, body, tries - 1); } throw e; }
  };
  const cmd = async (...a) => (await call('', a)).result;
  const pipe = async cmds => (await call('/pipeline', cmds)).map(x => x.result);
  const split = p => { const i = p.lastIndexOf('/'); return i < 0 ? ['', p] : [p.slice(0, i), p.slice(i + 1)]; };
  const IDX = col => 'i/' + col;
  impl = {
    async get(p) { const v = await cmd('GET', KEY(p)); return v == null ? null : JSON.parse(v); },
    async set(p, d) { const [col, id] = split(p); await pipe([['SET', KEY(p), JSON.stringify(d)], ['SADD', IDX(col), id]]); },
    async del(p) { const [col, id] = split(p); await pipe([['DEL', KEY(p)], ['SREM', IDX(col), id]]); },
    async ids(col) { return (await cmd('SMEMBERS', IDX(col))) || []; },
    async many(col, ids) { if (!ids.length) return []; const v = await cmd('MGET', ...ids.map(id => KEY(col + '/' + id))); return v.map(x => (x == null ? null : JSON.parse(x))); },
    async tree(prefix) {
      const out = []; let cur = '0';
      do { const [next, keys] = await cmd('SCAN', cur, 'MATCH', 'd/' + prefix + '*', 'COUNT', 500); for (const k of keys) out.push(k.slice(2, -5)); cur = next; } while (cur !== '0');
      return out;
    }
  };
} else {
  const blob = await import('@vercel/blob');
  impl = {
    async get(p, tries = 3) {
      try {
        const r = await blob.get(KEY(p), { access: 'private', useCache: false });
        if (!r || r.statusCode !== 200 || !r.stream) return null;
        return JSON.parse(await new Response(r.stream).text());
      } catch (e) {
        if (String(e && e.message).match(/not.?found|404/i)) return null;
        if (tries > 1) { await new Promise(r => setTimeout(r, 250)); return impl.get(p, tries - 1); }
        throw e;
      }
    },
    async set(p, d) {
      await blob.put(KEY(p), JSON.stringify(d), { access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/json', cacheControlMaxAge: 60 });
    },
    async del(p) { try { await blob.del(KEY(p)); } catch {} },
    async tree(prefix) {
      const out = []; let cursor;
      do { const r = await blob.list({ prefix: 'd/' + prefix, cursor, limit: 1000 }); for (const b of r.blobs) if (b.pathname.endsWith('.json')) out.push(b.pathname.slice(2, -5)); cursor = r.hasMore ? r.cursor : undefined; } while (cursor);
      return out;
    },
    async ids(col) {
      const prefix = 'd/' + col + '/'; const out = []; let cursor;
      do {
        const r = await blob.list({ prefix, cursor, limit: 1000 });
        for (const b of r.blobs) { const rest = b.pathname.slice(prefix.length); if (rest.endsWith('.json') && !rest.slice(0, -5).includes('/')) out.push(rest.slice(0, -5)); }
        cursor = r.hasMore ? r.cursor : undefined;
      } while (cursor);
      return out;
    }
  };
}

export const getDoc = p => impl.get(p);
export const setDoc = (p, d) => impl.set(p, d);
export const delDoc = p => impl.del(p);
export async function listDocs(col) {
  const ids = await impl.ids(col);
  if (impl.many) { const data = await impl.many(col, ids); return ids.map((id, i) => ({ id, data: data[i] })).filter(d => d.data != null); }
  const docs = await Promise.all(ids.map(async id => ({ id, data: await impl.get(col + '/' + id) })));
  return docs.filter(d => d.data != null);
}

// Every document path under a folder, at any depth.
export const treeDocs = prefix => impl.tree(prefix);

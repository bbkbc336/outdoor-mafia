'use strict';
// 시험용 가짜 Upstash REST 서버. lib/store.js가 쓰는 명령과 스크립트만 흉내 냅니다.
// 요청마다 약간 늦게 답해 동시 요청이 실제로 겹치도록 합니다.
const http = require('http');

function start(port) {
  const kv = new Map(), hashes = new Map();
  const get = (k) => (kv.has(k) ? kv.get(k) : null);
  function run(args) {
    const [c, ...a] = args.map(String);
    const C = c.toUpperCase();
    if (C === 'GET') return get(a[0]);
    if (C === 'MGET') return a.map(get);
    if (C === 'HGETALL') return [...(hashes.get(a[0]) || new Map())].flat();
    if (C === 'EVAL') {
      const [script, , ...rest] = a;
      if (script.includes("ARGV[1] then return 0")) { // CAS
        const [k1, k2, expected, meta, json] = rest;
        if ((get(k2) || '') !== expected) return 0;
        kv.set(k1, json); kv.set(k2, meta); return 1;
      }
      if (script.includes("'NX'")) { // CREATE
        const [k1, k2, json, meta] = rest;
        if (kv.has(k1)) return 0;
        kv.set(k1, json); kv.set(k2, meta); return 1;
      }
      if (script.includes('HSET')) { const [k, f, v] = rest; if (!hashes.has(k)) hashes.set(k, new Map()); hashes.get(k).set(f, v); return 1; }
      if (script.includes('INCR')) { const [k] = rest; const n = Number(get(k) || 0) + 1; kv.set(k, String(n)); return n; }
    }
    throw new Error('지원하지 않는 명령: ' + C);
  }
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => setTimeout(() => {
      let out;
      try { out = { result: run(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }; } catch (e) { out = { error: e.message }; }
      res.writeHead(out.error ? 400 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    }, Math.random() * 8));
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => r(server)));
}

module.exports = { start };

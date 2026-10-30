'use strict';
// 요청 처리. 로컬 서버(server.js)와 Vercel 함수(api/handler.js)가 함께 씁니다.
// 실시간 전송 대신 화면이 POST /api/state 를 주기적으로 부릅니다(폴링).
// 바뀐 것이 없으면 { same: true } 만 돌려줘 요청이 가볍습니다.

const fs = require('fs');
const path = require('path');
const G = require('./game');
const QR = require('./qr');
const { isDue } = require('./store');

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const upper = (code) => String(code || '').trim().toUpperCase();

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  // Vercel은 JSON 본문을 미리 읽어 req.body에 넣어 둡니다.
  if (req.body !== undefined) {
    if (typeof req.body === 'string') return Promise.resolve(req.body ? JSON.parse(req.body) : {});
    if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body.length ? JSON.parse(req.body.toString('utf8')) : {});
    return Promise.resolve(req.body || {});
  }
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (d) => { n += d.length; if (n > 100000) { reject(new Error('too large')); req.destroy(); } else chunks.push(d); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function originOf(req) {
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0] || (req.socket && req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

// 방 객체 안에서 토큰 확인
function authIn(room, tok) {
  if (tok && tok === room.hostToken) return { who: 'host' };
  const p = tok && Object.values(room.players).find(x => x.token === tok);
  if (!p) throw new G.GameError('접속 정보가 없습니다. 다시 입장하거나 복구 코드를 입력하세요.');
  return { who: 'player', p };
}

const HOST_ACTIONS = {
  settings: (r, b) => G.updateSettings(r, b.settings || {}),
  locations: (r, b) => G.saveLocations(r, b.locations),
  missions: (r, b) => G.saveMissions(r, b.missions),
  kick: (r, b) => G.kick(r, b.pid),
  assign: (r) => G.assignRoles(r),
  start: (r, b) => G.startGame(r, !!b.force),
  discussion: (r) => G.startDiscussion(r),
  extend: (r, b) => G.extendDiscussion(r, Math.min(600, Math.max(10, Number(b.sec) || 60))),
  vote: (r) => G.startVoting(r),
  closeVote: (r) => { if (r.phase !== 'voting' || r.paused) throw new G.GameError('투표 중이 아닙니다.'); G.closeVoting(r); },
  resume: (r) => G.resumeActivity(r),
  pause: (r) => G.pause(r),
  unpause: (r) => G.unpause(r),
  revive: (r, b) => G.hostRevive(r, b.pid),
  setDead: (r, b) => G.hostSetDead(r, b.pid),
  completeTask: (r, b) => G.hostCompleteTask(r, b.pid),
  meeting: (r) => G.hostMeeting(r),
  end: (r) => G.hostEnd(r),
  newGame: (r) => G.newGame(r),
};
const PLAYER_ACTIONS = {
  ready: (r, p, b) => G.setReady(r, p, b.ready),
  ack: (r, p) => G.ack(r, p),
  kill: (r, p, b) => G.kill(r, p, b.target, b.seq),
  scan: (r, p, b) => G.scan(r, p, b.value, b.seq),
  answer: (r, p, b) => G.answer(r, p, b.taskId, b.option, b.seq),
  play: (r, p, b) => G.play(r, p, b.taskId, b.result, b.seq),
  report: (r, p, b) => G.report(r, p, b.qr, b.seq),
  emergency: (r, p, b) => G.emergency(r, p, b.seq),
  vote: (r, p, b) => G.castVote(r, p, b.target, b.seq),
};

function createHandler(store, { publicDir } = {}) {
  async function viewFor(room, a) {
    if (a.who === 'host') {
      const on = await store.online(room.code);
      return G.hostView(room, (pid) => on.has(pid));
    }
    const p = room.players[a.p.id];
    return p ? G.playerView(room, p) : null;
  }

  async function api(req, res, route) {
    if (route === '/api/ping') return json(res, 200, { ok: true, t: Date.now() });
    if (!store) return json(res, 500, { error: '저장소(Redis)가 연결되지 않았습니다. Vercel 프로젝트에 Upstash Redis를 연결하세요.' });
    if (req.method !== 'POST') return json(res, 405, { error: '허용되지 않은 요청입니다.' });
    let b;
    try { b = await readBody(req); } catch (_) { return json(res, 400, { error: '잘못된 요청입니다.' }); }
    const code = upper(b.code);

    try {
      if (route === '/api/rooms') {
        const ip = (req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim();
        if (!(await store.allowCreate(ip))) return json(res, 429, { error: '방을 너무 많이 만들었습니다. 잠시 후 다시 시도하세요.' });
        for (let i = 0; i < 20; i++) {
          const room = G.createRoom(new Set());
          room.lastActive = Date.now();
          if (await store.create(room)) return json(res, 200, { code: room.code, hostToken: room.hostToken });
        }
        throw new Error('방 코드를 만들지 못했습니다.');
      }
      if (route === '/api/join') {
        const { room, result: p } = await store.update(code, (r) => G.join(r, b.name));
        return json(res, 200, { code: room.code, token: p.token, name: p.name, recovery: p.recovery });
      }
      if (route === '/api/recover') {
        const { room, result: p } = await store.update(code, (r) => G.recover(r, b.recovery));
        return json(res, 200, { code: room.code, token: p.token, name: p.name });
      }
      if (route === '/api/state') {
        let meta = await store.meta(code);
        if (!meta) throw new G.GameError('방을 찾을 수 없습니다. 방 코드를 확인하세요.');
        let snap = null;
        if (isDue(meta)) { const u = await store.update(code, null); snap = u; meta = u.meta; }
        // 바뀐 게 없으면 방을 읽지 않고 가볍게 응답. 진행자는 접속 표시 때문에 항상 전체를 받습니다.
        if (b.rev && b.rev === meta && !b.host) {
          return json(res, 200, { same: true, rev: meta, serverNow: Date.now() });
        }
        if (!snap) snap = await store.snapshot(code, meta);
        if (!snap) throw new G.GameError('방을 찾을 수 없습니다. 방 코드를 확인하세요.');
        const a = authIn(snap.room, b.token);
        if (a.who === 'player' && b.beat) await store.beat(code, a.p.id);
        return json(res, 200, { rev: snap.meta, serverNow: Date.now(), view: await viewFor(snap.room, a) });
      }
      if (route === '/api/act') {
        const action = String(b.action || '');
        let a = null;
        const out = await store.update(code, (room) => {
          a = authIn(room, b.token);
          if (a.who === 'host') {
            const fn = HOST_ACTIONS[action];
            if (!fn) throw new G.GameError('알 수 없는 진행자 명령입니다.');
            return fn(room, b);
          }
          const fn = PLAYER_ACTIONS[action];
          if (!fn) throw new G.GameError('권한이 없습니다.');
          return fn(room, a.p, b);
        });
        return json(res, 200, { ok: true, result: out.result || null, rev: out.meta, view: await viewFor(out.room, a) });
      }
      return json(res, 404, { error: '없는 주소입니다.' });
    } catch (e) {
      if (e instanceof G.GameError) {
        // 실패 응답에도 최신 상태를 붙여 화면을 바로잡습니다.
        let view = null, rev;
        if (e.room) { try { view = await viewFor(e.room, authIn(e.room, b.token)); rev = e.meta; } catch (_) { /* 무시 */ } }
        return json(res, 400, { error: e.message, view, rev });
      }
      console.error(e);
      return json(res, 500, { error: '서버 오류가 발생했습니다.' });
    }
  }

  // ───────────── 인쇄 페이지 (진행자 전용) ─────────────
  async function printPage(req, res, url) {
    const deny = (msg) => { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(msg); };
    const cur = store && await store.get(upper(url.searchParams.get('code')));
    if (!cur) return deny('방을 찾을 수 없습니다. 방 코드를 확인하세요.');
    let a;
    try { a = authIn(cur.room, url.searchParams.get('token')); } catch (e) { return deny(e.message); }
    if (a.who !== 'host') return deny('진행자만 볼 수 있습니다.');
    const room = cur.room, origin = originOf(req);
    const what = url.searchParams.get('what') || 'all';
    const joinUrl = `${origin}/?room=${room.code}`;
    const scanUrl = (v) => `${origin}/?room=${room.code}&s=${v}`;
    let cards = '';
    if (what === 'all' || what === 'join') {
      cards += `<section class="sheet"><div class="card big"><h2>야외 마피아 입장</h2>${QR.svg(joinUrl)}<p class="code">방 코드 <b>${room.code}</b></p><p class="small">${esc(joinUrl)}</p></div></section>`;
    }
    if (what === 'all' || what === 'places') {
      cards += '<section class="sheet grid">';
      for (const l of room.locations) {
        const tags = [l.item ? '물품 출발지' : '', l.box ? '도착 상자' : '', l.sign ? '현장 보고 표지' : ''].filter(Boolean).join(' · ');
        cards += `<div class="card"><h3>📍 ${esc(l.name)}</h3>${QR.svg(scanUrl(l.qr))}<p class="code">코드 <b>${l.code}</b></p><p class="small">${esc(tags || '방문 점검')}</p></div>`;
      }
      cards += '</section>';
      // 임무 목록을 직접 만든 경우 그 질문을, 아니면 장소 표지 질문을 정답표에 넣습니다.
      const custom = (room.missions || []).filter(m => m.type === 'report');
      const rows = (room.missions || []).length
        ? custom.map(m => ({ place: (room.locations.find(l => l.id === m.loc) || {}).name || '?', q: m.q.question, a: m.q.answer }))
        : room.locations.filter(l => l.sign).map(l => ({ place: l.name, q: l.sign.question, a: l.sign.answer }));
      if (rows.length) {
        cards += '<section class="sheet"><h2 class="title">진행자용 표지 정답표 (참가자에게 보이지 않게 보관)</h2><table><tr><th>장소</th><th>질문</th><th>표지에 표시할 정답</th></tr>';
        for (const r of rows) cards += `<tr><td>${esc(r.place)}</td><td>${esc(r.q)}</td><td><b>${esc(r.a)}</b></td></tr>`;
        cards += '</table></section>';
      }
    }
    if (what === 'all' || what === 'players') {
      cards += '<section class="sheet grid">';
      for (const p of G.list(room)) {
        cards += `<div class="card tag"><h3>${esc(p.name)}</h3>${QR.svg(scanUrl(p.qr))}<p class="code">이름표 코드 <b>${p.code}</b></p><p class="small">쓰러진 사람을 발견했을 때만 스캔</p></div>`;
      }
      if (!G.list(room).length) cards += '<p>아직 입장한 참가자가 없습니다. 참가자가 입장한 뒤 다시 인쇄하세요.</p>';
      cards += '</section>';
    }
    const q = (w) => `/print?code=${room.code}&token=${encodeURIComponent(room.hostToken)}&what=${w}`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QR 인쇄 - ${room.code}</title>
<style>
body{font-family:system-ui,-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;margin:0;color:#111;background:#fff}
.bar{padding:12px 16px;background:#111;color:#fff;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.bar button,.bar a{font-size:16px;padding:8px 14px;border-radius:8px;border:0;background:#ffd23f;color:#111;text-decoration:none;font-weight:700}
.sheet{padding:10mm;page-break-after:always}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8mm}
.card{border:2px dashed #999;border-radius:6mm;padding:6mm;text-align:center;break-inside:avoid}
.card svg{width:55mm;height:55mm}
.card.big svg{width:120mm;height:120mm}
.card.tag svg{width:45mm;height:45mm}
h2{font-size:28px;margin:0 0 6mm}h3{font-size:22px;margin:0 0 3mm}
.code{font-size:20px;margin:3mm 0 1mm;letter-spacing:2px}.small{font-size:12px;color:#555;margin:0;word-break:break-all}
.title{font-size:20px}table{border-collapse:collapse;width:100%;font-size:15px}td,th{border:1px solid #999;padding:6px;text-align:left}
@media print{.bar{display:none}.sheet{padding:6mm}}
</style></head><body>
<div class="bar"><b>방 ${room.code} QR 인쇄</b>
<a href="${q('all')}">전체</a>
<a href="${q('join')}">입장 QR</a>
<a href="${q('places')}">장소 QR</a>
<a href="${q('players')}">이름표 QR</a>
<button onclick="print()">🖨 인쇄</button></div>
${cards}</body></html>`);
  }

  // ───────────── 정적 파일 (로컬 서버 전용, Vercel은 public/을 직접 제공) ─────────────
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
  function serveStatic(req, res, p) {
    if (p === '/' || p === '') p = '/index.html';
    if (p === '/host') p = '/host.html';
    const file = path.normalize(path.join(publicDir, p));
    if (!file.startsWith(publicDir)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('페이지를 찾을 수 없습니다.'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    // Vercel 경로 변경(rewrite) 시 원래 경로를 __p로 넘깁니다.
    const route = url.searchParams.get('__p') || url.pathname;
    try {
      if (route.startsWith('/api/')) return await api(req, res, route);
      if (route === '/print') return await printPage(req, res, url);
      if (route === '/qr.svg') {
        const text = (url.searchParams.get('text') || '').slice(0, 200);
        try { const svg = QR.svg(text); res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' }); return res.end(svg); }
        catch (_) { res.writeHead(400); return res.end(); }
      }
      if (publicDir) return serveStatic(req, res, route);
      res.writeHead(404); res.end();
    } catch (e) {
      console.error(e);
      try { json(res, 500, { error: '서버 오류가 발생했습니다.' }); } catch (_) { /* 무시 */ }
    }
  };
}

module.exports = { createHandler };

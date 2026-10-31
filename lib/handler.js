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
  importSetup: (r, b) => G.importSetup(r, b.setup),
  kick: (r, b) => G.kick(r, b.pid),
  assignTags: (r) => G.assignTags(r),
  setTag: (r, b) => { const p = r.players[b.pid]; if (!p) throw new G.GameError('참가자를 찾을 수 없습니다.'); return G.setTag(r, p, b.tag); },
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
  play: (r, p, b) => G.play(r, p, b.taskId, b.result),
  report: (r, p, b) => G.report(r, p, b.qr, b.seq, b.place),
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
    // 장소·이름표 QR에는 방 코드를 넣지 않습니다. 같은 인쇄물을 다음 행사에도 씁니다.
    const scanUrl = (v) => `${origin}/?s=${v}`;
    const count = (k, def) => Math.max(1, Math.min(G.MAX_TAG, Number(url.searchParams.get(k)) || def));
    const pad = (n) => String(n).padStart(2, '0');
    let cards = '';
    if (what === 'all' || what === 'join') {
      cards += `<section class="sheet"><div class="card big"><h2>야외 마피아 입장</h2>${QR.svg(joinUrl)}<p class="code">방 코드 <b>${room.code}</b></p><p class="small">${esc(joinUrl)}</p></div></section>`;
    }
    if (what === 'all' || what === 'places') {
      for (const l of room.locations) {
        cards += placePage(scanUrl(l.code), `<h2 class="pname">${esc(l.name)}</h2>`, l.no, l.code);
      }
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
    // 이름표는 앞면(이름 칸)과 뒷면(💀 사망 표시 + QR)을 번갈아 넣어 양면 인쇄로 한 번에 뽑습니다.
    // side=front / side=back 이면 그 면만 (양면 프린터가 없을 때 종이를 뒤집어 다시 넣어 인쇄)
    const side = ['front', 'back'].includes(url.searchParams.get('side')) ? url.searchParams.get('side') : 'both';
    if (what === 'all' || what === 'players') {
      const tagged = G.list(room).filter(p => p.tag).sort((a, b) => a.tag - b.tag);
      cards += badgeSheets(tagged.map(p => ({ n: p.tag, name: p.name })), side);
      if (!tagged.length) cards += '<p class="sheet">이름표를 연결한 참가자가 없습니다. 이름이 정해지지 않았다면 "번호만 이름표"를 인쇄하세요.</p>';
    }
    // 이름이 정해지기 전에 미리 인쇄하는 번호만 있는 QR (이름은 손으로 적거나 나중에 앱에서 정함)
    if (what === 'blankPlaces') {
      for (let n = 1; n <= count('n', 10); n++) cards += placePage(scanUrl('L' + pad(n)), '<div class="pwrite"><small>장소 이름</small></div>', n, 'L' + pad(n));
    }
    // 장소 QR: 한 장소당 A4 세로 한 장. 위에 장소 이름, 가운데 큰 QR, 아래 번호·코드.
    // 장소 QR: 밤의 사건 현장. A4 세로 한 장을 어두운 색으로 채우고, 장소 이름과 흰 판 위의 큰 QR만 크게.
    // QR은 앱의 'QR 스캔'으로 찍습니다(카메라 앱은 입장하지 않은 다른 브라우저를 열 수 있음).
    function placePage(url, nameHtml, no, codeStr) {
      return `<section class="place-page">
        <div class="ptop"><span>사건 현장</span><b class="num">No. ${pad(no)}</b></div>
        <div class="pname-wrap">${nameHtml}</div>
        <div class="qrplate">${QR.svg(url)}</div>
        <div class="pbottom"><p>앱에서 <b>QR 스캔</b>을 눌러 찍으세요</p><span class="num">코드 ${codeStr}</span></div></section>`;
    }
    if (what === 'blankTags') {
      cards += badgeSheets(Array.from({ length: count('n', 40) }, (_, i) => ({ n: i + 1, name: '' })), side);
    }
    // 목걸이 이름표: 가로 94mm × 세로 120mm, A4 세로 한 장에 2×2로 4개. 점선을 따라 자릅니다.
    //  앞면: 이름만 크게 적는 칸 (이름이 정해졌으면 인쇄)
    //  뒷면: 💀 사망 표시 + QR + 번호. 쓰러지면 이름표를 뒤집어 이 면이 보이게 합니다.
    // 양면 인쇄(긴 가장자리로 넘기기)를 하면 좌우가 바뀌므로, 앞면 [1 2 / 3 4] 자리의 뒷면은
    // [2 1 / 4 3] 순서로 놓아 앞뒤가 정확히 겹치게 합니다.
    function badgeSheets(items, side) {
      let out = '';
      for (let i = 0; i < items.length; i += 4) {
        const part = items.slice(i, i + 4);
        if (side !== 'back') {
          // 앞면: 이름 적는 칸만
          out += '<section class="badges">' + part.map(t => `<div class="badge nfront">
            <div class="namebox"><small>이름</small>${t.name ? `<b>${esc(t.name)}</b>` : ''}</div></div>`).join('') + '</section>';
        }
        if (side !== 'front') {
          // 뒷면: 사망 표시와 QR만. 좌우를 바꿔 배치해 양면 인쇄 시 앞면과 겹치게 합니다.
          out += '<section class="badges">' + [1, 0, 3, 2].map(k => {
            const t = part[k];
            return t ? `<div class="badge nback"><div class="deadmark">사망</div><div class="qrplate sm">${QR.svg(scanUrl('P' + pad(t.n)))}</div></div>`
              : '<div class="badge empty"></div>';
          }).join('') + '</section>';
        }
      }
      return out;
    }
    const q = (w) => `/print?code=${room.code}&token=${encodeURIComponent(room.hostToken)}&what=${w}`;
    // 장소만 인쇄하면 기본 용지를 A4 가로로, 이름표만이면 A4 세로·여백 0으로 둡니다(이름 붙인 페이지를 모르는 브라우저 대비).
    const basePage = ['places', 'blankPlaces', 'players', 'blankTags'].includes(what) ? '@page{size:A4 portrait;margin:0}' : '@page{size:A4;margin:6mm}';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QR 인쇄 - ${room.code}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Song+Myung&family=Gothic+A1:wght@400;700;900&family=JetBrains+Mono:wght@700&display=swap">
<style>
body{font-family:system-ui,-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;margin:0;color:#111;background:#fff;word-break:keep-all;overflow-wrap:break-word}
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
.write{border:2px solid #111;border-radius:3mm;min-height:18mm;display:flex;align-items:center;padding:0 4mm;margin-bottom:4mm;text-align:left}
.write span{font-size:13px;color:#777;align-self:flex-start;margin-top:2mm}.write b{font-size:30px;margin:auto}
.card.place svg{width:60mm;height:60mm}.num{font-size:24px;font-weight:800;margin:3mm 0 1mm}
.badges{page:tagpage;width:100%;height:296mm;box-sizing:border-box;display:grid;grid-template-columns:94mm 94mm;grid-template-rows:120mm 120mm;justify-content:center;align-content:center;break-after:page;overflow:hidden}
/* 설계: 느와르 — 밤의 사건 현장. 면 전체를 색으로 채우고, 읽어야 할 것(이름 칸·사망·QR·장소 이름)만 흰 판이나 큰 글자로.
   색: 밤(남흑) · 분필 흰색 · 핏빛 · 연기(판 테두리) · 가로등(번호 강조) / 글꼴: 제목 송명 · 안내 Gothic A1 · 번호 JetBrains Mono */
:root{--night:#10141c;--chalk:#f3f5f8;--blood:#a8001a;--smoke:#3a4252;--lamp:#e8b64c;
  --display:'Song Myung','Nanum Myeongjo',serif;--body:'Gothic A1','Noto Sans KR',system-ui,sans-serif;--code:'JetBrains Mono',ui-monospace,Menlo,monospace}
.badge,.place-page{font-family:var(--body);box-sizing:border-box}
.badge *,.place-page *,.badge,.place-page{-webkit-print-color-adjust:exact;print-color-adjust:exact;box-sizing:border-box}
.num{font-family:var(--code);font-variant-numeric:tabular-nums;font-weight:700;letter-spacing:.04em}
.badge small,.place-page small{font-size:10pt;font-weight:700;letter-spacing:.1em;color:#7a8394;display:block}
.qrplate{background:var(--chalk);padding:5mm;line-height:0;border-radius:3mm;align-self:center}
.qrplate svg{display:block;width:150mm;height:150mm}
.qrplate.sm{padding:3.5mm;border-radius:2mm}.qrplate.sm svg{width:60mm;height:60mm}
/* 이름표 칸 (94×120mm). 자르는 선은 칸 테두리 */
.badge{width:94mm;height:120mm;border:.3mm dashed #9aa3b2;padding:6mm;display:flex;flex-direction:column;overflow:hidden}
.badge.empty{border-color:transparent;background:none}
/* 앞면: 이름 칸만 */
.nfront{background:var(--night)}
.namebox{flex:1;background:var(--chalk);border-radius:3mm;padding:4mm 5mm;display:flex;flex-direction:column;box-shadow:inset 0 0 0 .8mm var(--smoke)}
.namebox b{flex:1;display:flex;align-items:center;justify-content:center;text-align:center;font-family:var(--display);font-size:40pt;line-height:1.15;color:var(--night);word-break:keep-all}
/* 뒷면: 사망 + QR만 */
.nback{background:var(--blood);align-items:center;justify-content:center;gap:5mm}
.deadmark{font-family:var(--display);font-size:46pt;line-height:1;color:var(--chalk);letter-spacing:.3em;padding-left:.3em}
/* 장소: A4 세로 전체를 밤색으로 */
.place-page{page:placepage;width:100%;height:297mm;background:var(--night);color:var(--chalk);padding:14mm 16mm;display:flex;flex-direction:column;gap:7mm;break-after:page;overflow:hidden}
.ptop{display:flex;align-items:baseline;justify-content:space-between;border-bottom:.5mm solid var(--smoke);padding-bottom:3mm}
.ptop span{font-size:13pt;font-weight:900;letter-spacing:.4em;color:var(--blood);background:var(--chalk);padding:1mm 3mm}
.ptop b{font-size:20pt;color:var(--lamp)}
.pname-wrap{min-height:30mm;display:flex;align-items:center}
.pname{font-family:var(--display);font-weight:400;font-size:62pt;line-height:1.08;margin:0;word-break:keep-all;text-wrap:balance}
.pwrite{flex:1;align-self:stretch;background:var(--chalk);border-radius:3mm;padding:3mm 5mm}
.place-page .qrplate{flex:none}
.pbottom{margin-top:auto;display:flex;align-items:center;justify-content:space-between;gap:6mm;border-top:.5mm solid var(--smoke);padding-top:4mm}
.pbottom p{margin:0;font-size:17pt;font-weight:700}.pbottom p b{color:var(--lamp)}
.pbottom span{font-size:13pt;color:#a9b1bf}
@page placepage{size:A4 portrait;margin:0}@page tagpage{size:A4 portrait;margin:0}
@media screen{body{background:#e9e9ee}.place-page{width:210mm}.badges{width:210mm}.place-page,.badges{background:#fff;margin:8mm auto;box-shadow:0 2px 10px rgba(0,0,0,.18)}.bar .tip{font-size:13px;color:#ccc}}.title{font-size:20px}table{border-collapse:collapse;width:100%;font-size:15px}td,th{border:1px solid #999;padding:6px;text-align:left}
@media print{.bar{display:none}.sheet{padding:6mm}}${basePage}
</style></head><body>
<div class="bar"><b>방 ${room.code} QR 인쇄</b>
<a href="${q('all')}">전체</a>
<a href="${q('join')}">입장 QR</a>
<a href="${q('places')}">장소 QR</a>
<a href="${q('players')}">이름표 QR</a>
<a href="${q('blankPlaces')}&n=10">번호만 장소 10장</a>
<a href="${q('blankTags')}&n=40">번호만 이름표 40장 (양면)</a>
<a href="${q('blankTags')}&n=40&side=front">이름표 앞면만</a>
<a href="${q('blankTags')}&n=40&side=back">이름표 뒷면만</a>
<button onclick="print()">🖨 인쇄</button>
<span class="tip">인쇄 설정: 배율 100%(실제 크기) · 배경 그래픽 켜기 · 장소는 A4 세로 한 장, 이름표는 94×120mm로 A4 한 장에 4개 · 이름표는 양면 인쇄(긴 가장자리로 넘기기): 앞면 이름 칸, 뒷면 사망 + QR</span></div>
${cards}</body></html>`);
  }

  // ───────────── 정적 파일 (로컬 서버 전용, Vercel은 public/을 직접 제공) ─────────────
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
  function serveStatic(req, res, p) {
    if (p === '/' || p === '') p = '/index.html';
    if (p === '/host') p = '/host.html';
    if (p === '/practice') p = '/practice.html';
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

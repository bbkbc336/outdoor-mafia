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
        const tags = [l.item ? '물품 출발지' : '', l.box ? '도착 상자' : '', l.sign ? '현장 보고 표지' : ''].filter(Boolean).join(' · ');
        cards += placePage(scanUrl(l.code), `<h2 class="pname">${esc(l.name)}</h2>`, l.no, l.code, tags || 'QR 임무 장소');
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
      for (let n = 1; n <= count('n', 10); n++) cards += placePage(scanUrl('L' + pad(n)), '<div class="write pwrite"><span>장소 이름</span></div>', n, 'L' + pad(n), '임무 장소 QR');
    }
    // 장소 QR: 한 장소당 A4 세로 한 장. 위에 장소 이름, 가운데 큰 QR, 아래 번호·코드.
    function placePage(url, nameHtml, no, codeStr, sub) {
      return `<section class="place-page"><div class="tape"><span>🕵️ 야외 마피아 · 임무 장소</span></div>
        <div class="pbody">${nameHtml}<div class="qrframe"><i></i><i></i><i></i><i></i>${QR.svg(url)}</div>
        <p class="pno"><b>📍 장소 ${pad(no)}</b><span class="pcode">코드 ${codeStr}</span></p>
        <p class="psub">${esc(sub)} · 휴대폰 카메라 또는 앱의 'QR 스캔'으로 찍으세요</p></div>
        <div class="tape thin"></div></section>`;
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
          out += '<section class="badges">' + part.map(t => `<div class="badge front">
            <div class="bhead">🕵️ 야외 마피아</div>
            <div class="bname">${t.name ? `<b>${esc(t.name)}</b>` : ''}<span>이름</span></div>
            <div class="tape thin"></div></div>`).join('') + '</section>';
        }
        if (side !== 'front') {
          out += '<section class="badges">' + [1, 0, 3, 2].map(k => {
            const t = part[k];
            return t ? `<div class="badge back"><div class="tape dead"><span>💀 사망 · DEAD</span></div>
              <div class="qrframe sm"><i></i><i></i><i></i><i></i>${QR.svg(scanUrl('P' + pad(t.n)))}</div>
              <div class="foot"><b class="num">${pad(t.n)}</b><span>쓰러진 사람을 <b>직접 발견했을 때만</b> 찍으세요<br>코드 P${pad(t.n)}</span></div></div>` : '<div class="badge empty"></div>';
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
.badge{width:94mm;height:120mm;box-sizing:border-box;border:0.3mm dashed #999;padding:4mm;display:flex;flex-direction:column;align-items:center;gap:3mm;overflow:hidden}
.badge.empty{border-color:transparent}
/* 테마: 앱과 같은 노랑·검정. 배경색이 인쇄되도록 print-color-adjust 지정, 바탕은 흰색으로 잉크 절약 */
.tape,.bhead,.num,.qrframe i{-webkit-print-color-adjust:exact;print-color-adjust:exact}
.tape{width:100%;flex:none;height:11mm;display:flex;align-items:center;justify-content:center;border-radius:2mm;
  background:repeating-linear-gradient(-45deg,#ffd23f 0 4mm,#111 4mm 8mm)}
.tape span{background:#ffd23f;color:#111;font-weight:900;font-size:17px;padding:1mm 4mm;border-radius:1.5mm;letter-spacing:1px;white-space:nowrap}
.tape.thin{height:4mm}
.tape.dead{height:13mm}.tape.dead span{background:#111;color:#fff;font-size:22px;letter-spacing:2px}
.bhead{width:100%;flex:none;background:#111;color:#ffd23f;font-weight:900;font-size:18px;text-align:center;padding:2mm 0;border-radius:2mm;letter-spacing:1px}
.bname{width:100%;flex:1;border:0.7mm solid #111;border-radius:4mm;position:relative;box-sizing:border-box;display:flex;align-items:center;justify-content:center}
.bname span{position:absolute;left:4mm;top:3mm;font-size:15px;color:#888;font-weight:700}.bname b{font-size:44px;line-height:1.2;text-align:center;padding:0 4mm}
/* QR 테두리: 카메라 조준선처럼 네 모서리만 노랑·검정 */
.qrframe{position:relative;padding:3mm;line-height:0}
.qrframe i{position:absolute;width:12mm;height:12mm;border:1.6mm solid #111}
.qrframe i:nth-child(1){left:0;top:0;border-right:0;border-bottom:0;border-radius:3mm 0 0 0}
.qrframe i:nth-child(2){right:0;top:0;border-left:0;border-bottom:0;border-radius:0 3mm 0 0}
.qrframe i:nth-child(3){left:0;bottom:0;border-right:0;border-top:0;border-radius:0 0 0 3mm}
.qrframe i:nth-child(4){right:0;bottom:0;border-left:0;border-top:0;border-radius:0 0 3mm 0}
.qrframe svg{width:160mm;height:160mm;display:block}
.qrframe.sm{padding:2.5mm}.qrframe.sm i{width:8mm;height:8mm;border-width:1.2mm}.qrframe.sm svg{width:62mm;height:62mm}
.badge .foot{display:flex;align-items:center;gap:3mm;width:100%;margin-top:auto}
.num{background:#111;color:#ffd23f;font-size:26px;font-weight:900;padding:1mm 3mm;border-radius:2mm;white-space:nowrap}
.badge .foot span{font-size:10px;color:#444;text-align:left;line-height:1.4}.badge .foot span b{color:#c00018}
.place-page{page:placepage;width:100%;height:296mm;box-sizing:border-box;padding:12mm;display:flex;flex-direction:column;align-items:center;gap:6mm;break-after:page;overflow:hidden;text-align:center}
.place-page .tape{height:14mm}.place-page .tape span{font-size:22px}.place-page .tape.thin{height:6mm}
.pbody{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6mm;width:100%}
.pname{font-size:84px;line-height:1.1;margin:0;max-width:182mm;font-weight:900}.pwrite{width:170mm;min-height:30mm;margin:0;box-sizing:border-box;border:0.7mm solid #111;border-radius:4mm}
.pno{margin:0;display:flex;align-items:center;gap:5mm}.pno b{font-size:44px;font-weight:900}.pcode{font-size:22px;letter-spacing:2px;color:#333;border:0.5mm solid #111;border-radius:2mm;padding:1mm 3mm}
.psub{font-size:14px;color:#666;margin:0}
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
<span class="tip">인쇄 설정: 배율 100%(실제 크기) · 여백 기본/없음 · 장소는 A4 세로 한 장, 이름표는 94×120mm로 A4 한 장에 4개 · 이름표는 양면 인쇄(긴 가장자리로 넘기기): 앞면 이름 칸, 뒷면 💀 사망 + QR</span></div>
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

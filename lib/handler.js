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
      for (let n = 1; n <= count('n', 10); n++) cards += placePage(scanUrl('L' + pad(n)), '<div class="handwrite"></div>', n, 'L' + pad(n), 'QR 임무 장소');
    }
    // 장소 QR: 한 장소당 A4 세로 한 장. 위에 장소 이름, 가운데 큰 QR, 아래 번호·코드.
    // 장소 QR: '증거물 봉투' 콘셉트, A4 세로 한 장.
    // 빨간 봉인 띠 / 봉투에 붙인 라벨(장소 이름) / QR / 증거 인수인계 기록 칸. 요소마다 칸이 따로라 겹치지 않습니다.
    function placePage(url, nameHtml, no, codeStr, sub) {
      return `<section class="place-page"><div class="bag">
        <div class="seal"><b>증거물</b><span>EVIDENCE · 개봉 금지 · DO NOT OPEN</span></div>
        <div class="bagbody">
          <div class="label"><div class="lrow"><small>현장 LOCATION</small><span class="lno"><small>No.</small><b class="num">${pad(no)}</b></span></div>${nameHtml}</div>
          <div class="qrwell">${QR.svg(url)}</div>
          <table class="custody"><tr><th>사건</th><td>야외 마피아</td><th>코드</th><td class="num">${codeStr}</td></tr>
            <tr><th>용도</th><td>${esc(sub)}</td><th>찍는 법</th><td>휴대폰 카메라 · 앱 'QR 스캔'</td></tr></table>
        </div></div></section>`;
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
          // 앞면: 용의자 라인업 카드. 왼쪽 키 눈금, 오른쪽 이름 팻말.
          const scale = [190, 180, 170, 160, 150].map(c => `<span>${c}</span>`).join('');
          out += '<section class="badges">' + part.map(t => `<div class="badge lineup">
            <div class="lhead"><b>용의자</b><small>SUSPECT · 야외 마피아</small></div>
            <div class="lbody"><div class="height">${scale}</div>
              <div class="placard"><small>성명 NAME</small>${t.name ? `<b>${esc(t.name)}</b>` : '<div class="handwrite"></div>'}</div></div>
            <div class="lfoot">쓰러지면 카드를 <b>뒤집어</b> 사망 면이 보이게</div></div>`).join('') + '</section>';
        }
        if (side !== 'front') {
          // 뒷면: 시체 인식표(발목 태그). 좌우를 바꿔 배치해 양면 인쇄 시 앞면과 겹치게 합니다.
          out += '<section class="badges">' + [1, 0, 3, 2].map(k => {
            const t = part[k];
            return t ? `<div class="badge tagcell"><div class="toetag">
              <div class="hole"></div>
              <div class="ttop"><b>사망</b><small>DECEASED · 시체 인식표</small></div>
              <div class="qrwell sm">${QR.svg(scanUrl('P' + pad(t.n)))}</div>
              <div class="report">찍어서 신고</div>
              <div class="tfoot"><span>인식 번호</span><b class="num">P${pad(t.n)}</b></div>
              <div class="note">쓰러진 사람을 직접 발견했을 때만</div></div></div>` : '<div class="badge empty"></div>';
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
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Nanum+Myeongjo:wght@800&family=Gothic+A1:wght@400;700;900&family=Nanum+Gothic+Coding:wght@700&display=swap">
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
/* 설계: 범죄 수사 예능 속 소품 세 가지 — 용의자 라인업 카드(이름표 앞) · 시체 인식표(뒤) · 증거물 봉투(장소).
   색: 남색 잉크 · 흰 종이 · 크라프트(인식표) · 봉인 빨강(사망·신고·봉인에만) · 봉투 회청색.
   글꼴: 제목 나눔명조 ExtraBold / 본문 Gothic A1 / 숫자·기록 나눔고딕코딩 */
:root{--ink:#18202e;--paper:#fff;--kraft:#e8d9bb;--seal:#c4122f;--wash:#eef2f6;--rule:#7d8796;
  --display:'Nanum Myeongjo','Noto Serif KR',serif;--body:'Gothic A1','Noto Sans KR',system-ui,sans-serif;--code:'Nanum Gothic Coding',ui-monospace,Menlo,monospace}
.badge,.place-page{font-family:var(--body);color:var(--ink);background:var(--paper);box-sizing:border-box}
.badge *,.place-page *{-webkit-print-color-adjust:exact;print-color-adjust:exact;box-sizing:border-box}
.badge small,.place-page small{font-family:var(--code);font-size:8pt;font-weight:700;letter-spacing:.06em;color:var(--rule);display:block}
.num{font-family:var(--code);font-variant-numeric:tabular-nums;font-weight:700}
.handwrite{flex:1;min-height:12mm;border-bottom:.45mm solid var(--ink);margin:0 1mm 3mm}
.qrwell{background:var(--paper);border:.5mm solid var(--ink);padding:3mm;line-height:0;align-self:center}
.qrwell svg{display:block;width:150mm;height:150mm}
.qrwell.sm{padding:1.6mm;border-width:.4mm}.qrwell.sm svg{width:52mm;height:52mm}
/* 이름표 칸 (94×120mm) */
.badge{width:94mm;height:120mm;border:.3mm dashed #aab;padding:4mm;display:flex;flex-direction:column;gap:2.5mm;overflow:hidden}
.badge.empty{border-color:transparent}
/* 앞면: 용의자 라인업 */
.lhead{display:flex;align-items:baseline;justify-content:space-between;border-bottom:.8mm solid var(--ink);padding-bottom:1mm}
.lhead b{font-family:var(--display);font-weight:800;font-size:20pt;letter-spacing:.08em}
.lbody{flex:1;display:grid;grid-template-columns:9mm 1fr;gap:2.5mm;min-height:0}
.height{display:flex;flex-direction:column;justify-content:space-between;border-right:.4mm solid var(--ink);
  background:repeating-linear-gradient(180deg,var(--ink) 0 .25mm,transparent .25mm 4mm) right/2.5mm 100% no-repeat}
.height span{font-family:var(--code);font-size:7pt;font-weight:700;line-height:1;color:var(--rule)}
.placard{border:.9mm solid var(--ink);padding:2.5mm 3mm;display:flex;flex-direction:column;background:var(--paper)}
.placard b{flex:1;display:flex;align-items:center;justify-content:center;text-align:center;font-family:var(--display);font-weight:800;font-size:34pt;line-height:1.15;word-break:keep-all}
.lfoot{font-size:8.5pt;text-align:center;border-top:.3mm solid var(--rule);padding-top:1.5mm}.lfoot b{color:var(--seal)}
/* 뒷면: 시체 인식표 */
.badge.tagcell{padding:3mm 4mm}
.toetag{flex:1;position:relative;background:var(--kraft);padding:9mm 4mm 3mm;display:flex;flex-direction:column;gap:2mm;
  clip-path:polygon(14mm 0,calc(100% - 14mm) 0,100% 12mm,100% 100%,0 100%,0 12mm)}
.hole{position:absolute;left:50%;top:2.6mm;translate:-50% 0;width:5mm;height:5mm;border-radius:50%;background:var(--paper);border:.6mm solid var(--ink)}
.ttop{display:flex;align-items:baseline;justify-content:space-between;border-bottom:.6mm solid var(--ink);padding-bottom:1mm}
.ttop b{font-family:var(--display);font-weight:800;font-size:27pt;line-height:1;color:var(--seal);letter-spacing:.15em}
.ttop small{color:var(--ink)}
.report{background:var(--seal);color:var(--paper);text-align:center;font-weight:900;font-size:16pt;padding:1mm 0;letter-spacing:.12em}
.tfoot{display:flex;align-items:baseline;justify-content:space-between;font-size:9pt;font-weight:700}.tfoot b{font-size:14pt}
.note{font-size:7.5pt;text-align:center;color:var(--ink);opacity:.75}
/* 장소: 증거물 봉투 (A4 세로) */
.place-page{page:placepage;width:100%;height:296mm;padding:11mm 13mm;display:flex;break-after:page;overflow:hidden}
.bag{flex:1;display:flex;flex-direction:column;border:.7mm solid var(--ink);border-radius:2mm;background:var(--wash);overflow:hidden}
.seal{background:var(--seal);color:var(--paper);display:flex;align-items:center;justify-content:space-between;padding:3mm 6mm;
  border-bottom:1.6mm dashed var(--paper)}
.seal b{font-family:var(--display);font-weight:800;font-size:24pt;letter-spacing:.3em}
.seal span{font-family:var(--code);font-size:9pt;font-weight:700;letter-spacing:.12em}
.bagbody{flex:1;display:flex;flex-direction:column;gap:6mm;padding:7mm 9mm 8mm}
.label{background:var(--paper);border:.7mm solid var(--ink);padding:3mm 5mm 4mm;display:flex;flex-direction:column;min-height:36mm}
.lrow{display:flex;align-items:center;justify-content:space-between}
.lno{display:flex;align-items:baseline;gap:1.5mm;border:.5mm solid var(--ink);padding:.5mm 2.5mm}.lno b{font-size:18pt}
.pname{font-family:var(--display);font-weight:800;font-size:48pt;line-height:1.12;margin:1mm 0 0;word-break:keep-all;text-wrap:balance}
.bagbody .qrwell{flex:none}
.custody{width:100%;border-collapse:collapse;background:var(--paper);margin-top:auto;font-size:11pt}
.custody th,.custody td{border:.4mm solid var(--ink);padding:2mm 3mm;text-align:left}
.custody th{width:18mm;font-family:var(--code);font-size:8.5pt;color:var(--rule);background:var(--wash);white-space:nowrap}
.custody td{font-weight:700}.custody td.num{font-size:14pt}
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

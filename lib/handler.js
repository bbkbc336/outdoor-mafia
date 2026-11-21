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
    req.on('data', (d) => { n += d.length; if (n > 450000) { reject(new Error('too large')); req.destroy(); } else chunks.push(d); });
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
  kill: (r, p, b) => G.kill(r, p, b.target, b.seq, b.qr),
  scan: (r, p, b) => G.scan(r, p, b.value, b.seq),
  answer: (r, p, b) => G.answer(r, p, b.taskId, b.option, b.seq),
  play: (r, p, b) => G.play(r, p, b.taskId, b.result),
  report: (r, p, b) => G.report(r, p, b.qr, b.seq, b.place),
  emergency: (r, p, b) => G.emergency(r, p, b.seq),
  vote: (r, p, b) => G.castVote(r, p, b.target, b.seq),
  discuss: (r, p, b) => G.discussVote(r, p, b.choice, b.seq),
  arrive: (r, p, b) => G.arrive(r, p, b.seq),
  swapTask: (r, p, b) => G.swapTask(r, p, b.taskId, b.seq),
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

  // 장소 사진: 저장소가 사진 칸을 따로 갖고 있으면 그곳에, 없으면(로컬 파일 저장소) 이 서버 메모리에 둡니다.
  const memPhotos = new Map();
  const putPhoto = (code, loc, ph) => (store && store.putPhoto ? store.putPhoto(code, loc, ph) : memPhotos.set(code + ':' + loc, ph));
  const getPhoto = async (code, loc) => (store && store.getPhoto ? store.getPhoto(code, loc) : memPhotos.get(code + ':' + loc) || null);
  const PHOTO_RE = /^data:image\/(jpeg|webp|png);base64,([A-Za-z0-9+/=]+)$/;

  async function sendPhoto(res, url) {
    const ph = await getPhoto(upper(url.searchParams.get('code')), String(url.searchParams.get('loc') || '').slice(0, 20));
    if (!ph) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end('사진이 없습니다.'); }
    const bin = atob(ph.data), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // 주소에 사진 버전(v)이 붙어 있어 사진을 바꾸면 주소도 바뀝니다. 그래서 오래 보관해도 됩니다.
    res.writeHead(200, { 'Content-Type': 'image/' + ph.type, 'Cache-Control': 'public, max-age=31536000, immutable' });
    return res.end(bytes);
  }

  async function api(req, res, route) {
    if (route === '/api/ping') return json(res, 200, { ok: true, t: Date.now() });
    if (route === '/api/photo' && req.method === 'GET') return sendPhoto(res, new URL(req.url, 'http://x'));
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
      if (route === '/api/photo') { // 진행자가 장소 사진을 올리거나(data) 지움(data 없음)
        const cur = await store.get(code);
        if (!cur) throw new G.GameError('방을 찾을 수 없습니다. 방 코드를 확인하세요.');
        if (authIn(cur.room, b.token).who !== 'host') throw new G.GameError('진행자만 장소 사진을 바꿀 수 있습니다.');
        const loc = String(b.loc || '');
        if (!cur.room.locations.some(l => l.id === loc)) throw new G.GameError('장소를 찾을 수 없습니다. 장소를 먼저 저장하세요.');
        let version = 0;
        if (b.data) {
          const m = PHOTO_RE.exec(String(b.data));
          if (!m || m[2].length > 420000) throw new G.GameError('사진이 너무 크거나 올바르지 않습니다.');
          version = Date.now();
          await putPhoto(code, loc, { type: m[1], data: m[2] });
        }
        const out = await store.update(code, (room) => G.setLocPhoto(room, loc, version));
        return json(res, 200, { ok: true, result: out.result, rev: out.meta, view: await viewFor(out.room, { who: 'host' }) });
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
    const bw = url.searchParams.get('bw') === '1'; // 흑백 인쇄용(흰 바탕 + 선 장식, 토너 절약)
    const joinUrl = `${origin}/?room=${room.code}`;
    // 장소·이름표 QR에는 방 코드를 넣지 않습니다. 같은 인쇄물을 다음 행사에도 씁니다.
    const scanUrl = (v) => `${origin}/?s=${v}`;
    const count = (k, def) => Math.max(1, Math.min(G.MAX_TAG, Number(url.searchParams.get(k)) || def));
    const pad = (n) => String(n).padStart(2, '0');
    let cards = '';
    if (what === 'all' || what === 'join') {
      cards += `<section class="sheet"><div class="card big"><h2>야외 마피아 입장</h2>${QR.artSvg(joinUrl)}<p class="code">방 코드 <b>${room.code}</b></p><p class="small">${esc(joinUrl)}</p></div></section>`;
    }
    // 꾸밈 그림(직접 그림): 반짝이 별, 별똥별, 꺾쇠. 글자·QR 칸과 겹치지 않는 빈 자리에만 둡니다.
    const SPARK = (c) => `<svg class="spark ${c || ''}" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 0C13 8 16 11 24 12C16 13 13 16 12 24C11 16 8 13 0 12C8 11 11 8 12 0Z"/></svg>`;
    const COMET = '<svg class="comet" viewBox="0 0 120 24" aria-hidden="true"><defs><linearGradient id="ct" x1="0" x2="1"><stop offset="0" stop-color="#ffd447" stop-opacity="0"/><stop offset="1" stop-color="#ffd447"/></linearGradient></defs><path d="M2 12 L96 9 L96 15 Z" fill="url(#ct)"/><path d="M104 1l3.2 6.6 7.3 1-5.3 5.1 1.3 7.2-6.5-3.4-6.5 3.4 1.3-7.2-5.3-5.1 7.3-1z" fill="#ffd447"/></svg>';
    // 장소 표지 아래 지구 지평선(그림). 큰 원 요소는 여러 장 인쇄 시 깨질 수 있어 SVG로 그립니다.
    const EARTH = '<svg class="earthsvg" viewBox="0 0 210 46" preserveAspectRatio="none" aria-hidden="true"><defs><radialGradient id="eg" cx=".5" cy="0" r="1"><stop offset="0" stop-color="#2f7be6"/><stop offset=".45" stop-color="#123a8f"/><stop offset="1" stop-color="#081536"/></radialGradient><filter id="glow" x="-10%" y="-60%" width="120%" height="220%"><feGaussianBlur stdDeviation="2.2"/></filter></defs><ellipse cx="105" cy="150" rx="210" ry="132" fill="none" stroke="#59c8ff" stroke-width="5" filter="url(#glow)" opacity=".9"/><ellipse cx="105" cy="150" rx="210" ry="132" fill="url(#eg)"/><ellipse cx="105" cy="150" rx="210" ry="132" fill="none" stroke="#c8f6ff" stroke-width="1"/></svg>';
    const CHEV = '<span class="chev">›</span><span class="chev">›</span><span class="chev">›</span>';
    // 흑백 장소 쪽 바탕(흰 바탕 + 옅은 회색 격자 + 검은 별): 투명도 없는 단색 벡터
    const BW_PAGE_BG = (() => {
      let seed = 5; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      let g = '', st = '';
      for (let x = 30; x < 210; x += 30) g += `<line x1="${x}" y1="0" x2="${x}" y2="297"/>`;
      for (let y = 30; y < 297; y += 30) g += `<line x1="0" y1="${y}" x2="210" y2="${y}"/>`;
      for (let i = 0; i < 90; i++) st += `<circle cx="${(rnd() * 210).toFixed(1)}" cy="${(rnd() * 297).toFixed(1)}" r="${(0.2 + rnd() * 0.22).toFixed(2)}" fill="${i % 3 ? '#000' : '#777'}"/>`;
      return `<svg class="bwpagebg" viewBox="0 0 210 297" preserveAspectRatio="none" aria-hidden="true"><rect width="210" height="297" fill="#fff"/><g stroke="#e4e4e4" stroke-width=".25">${g}</g>${st}</svg>`;
    })();
    // 흑백 인쇄용 선 장식: 아래 지구 지평선(선 두 줄), 지평선 위 빈 곳에 고리 행성(왼쪽)·로켓(오른쪽). 서로 겹치지 않게. 검은 선만 써서 토너가 적게 듦
    const BW_DECOR = `<svg class="bwdecor" viewBox="0 0 210 60" preserveAspectRatio="none" aria-hidden="true" fill="none" stroke="#000">
      <path d="M-5 60 Q105 18 215 60" stroke-width=".9"/><path d="M-5 60 Q105 24 215 60" stroke-width=".35"/></svg>
      <svg class="bwplanet" viewBox="0 0 40 30" aria-hidden="true" fill="#fff" stroke="#000" stroke-width="1.1"><ellipse cx="20" cy="15" rx="18" ry="5.5" transform="rotate(-18 20 15)"/><circle cx="20" cy="15" r="8.5"/><path d="M3.4 19.6 Q20 12 36.6 10.4" fill="none" stroke-width="1.1"/><path d="M14 11.5 q3 -2 7 -1" fill="none" stroke-width=".6"/></svg>
      <svg class="bwrocket" viewBox="0 0 24 40" aria-hidden="true" fill="#fff" stroke="#000" stroke-width="1"><path d="M12 2 C17 8 18 16 17 26 L7 26 C6 16 7 8 12 2 Z"/><circle cx="12" cy="13" r="2.6"/><path d="M7 20 L3 28 L7 27 M17 20 L21 28 L17 27"/><path d="M9.5 28 L12 36 L14.5 28" stroke-dasharray="1.4 1.2"/></svg>`;
    if (what === 'all' || what === 'places') {
      for (const l of room.locations) {
        cards += placePage(scanUrl(l.code), `<h2 class="pname title3d">${esc(l.name)}</h2>`, l.no, l.code);
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
    // 이름표는 한 줄에 앞면(이름 칸)과 뒷면(💀 사망 표시 + QR)을 나란히 놓아 한 면 인쇄 후 반으로 접습니다.
    // side=front / side=back 이면 양면 프린터용으로 그 면만
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
    // 장소 QR: 우주 오락실 표지. 큰 입체 제목(장소 이름), 빛나는 QR, 아래 지구 지평선.
    // QR은 앱의 'QR 스캔'으로 찍습니다(카메라 앱은 입장하지 않은 다른 브라우저를 열 수 있음).
    // 장소 QR만 '밝은 우주' 디자인(정면에서 차분히 찍으니까). 몸·이름표 QR은 아무 각도에서나 찍혀야 해서 평범한 QR 그대로.
    function placePage(url, nameHtml, no, codeStr) {
      return `<section class="place-page">
        <div class="hud-top"><div class="chevs">${CHEV}</div><div class="pill"></div><div class="chevs r">${CHEV}</div></div>
        <div class="sub">${COMET}<span>임무 구역 · TASK ${pad(no)}</span></div>
        <div class="titlewrap">${SPARK('l')}${nameHtml}${SPARK('r')}</div>
        <div class="hudframe"><div class="qrplate">${QR.artSvg(url, { mono: bw })}</div></div>
        <div class="pbottom"><p>앱에서 <b>QR 스캔</b>을 눌러 찍으세요</p><span class="num">CODE ${codeStr}</span></div>
        <div class="hud-bottom"><div class="haz"></div><div class="haz"></div></div>${bw ? BW_PAGE_BG + BW_DECOR : EARTH}</section>`;
    }
    if (what === 'blankTags') {
      cards += badgeSheets(Array.from({ length: count('n', 40) }, (_, i) => ({ n: i + 1, name: '' })), side);
    }
    // 몸 부착용 이름표 QR: A4 세로 한 장에 2가지 번호 × 2장씩(한 줄에 같은 번호 2개, 세로로 긴 조각 4개). 등·가슴 등에 붙입니다.
    // 목걸이 이름표와 같은 QR이라 어느 쪽을 찍어도 같은 사람입니다(이름표 찍기 암살·시체 신고 모두).
    // 일반 종이에 인쇄해 잘라서 위아래 장식 띠에 테이프를 붙입니다(QR 위로 테이프가 지나가면 반사돼 안 찍힘).
    // 몸 부착 조각 배경: 투명·흐림 효과 없이 단색 벡터만 씁니다. (CSS 그라디언트·흐린 그림자는 PDF에서 투명 마스크가 되어
    // 아이폰 PDF 보기 등에서 첫 조각만 제대로 나오고 나머지가 하늘색 상자로 깨지는 문제가 있었음)
    const BT_BG = (() => {
      let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      let stars = '';
      for (let i = 0; i < 70; i++) {
        const x = (rnd() * 94).toFixed(1), y = (rnd() * 136).toFixed(1), r = (0.18 + rnd() * 0.3).toFixed(2);
        const c = bw ? '#000' : ['#ffffff', '#c9d4f2', '#9ff5c9'][i % 3];
        if (bw && i % 2) continue; // 흑백은 별을 반만, 작은 검은 점
        stars += `<circle cx="${x}" cy="${y}" r="${bw ? (r * 0.7).toFixed(2) : r}" fill="${c}"/>`;
      }
      let grid = '';
      for (let x = 12; x < 94; x += 12) grid += `<line x1="${x}" y1="0" x2="${x}" y2="136"/>`;
      for (let y = 12; y < 136; y += 12) grid += `<line x1="0" y1="${y}" x2="94" y2="${y}"/>`;
      if (bw) return `<svg class="btbg" viewBox="0 0 94 136" preserveAspectRatio="none" aria-hidden="true"><rect width="94" height="136" fill="#fff"/>
        <g stroke="#e2e2e2" stroke-width=".22">${grid}</g>${stars}
        <g fill="none" stroke="#000"><line x1="0" y1="10" x2="94" y2="10" stroke-width=".3"/><line x1="0" y1="126" x2="94" y2="126" stroke-width=".3"/>
        <line x1="0" y1="100" x2="94" y2="100" stroke-width=".6"/><line x1="0" y1="101.2" x2="94" y2="101.2" stroke-width=".25"/>
        <path d="M-4 126 Q47 117 98 126" stroke-width=".5"/><path d="M-4 126 Q47 119.5 98 126" stroke-width=".2"/></g></svg>`;
      return `<svg class="btbg" viewBox="0 0 94 136" preserveAspectRatio="none" aria-hidden="true"><defs>
        <linearGradient id="btg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b1330"/><stop offset="1" stop-color="#05070f"/></linearGradient>
        <linearGradient id="btb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0f2a6e"/><stop offset="1" stop-color="#081536"/></linearGradient></defs>
        <rect width="94" height="136" fill="url(#btg)"/><g stroke="#112a55" stroke-width=".25">${grid}</g>
        <rect y="100" width="94" height="26" fill="url(#btb)"/><ellipse cx="47" cy="134" rx="60" ry="14" fill="#173f99"/><ellipse cx="47" cy="137" rx="58" ry="13" fill="#0f2a6e"/>
        ${stars}<line x1="0" y1="100" x2="94" y2="100" stroke="#2b6fd6" stroke-width=".5"/></svg>`;
    })();
    if (what === 'bodyTags') {
      const from = Math.max(1, Math.min(G.MAX_TAG, Number(url.searchParams.get('from')) || 1));
      const nums = Array.from({ length: count('n', 40) }, (_, i) => from + i).filter(n => n <= G.MAX_TAG);
      for (let i = 0; i < nums.length; i += 2) {
        const part = nums.slice(i, i + 2);
        cards += '<section class="bodytags">' + part.map(n => {
          const one = `<div class="bodytag">${BT_BG}<div class="bttape"><div class="chevs">${CHEV}</div>${SPARK('bts')}</div>
            <div class="btqr">${SPARK('bt1')}${SPARK('bt2')}<div class="hudframe btf"><div class="qrplate btp">${QR.svg(scanUrl('P' + pad(n)))}</div></div></div>
            <div class="btband"><div class="btnum">${pad(n)}</div></div>
            <div class="bttape">${SPARK('bts')}<div class="chevs">${CHEV}</div></div></div>`;
          return one + one;
        }).join('') + '</section>';
      }
    }
    // 목걸이 이름표: 한 면 가로 94mm × 세로 120mm.
    //  앞면: 이름만 크게 적는 칸 (이름이 정해졌으면 인쇄)
    //  뒷면: 💀 사망 표시 + QR. 쓰러지면 이름표를 뒤집어 이 면이 보이게 합니다.
    // 기본(side 없음): 한 줄에 같은 사람의 [앞면 | 뒷면]을 나란히, A4 한 장에 2명. 한 면만 인쇄해서
    // 바깥 점선을 따라 자르고 가운데 접는 선에서 반으로 접으면 앞뒤가 됩니다(양면 프린터 필요 없음).
    // side=front / side=back: 양면 프린터용으로 앞면만·뒷면만 (2×2, 뒷면은 좌우를 바꿔 앞면과 겹치게).
    function frontOf(t, cls = '') { return `<div class="badge nfront ${cls}">
            <div class="chevs mini">${CHEV}</div>
            <div class="namebox"><small>이름</small>${t.name ? `<b>${esc(t.name)}</b>` : ''}</div>${SPARK('nb')}<div class="earth"></div></div>`; }
    function backOf(t, cls = '') { return `<div class="badge nback ${cls}"><div class="deadmark title3d red">사망</div><div class="hudframe sm"><div class="qrplate sm">${QR.svg(scanUrl('P' + pad(t.n)))}</div></div><div class="earth red"></div></div>`; }
    function badgeSheets(items, side) {
      let out = '';
      if (side !== 'front' && side !== 'back') {
        for (let i = 0; i < items.length; i += 2) {
          out += '<section class="badges pairs">' + items.slice(i, i + 2).map(t => frontOf(t, 'foldl') + backOf(t, 'foldr')).join('') + '</section>';
        }
        return out;
      }
      for (let i = 0; i < items.length; i += 4) {
        const part = items.slice(i, i + 4);
        if (side === 'front') out += '<section class="badges">' + part.map(t => frontOf(t)).join('') + '</section>';
        else out += '<section class="badges">' + [1, 0, 3, 2].map(k => (part[k] ? backOf(part[k]) : '<div class="badge empty"></div>')).join('') + '</section>';
      }
      return out;
    }
    const q = (w) => `/print?code=${room.code}&token=${encodeURIComponent(room.hostToken)}&what=${w}`;
    // 장소만 인쇄하면 기본 용지를 A4 가로로, 이름표만이면 A4 세로·여백 0으로 둡니다(이름 붙인 페이지를 모르는 브라우저 대비).
    const basePage = ['places', 'blankPlaces', 'players', 'blankTags', 'bodyTags'].includes(what) ? '@page{size:A4 portrait;margin:0}' : '@page{size:A4;margin:6mm}';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QR 인쇄 - ${room.code}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Black+Han+Sans&family=Orbitron:wght@700;900&family=Gothic+A1:wght@400;700;900&display=swap">
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
/* 몸 부착용(일반 종이 + 테이프): A4 한 장에 세로로 긴 조각 2×2(94×136mm), 곧은 점선 테두리, 사방 약 9mm 여백.
   위아래 10mm 장식 띠는 테이프 붙이는 곳. 가운데 QR(66mm, 흰 판 + HUD 테두리)은 테이프가 닿지 않게. 장식은 QR 바깥에만. */
.bodytags{page:tagpage;width:100%;height:296mm;box-sizing:border-box;display:grid;grid-template-columns:94mm 94mm;grid-template-rows:136mm 136mm;gap:6mm 6mm;justify-content:center;align-content:center;break-after:page;overflow:hidden}
.bodytag{position:relative;width:94mm;height:136mm;box-sizing:border-box;display:flex;flex-direction:column;align-items:stretch;background:#05070f;border:.3mm dashed #6b7896;overflow:hidden;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.bodytag > .btbg{position:absolute;inset:0;width:100%;height:100%;z-index:0}
.bodytag > div{position:relative;z-index:1}
.bttape{flex:0 0 10mm;display:flex;align-items:center;justify-content:space-between;padding:0 4mm}
.bttape .chevs .chev{font-size:10pt}
.btqr{flex:1;display:flex;align-items:center;justify-content:center}
.bodytag .spark{position:absolute;fill:#fff;filter:none}.bttape .spark.bts{position:static;width:4mm;height:4mm}
.btqr .spark{width:6mm;height:6mm}.btqr .spark.bt1{right:4mm;top:3mm}.btqr .spark.bt2{left:4mm;bottom:3mm;width:4mm;height:4mm}
.hudframe.btf{padding:1.6mm;border:.6mm solid #3fd0ff;border-radius:4mm;box-shadow:0 0 0 1.2mm #163a68}
.qrplate.btp{padding:2.5mm;border-radius:2mm;background:#f6f9ff}.qrplate.btp svg{width:66mm;height:66mm;display:block}
.btband{flex:0 0 26mm;display:flex;align-items:center;justify-content:center;gap:4mm;color:#f6f9ff}
.btband small{font-family:'Gothic A1',system-ui,sans-serif;font-weight:900;font-size:10pt;letter-spacing:.06em;color:#9ff5c9}
.btnum{font-family:'Orbitron',ui-monospace,monospace;font-weight:900;font-size:40pt;line-height:1;color:#ffd23f}
/* 흑백 인쇄용 몸 부착 QR: 흰 바탕 + 검은 선 */
.bw .bodytag{background:#fff;border-color:#888}
.bw .bodytag .spark{fill:#fff;stroke:#000;stroke-width:1.4}
.bw .bodytag .chev{color:#000}
.bw .hudframe.btf{border-color:#000;box-shadow:0 0 0 1.2mm #fff,0 0 0 1.6mm #000}
.bw .qrplate.btp{background:#fff}
.bw .btband small{color:#000}.bw .btnum{color:#fff;-webkit-text-stroke:.9mm #000;paint-order:stroke fill;text-shadow:.5mm .5mm 0 #000,1mm 1mm 0 #000}
/* 설계: 우주 오락실 — 깊은 우주, 하늘색 HUD 격자, 아래에서 빛나는 지구 지평선, 노랑 꺾쇠·경고 띠,
   흰 글자에 민트 테두리와 파란 입체 그림자를 준 굵은 제목, 반짝이 별·별똥별. 꾸밈은 빈 자리에만, 이름 칸·사망·QR은 밝은 판으로.
   색: 우주 · HUD 하늘색 · 입체 파랑 · 민트 · 경고 노랑 · 비상 빨강 / 글꼴: 제목 Black Han Sans · 본문 Gothic A1 · 숫자 Orbitron */
:root{--void:#05070f;--deep:#0b1330;--hud:#3fd0ff;--blue:#1f56d6;--navy:#122f86;--mint:#9ff5c9;--amber:#ffd23f;--alarm:#d3132f;--chalk:#f6f9ff;
  --display:'Black Han Sans','Gothic A1',sans-serif;--body:'Gothic A1','Noto Sans KR',system-ui,sans-serif;--code:'Orbitron',ui-monospace,monospace}
.badge,.place-page,.badge *,.place-page *{-webkit-print-color-adjust:exact;print-color-adjust:exact;box-sizing:border-box}
.badge,.place-page{font-family:var(--body);position:relative}
.num{font-family:var(--code);font-variant-numeric:tabular-nums;letter-spacing:.08em}
.badge small,.place-page small{font-family:var(--body);font-weight:900;font-size:10pt;letter-spacing:.1em;color:#7d8bb0;display:block}
/* 우주 바탕 = 별 세 겹 + HUD 격자 + 아래 지구 빛 */
.space{background:
  radial-gradient(ellipse 140% 60% at 50% 118%,#7fd8ff 0,#2b7de0 8%,#0f2a6e 22%,transparent 40%),
  radial-gradient(circle at 20% 30%,#fff 0 .35mm,transparent .45mm) 0 0/17mm 19mm,
  radial-gradient(circle at 70% 60%,rgba(255,255,255,.6) 0 .25mm,transparent .35mm) 0 0/11mm 13mm,
  radial-gradient(circle at 40% 80%,rgba(159,245,201,.7) 0 .3mm,transparent .4mm) 0 0/23mm 29mm,
  linear-gradient(rgba(63,208,255,.13) .25mm,transparent .25mm) 0 0/100% 24mm,
  linear-gradient(90deg,rgba(63,208,255,.13) .25mm,transparent .25mm) 0 0/24mm 100%,
  radial-gradient(ellipse at 50% 30%,var(--deep),var(--void) 75%)}
/* 입체 제목: 흰 글자 + 민트 테두리 + 파란 입체 그림자 */
.title3d{font-family:var(--display);font-weight:400;color:var(--chalk);-webkit-text-stroke:1.3mm var(--mint);paint-order:stroke fill;
  text-shadow:0 .8mm 0 var(--blue),0 1.6mm 0 var(--blue),0 2.4mm 0 var(--navy),0 3.2mm 0 var(--navy),0 4mm 3mm rgba(0,0,0,.5)}
.title3d.red{-webkit-text-stroke-color:var(--amber);text-shadow:0 .8mm 0 var(--alarm),0 1.6mm 0 var(--alarm),0 2.4mm 0 #7d0012,0 3.2mm 0 #7d0012,0 4mm 3mm rgba(0,0,0,.5)}
.spark{width:9mm;height:9mm;fill:var(--chalk);filter:drop-shadow(0 0 1.5mm var(--hud))}
.chevs{display:flex;gap:1.2mm}.chev{font-family:var(--code);font-weight:900;font-size:16pt;line-height:1;color:var(--amber)}
/* QR 판 + HUD 테두리 */
.qrplate{background:var(--chalk);padding:4.5mm;line-height:0;border-radius:3mm}
.qrplate svg{display:block;width:132mm;height:132mm}
.hudframe{align-self:center;padding:3mm;border:.8mm solid var(--hud);border-radius:6mm;box-shadow:0 0 0 1.6mm rgba(63,208,255,.18),0 0 7mm rgba(63,208,255,.45)}
.hudframe.sm{padding:2mm;border-width:.6mm;border-radius:4mm;border-color:var(--amber);box-shadow:0 0 5mm rgba(255,210,63,.5)}
.qrplate.sm{padding:3mm;border-radius:2mm}.qrplate.sm svg{width:54mm;height:54mm}
/* 이름표 칸 (94×120mm) */
.badge{width:94mm;height:120mm;border:.3mm dashed #8f9bb3;padding:6mm;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5mm;overflow:hidden;
  background:
  radial-gradient(ellipse 160% 45% at 50% 120%,#7fd8ff 0,#2b7de0 9%,#0f2a6e 24%,transparent 42%),
  radial-gradient(circle at 20% 30%,#fff 0 .35mm,transparent .45mm) 0 0/17mm 19mm,
  radial-gradient(circle at 70% 60%,rgba(255,255,255,.6) 0 .25mm,transparent .35mm) 0 0/11mm 13mm,
  linear-gradient(rgba(63,208,255,.14) .25mm,transparent .25mm) 0 0/100% 15mm,
  linear-gradient(90deg,rgba(63,208,255,.14) .25mm,transparent .25mm) 0 0/15mm 100%,
  radial-gradient(ellipse at 50% 30%,var(--deep),var(--void) 75%)}
.badges.pairs{align-content:center}
.badge.foldl{border-right:.5mm dashed #ffd23f}.badge.foldr{border-left:0}
.badge.empty{border-color:transparent;background:none}
.chevs.mini{position:absolute;top:5mm;left:6mm}.chevs.mini .chev{font-size:11pt}
.namebox{width:74mm;height:50mm;background:var(--chalk);border-radius:6mm;padding:4mm 5mm;display:flex;flex-direction:column;
  box-shadow:0 0 0 1.2mm var(--hud),0 2.2mm 0 1.2mm var(--blue),0 0 8mm rgba(63,208,255,.5)}
.namebox b{flex:1;display:flex;align-items:center;justify-content:center;text-align:center;font-family:var(--display);font-weight:400;font-size:30pt;line-height:1.1;color:var(--deep);word-break:keep-all}
.spark.nb{position:absolute;right:6mm;top:13mm;width:8mm;height:8mm}
.nback{background:
  radial-gradient(ellipse 160% 45% at 50% 120%,#ff8a7a 0,#d3132f 10%,#5a0a1a 26%,transparent 44%),
  radial-gradient(circle at 20% 30%,#fff 0 .35mm,transparent .45mm) 0 0/17mm 19mm,
  radial-gradient(circle at 70% 60%,rgba(255,255,255,.6) 0 .25mm,transparent .35mm) 0 0/11mm 13mm,
  linear-gradient(rgba(255,210,63,.12) .25mm,transparent .25mm) 0 0/100% 15mm,
  linear-gradient(90deg,rgba(255,210,63,.12) .25mm,transparent .25mm) 0 0/15mm 100%,
  radial-gradient(ellipse at 50% 30%,#2a0a14,var(--void) 80%)}
.deadmark{font-size:46pt;line-height:1;letter-spacing:.2em;padding-left:.2em}
/* 장소 (A4 세로 전체) */
.place-page{page:placepage;width:100%;height:297mm;color:var(--chalk);padding:10mm 15mm 0;display:flex;flex-direction:column;align-items:center;gap:6mm;break-after:page;overflow:hidden;
  background:
  radial-gradient(ellipse 130% 34% at 50% 112%,#a8ecff 0,#3b8ff0 7%,#123a8f 18%,transparent 34%),
  radial-gradient(circle at 20% 30%,#fff 0 .45mm,transparent .55mm) 0 0/23mm 27mm,
  radial-gradient(circle at 70% 60%,rgba(255,255,255,.6) 0 .3mm,transparent .4mm) 0 0/13mm 17mm,
  radial-gradient(circle at 40% 80%,rgba(159,245,201,.7) 0 .35mm,transparent .45mm) 0 0/31mm 37mm,
  linear-gradient(rgba(63,208,255,.12) .3mm,transparent .3mm) 0 0/100% 30mm,
  linear-gradient(90deg,rgba(63,208,255,.12) .3mm,transparent .3mm) 0 0/30mm 100%,
  radial-gradient(ellipse at 50% 25%,var(--deep),var(--void) 75%)}
.hud-top{width:100%;display:flex;align-items:center;justify-content:space-between}
.pill{width:46mm;height:4mm;border-radius:2mm;background:var(--amber);box-shadow:0 0 4mm rgba(255,210,63,.6)}
.chevs.r{transform:scaleX(-1)}
.sub{display:flex;align-items:center;gap:3mm}
.comet{width:30mm;height:6mm}
.sub span{font-family:var(--display);font-size:20pt;color:var(--mint);-webkit-text-stroke:.9mm var(--navy);paint-order:stroke fill;letter-spacing:.06em}
.titlewrap{width:100%;display:grid;grid-template-columns:12mm 1fr 12mm;align-items:center;gap:2mm;min-height:36mm}
.titlewrap .spark{width:10mm;height:10mm;justify-self:center}.titlewrap .spark.l{align-self:end}.titlewrap .spark.r{align-self:start}
.pname{font-size:58pt;line-height:1.08;margin:0;text-align:center;word-break:keep-all;text-wrap:balance}
.pwrite{height:30mm;background:var(--chalk);border-radius:4mm;padding:3mm 5mm;box-shadow:0 0 0 1.2mm var(--hud),0 2.2mm 0 1.2mm var(--blue)}
.pbottom{width:100%;display:flex;align-items:center;justify-content:space-between;gap:6mm;padding-top:1mm}
.pbottom p{margin:0;font-size:17pt;font-weight:900}.pbottom p b{color:var(--amber)}
.pbottom span{font-size:12pt;color:var(--hud)}
.hud-bottom{width:calc(100% + 30mm);margin-top:auto;display:flex;justify-content:space-between;padding:0 6mm 7mm}
.haz{width:52mm;height:5mm;background:repeating-linear-gradient(-55deg,var(--amber) 0 3mm,transparent 3mm 6mm);opacity:.95}
/* 지구 지평선: 아래 빈 자리에만, 내용보다 뒤에 */
.badge > *:not(.earth),.place-page > *:not(.earthsvg){position:relative;z-index:1}
.badge > .spark.nb,.badge > .chevs.mini{position:absolute;z-index:1}
.earth{position:absolute;left:50%;translate:-50% 0;border-radius:50%;z-index:0;pointer-events:none;
  background:radial-gradient(circle at 50% 30%,#2a6fd8 0,#123a8f 35%,#081536 70%);
  box-shadow:0 -1.2mm 0 #bff3ff,0 -3mm 5mm #59c8ff,0 -8mm 14mm rgba(63,160,255,.55)}
.earthsvg{position:absolute;left:0;bottom:0;width:100%;height:46mm;z-index:0}
.badge .earth{width:180mm;height:180mm;top:108mm}
.earth.red{background:radial-gradient(circle at 50% 30%,#d3132f 0,#7d0012 40%,#2a0510 75%);box-shadow:0 -1mm 0 #ffd0c8,0 -2.5mm 4mm #ff6a5a,0 -7mm 12mm rgba(255,60,60,.5)}
/* ───── 흑백 인쇄용(bw=1): 흰 바탕, 장식은 검은 선으로만. 같은 '우주 오락실' 느낌을 선 그림으로 ───── */
.bw .place-page{color:#111;background:#fff}
.bw .place-page > .bwpagebg{position:absolute;inset:0;width:100%;height:100%;z-index:0}
.bw .title3d{color:#fff;-webkit-text-stroke:1mm #000;paint-order:stroke fill;text-shadow:.6mm .6mm 0 #000,1.2mm 1.2mm 0 #000,1.8mm 1.8mm 0 #000}
.bw .chev{color:#000}.bw .pill{background:none;border:.5mm solid #000;box-shadow:none}
.bw .spark{fill:#fff;stroke:#000;stroke-width:1.4;filter:none}
.bw .comet{display:none} /* 흐려지는 꼬리(투명) 대신 숨김 */.bw .place-page .sub span{color:#000}
.bw .hudframe{border-color:#000;border-width:.6mm;box-shadow:0 0 0 1.2mm #fff,0 0 0 1.6mm #000}
.bw .qrplate{background:#fff}
.bw .pwrite{background:#fff;box-shadow:0 0 0 .6mm #000,1.6mm 1.6mm 0 .6mm #000}
.bw .pbottom p b{color:#000;text-decoration:underline;text-decoration-thickness:.6mm}.bw .pbottom span{color:#000}
.bw .haz{background:repeating-linear-gradient(-55deg,#000 0 .8mm,transparent .8mm 5mm);opacity:1;border-top:.4mm solid #000;border-bottom:.4mm solid #000}
.bw .place-page > .bwdecor{position:absolute;left:0;bottom:0;width:100%;height:60mm;z-index:0}
.bw .place-page > .bwplanet{position:absolute;left:14mm;bottom:17mm;width:34mm;height:26mm;z-index:0}
.bw .place-page > .bwrocket{position:absolute;right:22mm;bottom:17mm;width:13mm;height:22mm;rotate:24deg;z-index:0}
.bw .hud-bottom{visibility:hidden} /* 흑백에서는 경고 띠를 빼서 지평선·행성과 겹치지 않게 */
@page placepage{size:A4 portrait;margin:0}@page tagpage{size:A4 portrait;margin:0}
@media screen{body{background:#e9e9ee}.place-page{width:210mm}.badges,.bodytags{width:210mm}.place-page,.badges,.bodytags{background:#fff;margin:8mm auto;box-shadow:0 2px 10px rgba(0,0,0,.18)}.bar .tip{font-size:13px;color:#ccc}}.title{font-size:20px}table{border-collapse:collapse;width:100%;font-size:15px}td,th{border:1px solid #999;padding:6px;text-align:left}
@media print{.bar{display:none}.sheet{padding:6mm}}${basePage}
</style></head><body class="${bw ? 'bw' : ''}">
<div class="bar"><b>방 ${room.code} QR 인쇄</b>
<a href="${q('all')}">전체</a>
<a href="${q('join')}">입장 QR</a>
<a href="${q('places')}">장소 QR</a>
<a href="${q('players')}">이름표 QR</a>
<a href="${q('blankPlaces')}&n=10">번호만 장소 10장</a>
<a href="${q('blankTags')}&n=40">번호만 이름표 40장 (한 줄에 앞면·뒷면, 반으로 접기)</a>
<a href="${q('blankTags')}&n=40&side=front">이름표 앞면</a>
<a href="${q('blankTags')}&n=40&side=back">이름표 뒷면</a>
<a href="${q('bodyTags')}&n=40">몸 부착용 이름표 QR 01~40 (A4 한 장에 2번호 × 2장, 테이프로 붙이기)</a>
<a href="${q('bodyTags')}&n=40&bw=1">몸 부착용 흑백용</a>
<button onclick="print()">🖨 인쇄</button>
<span class="tip">인쇄 설정: 배율 100%(실제 크기), 배경 그래픽 켜기, 한 면 인쇄. 이름표는 한 줄에 앞면(이름 칸)과 뒷면(사망 + QR)이 나란히, A4 한 장에 2명. 바깥 회색 점선을 자르고 가운데 노란 점선에서 반으로 접으세요.</span></div>
${cards}</body></html>`);
  }

  // ───────────── 정적 파일 (로컬 서버 전용, Vercel은 public/을 직접 제공) ─────────────
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
  function serveStatic(req, res, p) {
    if (p === '/' || p === '') p = '/index.html';
    if (p === '/host') p = '/host.html';
    if (p === '/practice') p = '/practice.html';
    if (p === '/screen') p = '/screen.html';
    if (p === '/guide') p = '/guide.html';
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
        // 입장 QR(진행자·큰 화면): 밝은 우주 디자인(시안 A)
        try { const svg = QR.artSvg(text); res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' }); return res.end(svg); }
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

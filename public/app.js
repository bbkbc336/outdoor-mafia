// 참가자 화면
'use strict';

const params = new URLSearchParams(location.search);
const S = {
  code: (params.get('room') || store.get('mafia:last') || '').toUpperCase(),
  token: null,
  view: null,
  online: false,
  roleShown: false,
  secretOpen: false,
  pendingScan: params.get('s'),
  busy: false,
  stream: null,
  prev: null,
  notice: null,
};
if (S.code) S.token = store.get('mafia:p:' + S.code);
if (S.pendingScan) {
  // 주소창에서 스캔 값을 지워 새로고침 시 다시 실행되지 않게 합니다.
  const u = new URL(location.href); u.searchParams.delete('s');
  history.replaceState(null, '', u.pathname + (u.searchParams.toString() ? '?' + u.searchParams : ''));
}

const app = $('#app');

// ───────────── 입장 ─────────────
function renderHome(mode = 'join', err = '') {
  app.innerHTML = `<main>
    <h1 class="brand">🕵️ 야외 마피아</h1>
    ${S.notice ? `<div class="card danger">${esc(S.notice)}</div>` : ''}
    <div class="card">
      ${mode === 'join' ? `
      <form id="joinForm" autocomplete="off">
        <label>방 코드</label>
        <input id="fCode" class="code" maxlength="4" value="${esc(S.code)}" placeholder="ABCD" autocapitalize="characters">
        <label>이름 (현장에서 부르는 이름)</label>
        <input id="fName" maxlength="12" placeholder="예: 김지민" value="${esc(store.get('mafia:name') || '')}">
        ${err ? `<p style="color:var(--bad);font-weight:700">${esc(err)}</p>` : ''}
        <button class="primary" style="margin-top:16px">입장하기</button>
      </form>
      <button class="ghostbtn" id="toRecover" style="margin-top:10px">복구 코드로 다시 들어가기</button>` : `
      <form id="recForm" autocomplete="off">
        <h2>다시 들어가기</h2>
        <p class="muted small">입장할 때 받은 6자리 복구 코드를 입력하세요. 모르면 진행자에게 물어보세요.</p>
        <label>방 코드</label>
        <input id="fCode" class="code" maxlength="4" value="${esc(S.code)}" autocapitalize="characters">
        <label>복구 코드</label>
        <input id="fRec" class="code" maxlength="6" inputmode="numeric" placeholder="000000">
        ${err ? `<p style="color:var(--bad);font-weight:700">${esc(err)}</p>` : ''}
        <button class="primary" style="margin-top:16px">복구하기</button>
      </form>
      <button class="ghostbtn" id="toJoin" style="margin-top:10px">처음 입장하기</button>`}
    </div>
    <a class="guidebtn" href="/guide${S.code ? '?room=' + encodeURIComponent(S.code) : ''}">📖 규칙 카드뉴스 보기 <span>1분이면 다 읽어요</span></a>
    <p class="center small"><a href="/practice" style="color:var(--accent)">🎮 미니게임 연습하기</a></p>
    <p class="center small muted">진행자이신가요? <a href="/host" style="color:var(--accent)">방 만들기</a></p>
  </main>`;
  const j = $('#joinForm'), r = $('#recForm');
  if (j) j.onsubmit = async (e) => {
    e.preventDefault();
    const code = $('#fCode').value.trim().toUpperCase(), name = $('#fName').value.trim();
    if (!code || !name) return renderHome('join', '방 코드와 이름을 입력하세요.');
    const res = await postJSON('/api/join', { code, name });
    if (!res.ok) return renderHome('join', res.error);
    store.set('mafia:name', name);
    enter(res.code, res.token);
  };
  if (r) r.onsubmit = async (e) => {
    e.preventDefault();
    const code = $('#fCode').value.trim().toUpperCase();
    const res = await postJSON('/api/recover', { code, recovery: $('#fRec').value.trim() });
    if (!res.ok) return renderHome('recover', res.error);
    enter(res.code, res.token);
  };
  const tr = $('#toRecover'), tj = $('#toJoin');
  if (tr) tr.onclick = () => { S.notice = null; renderHome('recover'); };
  if (tj) tj.onclick = () => { S.notice = null; renderHome('join'); };
}

function enter(code, token) {
  S.code = code; S.token = token; S.notice = null;
  store.set('mafia:p:' + code, token);
  store.set('mafia:last', code);
  const u = new URL(location.href); u.searchParams.set('room', code);
  history.replaceState(null, '', u.pathname + '?' + u.searchParams);
  connect();
}

// 화면에 보이는 내용 비교용: 방 전체 버전·서버 시각은 빼고, noProgress면 공동 진행률도 뺍니다.
function screenKey(v, noProgress) {
  const { version, serverNow, remainMs, ...rest } = v;
  if (noProgress) delete rest.progress;
  return JSON.stringify(rest);
}
function patchProgress(v) {
  const box = document.getElementById('prog');
  if (!box || !v.progress) return false;
  const pct = v.progress.pct;
  const b = box.querySelector('.row b'), bar = box.querySelector('.progress > div');
  if (!b || !bar) return false;
  b.textContent = pct + '%';
  bar.style.width = Math.min(100, pct) + '%';
  return true;
}

function leave(msg) {
  if (S.stream) S.stream.close();
  S.stream = null; S.view = null; S.token = null;
  store.del('mafia:p:' + S.code);
  Scanner.close(); closeModal(); Awake.set(false);
  S.notice = msg || null;
  renderHome();
}

function connect() {
  if (S.stream) S.stream.close();
  app.innerHTML = '<main><p class="muted center" style="margin-top:40vh">연결 중…</p></main>';
  S.stream = connectStream(S.code, S.token, {
    onState: (v) => {
      const prev = S.view;
      // 늦게 도착한 옛 상태가 더 새로운 상태(내 행동의 응답 등)를 덮지 않게 합니다.
      if (prev && v.version < prev.version) return;
      S.view = v;
      // 나에게 보이는 내용이 그대로면 다시 그리지 않습니다(다른 사람의 행동, 펼친 메뉴 유지).
      if (prev && screenKey(prev) === screenKey(v)) return;
      // 공동 진행률만 바뀌었으면 그 숫자와 막대만 바꿉니다.
      if (prev && prev.phase === 'active' && screenKey(prev, true) === screenKey(v, true) && patchProgress(v)) return;
      onChange(prev, v); render();
      if (!prev) initPush();
    },
    onDenied: (msg) => leave(msg),
    onKicked: (msg) => leave(msg),
    onStatus: (on) => {
      if (S.online !== on) { S.online = on; renderBars(); }
      if (on) flushQueue(); // 연결이 돌아오면 저장해 둔 미니게임 완료를 보냅니다
    },
  });
}

// ───── 끊겨도 미니게임 완료 저장 ─────
// 전파가 끊긴 순간 미니게임을 끝내면 휴대폰에 저장해 두었다가 연결되면 보냅니다. 서버가 다시 확인하므로 안전합니다.
const qKey = () => 'mafia:q:' + S.code;
const loadQ = () => { const q = store.get(qKey()); return Array.isArray(q) ? q : []; };
let flushing = false;
async function flushQueue() {
  if (flushing || !S.token) return;
  const q = loadQ();
  if (!q.length) return;
  flushing = true;
  try {
    const left = [];
    for (const item of q) {
      const r = await postJSON('/api/act', { code: S.code, token: S.token, action: 'play', taskId: item.taskId, result: item.result });
      if (r.network || r.status >= 500) { left.push(item); continue; }
      if (r.ok) toast('✅ 연결되어 저장해 둔 미니게임 완료를 보냈습니다. ' + ((r.result && r.result.message) || ''), 'good', 3500);
      if (r.view) { syncClock(r.view); const prev = S.view; S.view = r.view; onChange(prev, r.view); render(); }
    }
    if (left.length) store.set(qKey(), left); else store.del(qKey());
  } finally { flushing = false; }
}
setInterval(() => { if (S.online) flushQueue(); }, 5000);

// ───── 회의 알림(푸시) 상태 ─────
async function initPush() {
  if (!Push.supported() || !(await Push.serverSupports())) { S.push = 'unsupported'; return; }
  if (Push.iosNeedsInstall()) S.push = 'ios';
  else if (Push.permission() === 'granted') S.push = await Push.subscribe(S.code, S.token, false).catch(() => 'error');
  else S.push = Push.permission();
  if (S.view && ['lobby', 'briefing'].includes(S.view.phase)) render();
}
function pushCard() {
  const st = S.push;
  if (!st || st === 'unsupported') return '';
  if (st === 'granted') return '<div class="card good center small">🔔 회의 알림 켜짐 — 화면이 꺼져 있어도 회의가 열리면 알려 줍니다</div>';
  if (st === 'ios') return `<div class="card center"><h3>🔔 회의 알림 받기 (아이폰)</h3>
    <p class="small">사파리 아래쪽 <b>공유 버튼(⬆)</b> → <b>홈 화면에 추가</b> → 홈 화면의 <b>야외 마피아</b> 아이콘으로 다시 열면 알림을 켤 수 있어요.</p></div>`;
  if (st === 'denied') return '<div class="card center small muted">🔕 알림이 차단되어 있어요. 휴대폰 설정에서 이 사이트의 알림을 허용하면 회의 알림을 받을 수 있어요.</div>';
  return `<div class="card center"><button class="primary" data-a="push" data-needs-online>🔔 회의 알림 받기</button>
    <p class="small muted" style="margin-top:6px">화면이 꺼져 있어도 회의가 열리면 진동과 알림으로 알려 줍니다</p></div>`;
}

// ───────────── 상태 변화 반응 ─────────────
function onChange(prev, v) {
  Awake.set(v.settings && v.settings.keepAwake && !['lobby', 'ended'].includes(v.phase));
  if (!prev) {
    // 휴대폰 카메라로 QR(주소)을 열고 들어온 경우: 대기 중이면 이름표 연결, 게임 중이면 임무·신고
    if (S.pendingScan && v.phase !== 'briefing') { const s = S.pendingScan; S.pendingScan = null; setTimeout(() => handleScan(s), 300); }
    else S.pendingScan = null;
    return;
  }
  const vib = buzz;
  if (prev.seq !== v.seq) {
    // 단계가 바뀌면 열려 있던 선택 창은 닫습니다(오래된 선택 방지).
    closeModal(); closeModal('confirm');
  }
  // 활동이 멈추면(회의·정지·사망) 하던 미니게임도 닫습니다. 다시 QR을 찍으면 새로 시작합니다.
  if (v.phase !== 'active' || v.paused || v.me.status === 'dead') Games.close();
  // 진행자가 대신 완료하는 등 지금 임무가 바뀌었으면, 열려 있던 그 임무의 게임도 닫습니다.
  if (S.gameTask && (!v.me.task || v.me.task.id !== S.gameTask)) { Games.close(); S.gameTask = null; }
  if (prev.phase !== v.phase) {
    if (v.phase !== 'active') Scanner.close();
    if (v.phase === 'gathering') { vib([500, 150, 500, 150, 500, 150, 800]); S.secretOpen = false; meetingAlarm(v); }
    if (v.phase === 'voting' || v.phase === 'ended' || v.phase === 'briefing') vib(200);
    S.roleShown = false;
  }
  if (prev.me.status !== 'dead' && v.me.status === 'dead') { Scanner.close(); vib([600, 200, 600]); }
  if (prev.paused !== v.paused) Scanner.close();
}

// ───────────── 행동 ─────────────
async function act(action, extra = {}) {
  if (!S.online) { toast('연결이 끊겨 있습니다. 연결되면 다시 눌러 주세요.', 'bad'); return null; }
  // QR 스캔은 바로 앞 요청(예: 미니게임 완료)이 끝날 때까지 잠깐 기다렸다가 처리합니다. 다른 버튼은 두 번 눌림을 막습니다.
  if (S.busy && action === 'scan') { for (let i = 0; i < 40 && S.busy; i++) await new Promise(r => setTimeout(r, 100)); }
  if (S.busy) return null;
  S.busy = true;
  try {
    const res = await postJSON('/api/act', { code: S.code, token: S.token, action, seq: S.view && S.view.seq, ...extra });
    if (res.view) { syncClock(res.view); const prev = S.view; S.view = res.view; onChange(prev, res.view); render(); }
    if (!res.ok) { toast(res.error, 'bad', 3200); return null; }
    return res.result || {};
  } finally { S.busy = false; }
}

async function handleScan(value) {
  const r = await act('scan', { value });
  if (!r) return;
  if (r.kind === 'done' || r.kind === 'claimed') toast('✅ ' + r.message, 'good', 3000);
  else if (r.kind === 'body') {
    if (!r.canReport) return toast(r.message, '', 3000);
    openModal(`<div class="center"><div class="emoji">🚨</div><h2>${esc(r.name)} 님이 쓰러져 있습니다</h2>
      <p class="muted">직접 쓰러진 사람을 발견했을 때만 신고하세요.</p></div>
      <div class="btns" style="margin-top:16px"><button class="danger" data-act="report">시체 신고 → 회의 소집</button><button data-act="close">취소</button></div>`, {
      report: () => askPlace(value),
    });
  } else if (r.kind === 'question') toast('표지를 보고 아래에서 답을 고르세요.', '', 3000);
  else if (r.kind === 'game') openGame(r.taskId, r.game, r.data, r.readyAt);
  else toast(r.message || '확인했습니다.', '', 3000);
}

// 신고 전에 어디서 발견했는지 고르게 합니다. 회의 화면에 "📍 OO에서 발견"으로 나옵니다.
function askPlace(qr) {
  const places = (S.view && S.view.places) || [];
  const send = async (place) => { closeModal(); const x = await act('report', { qr, place }); if (x) toast('신고했습니다. 집결 장소로 모이세요!', 'good'); };
  openModal(`<h2>📍 어디서 발견했나요?</h2>
    ${places.map((p, i) => `<button class="choice" data-act="p" data-i="${i}">${esc(p)}</button>`).join('')}
    <button class="choice" data-act="none" style="border-style:dashed">잘 모르겠어요 / 장소 근처가 아님</button>`, {
    p: (b) => send(places[Number(b.dataset.i)]),
    none: () => send(null),
  });
}

// 회의가 열리면 화면 전체로 크게 알립니다. 누르면 닫힙니다.
function meetingAlarm(v) {
  Sound.siren();
  const m = v.meeting || {};
  document.querySelectorAll('.alarm').forEach(x => x.remove());
  const el = document.createElement('div');
  el.className = 'alarm' + (m.trigger === 'report' ? ' body' : '');
  el.innerHTML = `<div class="emoji">${m.trigger === 'report' ? '🚨' : '📢'}</div>
    <div class="big">${m.trigger === 'report' ? '시체 발견!' : '긴급회의!'}</div>
    <p>${m.trigger === 'report' ? `<b>${esc(m.body)}</b> 님이 쓰러져 있었습니다${m.where ? `<br>📍 ${esc(m.where)}` : ''}` : m.trigger === 'emergency' ? `<b>${esc(m.by)}</b> 님이 회의를 요청했습니다` : '진행자가 회의를 소집했습니다'}</p>
    <div class="go">집결 장소<br><b>${esc(m.place)}</b></div>
    <p class="small">화면을 누르면 닫힙니다</p>`;
  el.onclick = () => el.remove();
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 10000);
}

function queuePlay(taskId, result) {
  const q = loadQ().filter(x => x.taskId !== taskId);
  q.push({ taskId, result, at: Date.now() });
  store.set(qKey(), q);
  toast('📶 연결이 끊겨 완료를 저장해 두었어요. 연결되면 자동으로 보냅니다.', '', 4000);
}

function openGame(taskId, game, data, readyAt) {
  S.gameTask = taskId;
  Games.open({ game, data }, async (result) => {
    // 서버가 받는 최소 시간 전이면 잠깐 기다렸다 보냅니다.
    const wait = (readyAt || 0) - serverNow() + 300;
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    if (!S.online) return queuePlay(taskId, result);
    const r = await postJSON('/api/act', { code: S.code, token: S.token, action: 'play', taskId, result });
    if (r.network || r.status >= 500) return queuePlay(taskId, result);
    if (r.view) { syncClock(r.view); const prev = S.view; S.view = r.view; onChange(prev, r.view); render(); }
    if (!r.ok) return toast(r.error, 'bad', 3200);
    if (r.result && r.result.message) toast('✅ ' + r.result.message, 'good', 3000);
  });
}

function openScan() { Scanner.open(S.view && S.view.phase === 'lobby' ? '내 목걸이 이름표 QR' : '장소 QR 또는 쓰러진 사람의 이름표', handleScan); }

// 암살 성공: 마피아 화면만 붉게 한 번 반짝입니다.
function killFlash() {
  const f = document.createElement('div');
  f.className = 'killflash';
  document.body.appendChild(f);
  setTimeout(() => f.remove(), 900);
}

function openKill() {
  const v = S.view, m = v.mafia;
  if (!m.targets.length) return toast('선택할 수 있는 대상이 없습니다.', 'bad');
  openModal(`<h2>🔪 대상 선택</h2>
    <p class="muted small">손이 닿는 거리에서 상대를 직접 보고 있을 때만 실행하세요. 앱은 거리를 확인하지 않습니다.</p>
    ${m.targets.map(t => `<button class="choice" data-act="pick" data-id="${esc(t.id)}" data-name="${esc(t.name)}">${esc(t.name)}</button>`).join('')}
    <button data-act="close" style="margin-top:16px">취소</button>`, {
    pick: async (b) => {
      closeModal();
      const yes = await confirmBox(`${b.dataset.name} 님을 암살합니까?`, '실행하면 되돌릴 수 없습니다.', '암살 실행', true);
      if (!yes) return;
      const r = await act('kill', { target: b.dataset.id });
      if (r) { killFlash(); toast(`${r.targetName} 님을 암살했습니다. 자연스럽게 자리를 떠나세요.`, 'good', 3500); }
    },
  });
}

async function doEmergency() {
  const yes = await confirmBox('긴급회의를 요청합니까?', `이번 판 전체에서 남은 횟수 ${S.view.me.emergencyLeft}회. 모두가 집결 장소로 모입니다.`, '긴급회의 요청', true);
  if (!yes) return;
  const r = await act('emergency');
  if (r) toast('긴급회의를 요청했습니다.', 'good');
}

function openVote(id, name) {
  confirmBox(id === 'skip' ? '건너뛰기에 투표합니까?' : `${name} 님에게 투표합니까?`, '확정하면 바꿀 수 없습니다.', '투표 확정').then(async (yes) => {
    if (!yes) return;
    const r = await act('vote', { target: id });
    if (r) toast('투표를 확정했습니다.', 'good');
  });
}

// ───────────── 화면 그리기 ─────────────
function statusChip(me) {
  if (me.status === 'alive') return '<span class="chip alive">생존</span>';
  if (me.status === 'dead') return '<span class="chip dead">사망</span>';
  return '<span class="chip ghost">유령</span>';
}

function renderBars() {
  const v = S.view;
  const top = $('#topbar'), ban = $('#banners');
  if (!v || !top) return;
  top.innerHTML = `<span class="dot ${S.online ? '' : 'off'}" title="${S.online ? '연결됨' : '연결 끊김'}"></span>
    <span class="who">${esc(v.me.name)}</span>
    <span class="chip">${esc(PHASE_NAME[v.phase] || v.phase)}</span>
    ${v.phase !== 'lobby' && v.phase !== 'briefing' && v.phase !== 'ended' ? statusChip(v.me) : ''}`;
  ban.innerHTML = (!S.online ? '<div class="banner off">연결 끊김 — 재연결 중입니다. 지금은 행동할 수 없습니다.</div>' : '')
    + (v.paused ? '<div class="banner pause">⏸ 일시 정지 — 진행자 안내를 기다리세요</div>' : '');
  document.querySelectorAll('[data-needs-online]').forEach(b => { b.disabled = !S.online || v.paused || b.dataset.off === '1'; });
}

function render() {
  const v = S.view;
  if (!v) return;
  let body = '';
  switch (v.phase) {
    case 'lobby': body = viewLobby(v); break;
    case 'briefing': body = viewBriefing(v); break;
    case 'active': body = v.me.status === 'dead' ? viewDead(v) : viewActive(v); break;
    case 'gathering': case 'discussion': body = viewMeeting(v); break;
    case 'voting': body = viewVoting(v); break;
    case 'result': body = viewResult(v); break;
    case 'ended': body = viewEnded(v); break;
    default: body = '<p>알 수 없는 단계</p>';
  }
  const html = `<div class="topbar" id="topbar"></div><div id="banners"></div><main>${body}</main>`;
  // 다른 사람이 임무를 끝내 진행률만 바뀐 경우에는 진행률 칸만 고칩니다.
  // 화면 전체를 다시 그리면 그 순간 누른 버튼이 사라져 탭이 무시되고 스크롤도 튑니다.
  const PR = /<!--pr-->[\s\S]*?<!--\/pr-->/;
  const key = html.replace(PR, '');
  const prog = document.getElementById('prog');
  if (key === S.lastKey && document.getElementById('topbar')) {
    const m = html.match(PR);
    if (prog && m) prog.innerHTML = m[0];
    renderBars();
    return;
  }
  S.lastKey = key;
  const y = S.lastPhase === v.phase ? window.scrollY : 0; // 단계가 바뀌면 맨 위부터
  S.lastPhase = v.phase;
  app.innerHTML = html;
  renderBars();
  window.scrollTo(0, y);
}

function viewLobby(v) {
  const tag = v.me.tag, readyN = v.roster.filter(r => r.ready).length;
  // 1단계: 이름표 QR 연결 → 2단계: 준비 완료. 이름표를 연결해야 준비할 수 있습니다.
  const step1 = tag
    ? `<div class="card good center"><div class="stepno">1단계 완료</div><h3>내 이름표</h3><div class="big">🏷 ${String(tag).padStart(2, '0')}번</div><p class="small muted">이 번호의 목걸이를 차세요. 다른 번호를 찍으면 바뀝니다.</p></div>`
    : `<div class="card hl center"><div class="stepno">1단계</div><h3>🏷 이름표 연결</h3><p>받은 목걸이 이름표 뒷면의 QR을 찍으세요.</p>
        <button class="primary" data-a="scan" data-needs-online>📷 내 이름표 QR 찍기</button></div>`;
  const step2 = !tag
    ? `<div class="readybox locked"><div class="stepno">2단계</div><div class="rb-main">🔒 준비 완료</div><p>이름표를 연결하면 누를 수 있어요</p></div>`
    : v.me.ready
      ? `<div class="readybox done"><div class="stepno">2단계 완료</div><div class="rb-main">✔ 준비 완료</div><p>진행자가 역할을 배정할 때까지 기다리세요</p>
          <button class="ghostbtn sm" data-a="ready" data-needs-online>준비 취소</button></div>`
      : `<button class="readybox go" data-a="ready" data-needs-online><span class="stepno">2단계</span><span class="rb-main">✋ 준비 완료 누르기</span><span class="rb-sub">이름표를 찼으면 눌러 주세요</span></button>`;
  return `
    <div class="card hl center">
      <div class="phase">방 ${esc(v.code)}에서 기다리는 중</div>
      <div class="big" style="margin:8px 0">${esc(v.me.name)}</div>
    </div>
    ${step1}
    ${step2}
    ${pushCard()}
    <a class="guidebtn" href="/guide?room=${encodeURIComponent(v.code)}">📖 규칙 카드뉴스 보기 <span>기다리는 동안 읽어 보세요</span></a>
    <div class="card">
      <div class="row"><h3 style="margin:0">입장한 사람 ${v.roster.length}명</h3><b class="readycount">준비 ${readyN} / ${v.roster.length}</b></div>
      <ul class="list" style="margin-top:8px">${v.roster.map(r => `<li><span class="name">${esc(r.name)}</span>${r.tag ? `<span class="chip">🏷 ${String(r.tag).padStart(2, '0')}</span>` : '<span class="chip dead">이름표 없음</span>'}${r.ready ? '<span class="pill ready">✔ 준비 완료</span>' : '<span class="pill wait">준비 중</span>'}</li>`).join('')}</ul>
    </div>
    <div class="card">
      <h3>복구 코드</h3>
      <p><span class="kbd" style="font-size:24px">${esc(v.me.recovery)}</span></p>
      <p class="muted small">휴대폰을 바꾸거나 화면이 사라지면 이 코드로 다시 들어옵니다. 다른 사람에게 보여 주지 마세요.</p>
    </div>
    ${rulesCard()}
    <p class="center small"><a href="/practice" target="_blank" style="color:var(--accent)">🎮 기다리는 동안 미니게임 연습하기</a></p>`;
}

function rulesCard() {
  return `<details class="card"><summary style="font-weight:800;cursor:pointer">게임 규칙 보기</summary>
    <ul class="small" style="padding-left:20px">
      <li><b>시민</b>: 장소 QR을 찍어 임무를 하고, 회의에서 마피아를 찾아 추방합니다. 임무를 모두 끝내거나 마피아를 모두 추방하면 승리.</li>
      <li><b>마피아</b>: 위장 임무를 하며 몰래 암살합니다. 살아 있는 마피아 수가 시민 수 이상이 되면 승리.</li>
      <li><b>암살</b>: 손이 닿는 거리에서 상대를 직접 보고 있을 때만. 당한 사람은 이름표를 뒤집어 💀 면이 보이게 하고, 그 자리에 멈춰 말하지 않습니다.</li>
      <li><b>신고</b>: 쓰러진 사람의 이름표 QR을 찍으면 회의가 열립니다. 직접 발견했을 때만 찍으세요.</li>
      <li><b>유령</b>: 회의 후 탈락자는 유령으로 임무만 계속합니다. 말하거나 힌트를 주면 안 됩니다.</li>
    </ul></details>`;
}

function roleBlock(v, compact) {
  const role = v.me.role;
  const shown = S.roleShown;
  const mates = v.mafia ? v.mafia.mates : [];
  return `<div class="rolecard ${shown ? 'shown ' + role : ''}" data-a="toggleRole" ${compact ? 'style="padding:14px"' : ''}>
    ${shown ? `<div class="muted small">나의 역할</div><div class="rname" ${compact ? 'style="font-size:32px"' : ''}>${ROLE_NAME[role]}</div>
      ${role === 'mafia' ? `<p>동료: <b>${mates.length ? mates.map(m => esc(m.name) + (m.out ? ' (탈락)' : '')).join(', ') : '없음'}</b></p>` : ''}
      <p class="small muted">눌러서 숨기기</p>`
    : `<div class="emoji">🂠</div><p style="font-weight:800">눌러서 역할 보기</p><p class="small muted">주변에서 보지 않게 확인하세요</p>`}
  </div>`;
}

function viewBriefing(v) {
  const role = v.me.role;
  return `
    <h1>역할 확인</h1>
    ${roleBlock(v)}
    <div class="card">
      ${role === 'mafia'
        ? `<p><b>마피아 할 일</b></p><ul class="small" style="padding-left:20px"><li>위장 임무를 하며 시민처럼 행동하세요(진행률에는 반영되지 않습니다).</li><li>암살은 <b>손이 닿는 거리에서 직접 보고 있을 때만</b>. 대기시간이 있습니다.</li><li>동료를 감싸 주되 들키지 마세요.</li></ul>`
        : `<p><b>시민 할 일</b></p><ul class="small" style="padding-left:20px"><li>안내되는 장소로 가서 QR을 찍어 임무를 완료하세요.</li><li>쓰러진 사람을 발견하면 이름표 QR로 신고하세요.</li><li>회의에서 수상한 사람을 찾아 투표하세요.</li></ul>`}
    </div>
    ${v.me.ack ? '<div class="card good center">✔ 확인 완료. 진행자가 시작할 때까지 기다리세요.</div>'
      : '<button class="primary" data-a="ack" data-needs-online>역할과 규칙을 확인했습니다</button>'}
    <p class="center muted small" style="margin-top:12px">확인 ${v.roster.filter(r => r.ack).length} / ${v.roster.length}명</p>
    ${pushCard()}`;
}

function taskCard(v) {
  const t = v.me.task;
  if (!t) return `<div class="card good center"><div class="emoji">🎉</div><h2>내 임무를 모두 끝냈습니다</h2><p class="muted small">다른 사람을 도우며 수상한 행동을 지켜보세요.</p></div>`;
  let how = '';
  if (t.type === 'visit') how = `<b>${esc(t.loc)}</b>에 가서 장소 QR을 찍으세요.`;
  if (t.type === 'carry') how = t.step === 0
    ? `<b>${esc(t.loc)}</b>에서 QR을 찍고 물품 하나를 집으세요. 도착지: <b>${esc(t.loc2)}</b>`
    : `물품을 들고 <b>${esc(t.loc2)}</b>로 가서 상자에 넣고 QR을 찍으세요.`;
  if (t.type === 'report') how = t.step === 1 && t.options
    ? `<b>${esc(t.question)}</b>`
    : `<b>${esc(t.loc)}</b>에 가서 QR을 찍고 표지를 확인하세요.`;
  if (t.type === 'game') how = `<b>${esc(t.loc)}</b>에 가서 QR을 찍으세요.`;
  const label = t.title ? esc(t.title) : t.type === 'game' ? esc(t.gameName) : { visit: '방문 점검', carry: '물품 운반', report: '현장 보고' }[t.type];
  return `<div class="card hl">
    <div class="row"><h3 style="margin:0">${label} <span class="muted">(임무 ${t.index}/${t.total})</span></h3></div>
    <p style="font-size:20px;margin-top:8px">📍 ${how}</p>
    ${t.desc ? `<p class="small" style="color:var(--accent)">${esc(t.desc)}</p>` : ''}
    ${t.type === 'report' && t.step === 1 && t.options ? t.options.map(o => `<button class="choice" data-a="answer" data-task="${esc(t.id)}" data-opt="${esc(o)}" data-needs-online>${esc(o)}</button>`).join('') : ''}
    ${t.type === 'carry' && t.step === 1 ? '<p class="small muted">출발지 확인 완료 ✔</p>' : ''}
    ${t.type === 'game' && t.challenge ? '<button class="primary" data-a="resumeGame" data-needs-online style="margin-top:10px">▶ 이어서 하기</button>' : ''}
  </div>`;
}

function viewActive(v) {
  const me = v.me, pr = v.progress;
  const ghost = me.status === 'ghost';
  const emLeft = serverNow() < v.emergencyReadyAt;
  // 비밀 메뉴는 살아 있는 모두에게 똑같이 보입니다. 닫힌 상태로는 마피아인지 알 수 없고,
  // 시민이 열면 위장용 기지 상태 화면이 나옵니다.
  const secretInner = !S.secretOpen ? '' : v.mafia ? `
        <p class="small" style="margin-top:10px">동료: <b>${v.mafia.mates.map(m => esc(m.name) + (m.out ? ' (탈락)' : '')).join(', ') || '없음'}</b></p>
        ${(() => {
          const ready = v.mafia.killReadyAt <= serverNow() && !v.paused;
          return `<button class="danger" data-a="kill" data-needs-online ${ready ? '' : 'data-off="1"'} style="margin-top:8px">${ready ? '🔪 암살하기' : `🔪 암살 대기 <span data-until="${v.mafia.killReadyAt}" ${v.paused ? `data-frozen="${v.mafia.killRemainMs}"` : ''} data-unit="kr" data-done="rerender"></span>`}</button>`;
        })()}`
    : `<p class="small" style="margin-top:10px">🛰 기지 상태: <b style="color:var(--good)">정상</b></p>
        <button class="danger" data-a="scanArea" style="margin-top:8px">🔦 주변 살피기</button>`;
  const secretPanel = me.status === 'alive' ? `
    <div class="card">
      <button class="ghostbtn sm" data-a="toggleSecret" style="width:100%">${S.secretOpen ? '비밀 메뉴 닫기' : '비밀 메뉴 열기'}</button>
      ${secretInner}
    </div>` : '';
  return `
    ${ghost ? '<div class="card" style="border-color:#34407a;background:#141a33"><b>👻 유령 상태</b><p class="small muted">말하거나 힌트를 주지 마세요. 임무는 계속 진행률에 반영됩니다(시민).</p></div>' : ''}
    ${taskCard(v)}
    <div class="card" id="prog"><!--pr-->
      <div class="row"><h3 style="margin:0">공동 임무 진행률</h3><b style="flex:0">${pr.pct}%</b></div>
      <div class="progress" style="margin-top:8px"><div style="width:${Math.min(100, pr.pct)}%"></div></div>
      <p class="small muted">목표 ${pr.goal}% 달성 시 시민 승리</p>
    <!--/pr--></div>
    ${secretPanel}
    ${roleBlock(v, true)}
    ${!ghost ? `<div class="card">
      <button class="ghostbtn" data-a="emergency" data-needs-online ${me.emergencyLeft <= 0 || emLeft ? 'data-off="1"' : ''}>
        📢 긴급회의 ${me.emergencyLeft <= 0 ? '(모두 사용됨)' : emLeft ? `<span data-until="${v.emergencyReadyAt}" data-unit="kr" data-suffix=" 후 가능" data-done="rerender"></span>` : `(전체 남은 ${me.emergencyLeft}회)`}
      </button></div>` : ''}
    <div class="dock"><div class="inner"><button class="primary" data-a="scan" data-needs-online>📷 QR 스캔 / 코드 입력</button></div></div>`;
}

function viewDead() {
  return `<div class="fullscreen deadscreen">
    <div class="emoji">💀</div>
    <div class="big">당신은 쓰러졌습니다</div>
    <div class="card danger" style="text-align:left">
      <p>• <b>지금부터 말하지 마세요.</b></p>
      <p>• 이름표를 뒤집어 <b>💀 사망 면(QR)</b>이 보이게 하고, 이 자리에서 발견될 때까지 기다리세요.</p>
      <p>• 다른 곳에서 회의가 열리면 집결 장소로 이동하세요.</p>
      <p>• 회의가 끝나면 유령으로 임무를 이어 갑니다.</p>
    </div>
  </div>`;
}

function meetingHead(v) {
  const m = v.meeting || {};
  const why = m.trigger === 'report' ? `🚨 <b>${esc(m.by)}</b> 님이 <b>${esc(m.body)}</b> 님을 발견해 신고했습니다.${m.where ? `<br>📍 발견 장소: <b>${esc(m.where)}</b>` : ''}`
    : m.trigger === 'emergency' ? `📢 <b>${esc(m.by)}</b> 님이 긴급회의를 요청했습니다.`
    : '📢 진행자가 회의를 소집했습니다.';
  return `<p>${why}</p>
    <div class="card danger"><h3>이번 회의에서 확인된 탈락자</h3>
    ${m.revealed && m.revealed.length ? `<p class="big" style="font-size:24px">${m.revealed.map(esc).join(', ')}</p>` : '<p>새로 확인된 사망자가 없습니다.</p>'}</div>`;
}

function rosterCard(v) {
  return `<div class="card"><h3>참가자</h3><ul class="list">${v.roster.map(r => `<li class="${r.pub !== 'in' ? 'out' : ''}"><span class="name">${esc(r.name)}</span>${r.pub === 'dead' ? '<span class="chip dead">사망</span>' : r.pub === 'ejected' ? '<span class="chip dead">추방</span>' : ''}</li>`).join('')}</ul></div>`;
}

function viewMeeting(v) {
  const m = v.meeting || {};
  const ghostNote = v.me.status !== 'alive' ? '<div class="card" style="border-color:#34407a"><b>👻 탈락자는 회의에서 말할 수 없습니다.</b><p class="small muted">조용히 함께 있어 주세요.</p></div>' : '';
  if (v.phase === 'gathering') {
    return `<div class="meetingscreen center">
      <div class="emoji">🔔</div><div class="big">회의 소집!</div>
      <p style="font-size:22px;margin-top:10px">집결 장소: <b style="color:var(--accent)">${esc(m.place)}</b></p>
      ${v.phaseEndsAt ? `<p class="small" style="margin-top:10px">토론 시작까지</p><div class="timer" data-until="${v.phaseEndsAt}" ${v.paused ? `data-frozen="${v.remainMs}"` : ''}></div>` : ''}
    </div>
    ${meetingHead(v)}${ghostNote}
    <p class="center muted">${v.phaseEndsAt ? '시간이 되면 토론이 시작됩니다. 서둘러 모이세요!' : '모두 모이면 진행자가 토론을 시작합니다.'}</p>
    ${rosterCard(v)}`;
  }
  return `<div class="phase center">토론</div>
    <div class="timer" data-until="${v.phaseEndsAt}" ${v.paused ? `data-frozen="${v.remainMs}"` : ''}></div>
    ${meetingHead(v)}${ghostNote}${rosterCard(v)}`;
}

function viewVoting(v) {
  const vt = v.vote || {};
  let inner;
  if (!vt.eligible) inner = '<div class="card center"><b>투표권이 없습니다.</b><p class="muted small">결과를 기다리세요.</p></div>';
  else if (vt.cast) inner = `<div class="card good center"><div class="emoji">🗳️</div><h2>투표 완료</h2><p>선택: <b>${esc(vt.cast)}</b></p><p class="muted small">다른 사람의 선택은 마감 후 득표수만 공개됩니다.</p></div>`;
  else inner = `<div class="card"><h3>누구를 추방할까요?</h3>
      ${vt.candidates.map(c => `<button class="choice" data-a="vote" data-id="${esc(c.id)}" data-name="${esc(c.name)}" data-needs-online>${esc(c.name)}${c.id === v.me.id ? ' (나)' : ''}</button>`).join('')}
      <button class="choice" data-a="vote" data-id="skip" data-name="건너뛰기" data-needs-online style="margin-top:16px;border-style:dashed">⏭ 건너뛰기</button></div>`;
  return `<div class="phase center">투표</div>
    <div class="timer" data-until="${v.phaseEndsAt}" ${v.paused ? `data-frozen="${v.remainMs}"` : ''}></div>${inner}`;
}

function viewResult(v) {
  const r = v.lastResult || {};
  return `<div class="meetingscreen center">
      <div class="emoji">${r.ejected ? '🚪' : '🤝'}</div>
      <div class="big">${esc(r.why || '')}</div>
      ${r.ejected && r.ejectedRole ? `<p style="font-size:22px">${esc(r.ejected)} 님은 <b>${ROLE_NAME[r.ejectedRole]}</b>였습니다.</p>` : ''}
    </div>
    <div class="card"><h3>득표 결과</h3><ul class="list">
      ${(r.tally || []).map(t => `<li><span class="name">${esc(t.name)}</span><b>${t.count}표</b></li>`).join('') || '<li><span class="name muted">득표 없음</span></li>'}
      <li><span class="name">⏭ 건너뛰기</span><b>${r.skip || 0}표</b></li>
      <li><span class="name muted">미투표</span><span class="muted">${r.noVote || 0}명</span></li>
    </ul></div>
    <p class="center muted">진행자가 활동을 재개하면 다시 흩어집니다.</p>`;
}

function viewEnded(v) {
  const e = v.end || {};
  const title = e.winner === 'citizen' ? '🎉 시민 승리' : e.winner === 'mafia' ? '🔪 마피아 승리' : '⏹ 진행자 종료';
  const mine = e.winner === v.me.role;
  return `<div class="fullscreen" style="min-height:auto;padding:20px 0">
      <div class="big" style="font-size:40px">${title}</div>
      <p style="font-size:20px">${esc(e.reason)}</p>
      ${e.winner !== 'host' ? `<p class="chip ${mine ? 'alive' : 'dead'}" style="align-self:center;font-size:18px">${mine ? '우리 팀 승리!' : '아쉽게 패배'}</p>` : ''}
    </div>
    <div class="card"><h3>전체 역할 공개</h3><ul class="list">
      ${e.roles.map(r => `<li class="${r.status !== 'alive' ? 'out' : ''}"><span class="name">${esc(r.name)}</span><span class="chip ${r.role}">${ROLE_NAME[r.role] || '-'}</span></li>`).join('')}
    </ul></div>
    <p class="center muted small">진행자가 새 게임을 열면 자동으로 대기 화면으로 바뀝니다.</p>`;
}

// ───────────── 이벤트 ─────────────
app.addEventListener('click', (e) => {
  const b = e.target.closest('[data-a]');
  if (!b || b.disabled) return;
  const v = S.view, a = b.dataset.a;
  if (a === 'toggleRole') { S.roleShown = !S.roleShown; return render(); }
  if (a === 'toggleSecret') { S.secretOpen = !S.secretOpen; return render(); }
  if (a === 'ready') return act('ready', { ready: !v.me.ready });
  if (a === 'push') {
    return Push.subscribe(S.code, S.token, true).then(st => {
      S.push = st; render();
      toast(st === 'granted' ? '🔔 회의 알림을 켰습니다' : st === 'denied' ? '알림이 차단되었습니다' : '알림을 켜지 못했습니다', st === 'granted' ? 'good' : 'bad');
    }).catch(() => toast('알림을 켜지 못했습니다', 'bad'));
  }
  if (a === 'ack') return act('ack');
  if (a === 'scan') return openScan();
  if (a === 'kill') return openKill();
  if (a === 'scanArea') return toast('🔦 주변에 이상한 점이 없습니다.', '', 2500);
  if (a === 'emergency') return doEmergency();
  if (a === 'vote') return openVote(b.dataset.id, b.dataset.name);
  if (a === 'resumeGame') { const t = v.me.task; return openGame(t.id, t.game, t.challenge, t.readyAt); }
  if (a === 'answer') return act('answer', { taskId: b.dataset.task, option: b.dataset.opt }).then(r => { if (r && r.message) toast('✅ ' + r.message, 'good', 3000); });
});
window.addEventListener('rerender', () => render());
// 대기시간이 끝나는 순간 버튼을 다시 활성화하기 위해 1초마다 확인
setInterval(() => {
  const v = S.view;
  if (!v || v.phase !== 'active' || document.querySelector('.modal')) return;
  const killBtn = document.querySelector('[data-a="kill"][data-off="1"]');
  if (killBtn && v.mafia && v.mafia.killReadyAt <= serverNow() && !v.paused) render();
}, 1000);

// ───────────── 시작 ─────────────
if (S.code && S.token) connect();
else {
  if (S.pendingScan) S.notice = '먼저 진행자가 보여 주는 입장 QR로 방에 들어온 뒤, 이 QR을 다시 찍으세요.';
  S.pendingScan = null;
  renderHome();
}

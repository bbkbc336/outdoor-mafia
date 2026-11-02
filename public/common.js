// 참가자·진행자 화면 공용 도구
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* 저장 불가 환경 */ } },
  del(k) { try { localStorage.removeItem(k); } catch (_) { /* 무시 */ } },
};

async function postJSON(path, body) {
  let r;
  try {
    r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
  } catch (_) {
    return { ok: false, error: '서버에 연결할 수 없습니다. 인터넷 연결을 확인하세요.', network: true };
  }
  let data = {};
  try { data = await r.json(); } catch (_) { /* 무시 */ }
  if (!r.ok) return { ok: false, status: r.status, error: data.error || '요청이 실패했습니다.', view: data.view };
  return { ok: true, ...data };
}

// 서버 시각 기준 타이머
let clockOffset = 0;
const serverNow = () => Date.now() + clockOffset;
function syncClock(view) { if (view && view.serverNow) clockOffset = view.serverNow - Date.now(); }
function fmtSec(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s}`;
}
// 한국어 단위 표시: 1분 30초, 45초
function fmtKr(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}분${s % 60 ? ' ' + (s % 60) + '초' : ''}` : `${s}초`;
}
// data-until="서버시각ms" 요소를 매 0.25초 갱신. data-frozen="ms"면 고정 표시.
setInterval(() => {
  document.querySelectorAll('[data-until]').forEach(el => {
    const frozen = el.getAttribute('data-frozen');
    const left = frozen !== null && frozen !== '' ? Number(frozen) : Number(el.dataset.until) - serverNow();
    el.textContent = (el.dataset.prefix || '') + (el.dataset.unit === 'kr' ? fmtKr(left) : fmtSec(left)) + (el.dataset.suffix || '');
    if (el.classList.contains('timer')) el.classList.toggle('urgent', left <= 10000);
    const onDone = el.dataset.done;
    if (left <= 0 && onDone && !el.dataset.fired) { el.dataset.fired = '1'; window.dispatchEvent(new Event(onDone)); }
  });
}, 250);

// 화면을 한 번도 누르지 않은 상태(QR 주소로 막 열림)에서는 브라우저가 진동을 막으므로 시도하지 않습니다.
function buzz(p) {
  if (!navigator.vibrate || (navigator.userActivation && !navigator.userActivation.hasBeenActive)) return;
  try { navigator.vibrate(p); } catch (_) { /* 무시 */ }
}
function toast(msg, kind = '', ms = 2600) {
  document.querySelectorAll('.toast').forEach(x => x.remove());
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  document.body.appendChild(t);
  if (kind) buzz(kind === 'bad' ? [80, 60, 80] : 60);
  setTimeout(() => t.remove(), ms);
}

// 하단 시트 모달. html 안의 [data-act] 버튼에 handlers를 연결합니다.
function openModal(html, handlers = {}, id = 'modal') {
  closeModal(id);
  const m = document.createElement('div');
  m.className = 'modal'; m.id = id;
  m.innerHTML = `<div class="sheet">${html}</div>`;
  m.addEventListener('click', (e) => {
    if (e.target === m) return closeModal(id);
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const fn = handlers[b.dataset.act];
    if (b.dataset.act === 'close') return closeModal(id);
    if (fn) fn(b, m);
  });
  document.body.appendChild(m);
  return m;
}
function closeModal(id = 'modal') { const m = document.getElementById(id); if (m) m.remove(); }
function confirmBox(title, body, okLabel = '확인', danger = false) {
  return new Promise((resolve) => {
    openModal(`<h2>${esc(title)}</h2>${body ? `<p class="muted">${body}</p>` : ''}<div class="btns" style="margin-top:16px">
      <button class="${danger ? 'danger' : 'primary'}" data-act="ok">${esc(okLabel)}</button>
      <button data-act="no">취소</button></div>`, {
      ok: () => { closeModal('confirm'); resolve(true); },
      no: () => { closeModal('confirm'); resolve(false); },
    }, 'confirm');
    const m = document.getElementById('confirm');
    m.addEventListener('click', (e) => { if (e.target === m) resolve(false); });
  });
}

// 상태 받기.
//  1) WebSocket(Cloudflare 서버): 연결해 두면 방이 바뀔 때만 서버가 보내 줍니다. 끊기면 다시 붙습니다.
//  2) 묻기(폴링, Vercel·로컬 서버): WebSocket을 지원하지 않는 서버면 자동으로 이 방식으로 바꿉니다.
//     화면이 켜져 있으면 2.5초마다 묻고, 바뀐 게 없으면 서버가 짧게 답합니다.
// 화면 잠금·앱 전환 후 돌아오면 즉시 다시 묻거나 다시 연결합니다.
function connectStream(code, token, { onState, onDenied, onKicked, onStatus, host = false }) {
  const EVERY = 2500, HIDDEN = 20000;
  let closed = false, timer = null, inflight = false, rev = null, got = false, n = 0, last = null;
  let mode = typeof WebSocket === 'function' ? 'ws' : 'poll', ws = null, wsOpened = false, wsFails = 0, pinger = null;
  // 화면 다시 그리기 모으기: 새 상태가 잇달아 오면 최대 0.3초에 한 번만 넘기고
  // 손가락이 화면에 닿아 있는 동안은 미뤘다가(최대 3초) 뗀 뒤에 그립니다. 누르던 버튼이 바뀌어 눌림이 사라지지 않게 합니다.
  let pending = null, pendingAt = 0, flushTimer = null, lastFlush = 0, touching = false;
  const flush = () => {
    flushTimer = null;
    if (!pending || closed) return;
    if (touching && Date.now() - pendingAt < 3000) { flushTimer = setTimeout(flush, 150); return; }
    const v = pending; pending = null; lastFlush = Date.now();
    onState(v);
  };
  const down = () => { touching = true; }, up = () => { touching = false; };
  document.addEventListener('pointerdown', down, true);
  document.addEventListener('pointerup', up, true);
  document.addEventListener('pointercancel', up, true);
  const deliver = (r) => {
    onStatus(true); got = true; syncClock(r); rev = r.rev;
    if (r.view) {
      // 같은 내용이 다시 오면 넘기지 않습니다(방 전체 버전·서버 시각만 바뀐 경우 포함).
      const s = JSON.stringify({ ...r.view, serverNow: 0, version: 0, remainMs: 0 });
      if (s === last) return;
      last = s;
      if (!pending) pendingAt = Date.now();
      pending = r.view;
      if (!flushTimer) flushTimer = setTimeout(flush, Math.max(0, 300 - (Date.now() - lastFlush)));
    }
  };
  const stop = (fn, msg) => { closed = true; clearTimeout(timer); clearTimeout(flushTimer); clearInterval(pinger); try { ws && ws.close(); } catch (_) { /* 무시 */ } fn(msg); };

  // ── WebSocket
  function openWs() {
    if (closed) return;
    clearTimeout(timer);
    const url = location.origin.replace(/^http/, 'ws') + `/api/ws?code=${encodeURIComponent(code)}&token=${encodeURIComponent(token)}`;
    let opened = false;
    try { ws = new WebSocket(url); } catch (_) { return toPoll(); }
    let lastMsg = Date.now();
    ws.onopen = () => {
      opened = true; wsOpened = true; wsFails = 0; lastMsg = Date.now(); clearInterval(pinger);
      // 25초마다 확인 신호. 60초 넘게 서버 답이 없으면(전파가 끊겼는데 연결이 살아 보이는 경우) 끊고 다시 붙습니다.
      pinger = setInterval(() => {
        if (Date.now() - lastMsg > 60000) { try { ws.close(); } catch (_) { /* 무시 */ } return; }
        try { ws.send('ping'); } catch (_) { /* 무시 */ }
      }, 25000);
    };
    ws.onmessage = (e) => {
      lastMsg = Date.now();
      if (e.data === 'pong') return;
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m.type === 'state') deliver(m);
      else if (m.type === 'denied') stop(got ? onKicked : onDenied, m.error);
      else if (m.type === 'kicked') stop(onKicked, m.error);
    };
    ws.onclose = () => {
      clearInterval(pinger);
      if (closed) return;
      // 한 번도 열린 적 없는 서버 = WebSocket 미지원 → 묻기로 전환
      if (!wsOpened) return toPoll();
      onStatus(false);
      wsFails++;
      // 연달아 여러 번 끊기면(네트워크가 WebSocket을 막는 경우) 묻기로 전환
      if (wsFails >= 5) return toPoll();
      timer = setTimeout(openWs, Math.min(8000, 500 * 2 ** wsFails));
    };
    ws.onerror = () => { /* onclose에서 처리 */ };
  }
  function toPoll() { mode = 'poll'; ws = null; poll(); }

  // ── 묻기(폴링)
  const schedule = () => { clearTimeout(timer); if (!closed) timer = setTimeout(poll, document.visibilityState === 'visible' ? EVERY : HIDDEN); };
  async function poll() {
    if (closed || inflight) return;
    inflight = true; clearTimeout(timer);
    const r = await postJSON('/api/state', { code, token, rev, host, beat: n++ % 4 === 0 });
    inflight = false;
    if (closed) return;
    if (r.ok) deliver(r);
    else if (r.network || r.status >= 500) onStatus(false);
    else return stop(got ? onKicked : onDenied, r.error);
    schedule();
  }

  // WebSocket을 지원하는 서버(Cloudflare)인지 한 번 물어보고 시작합니다. 아니면 처음부터 묻기 방식.
  if (mode === 'ws') {
    fetch('/api/ping', { cache: 'no-store' }).then(r => r.json()).then(j => { if (!closed) { if (j && j.ws) openWs(); else toPoll(); } })
      .catch(() => { if (!closed) toPoll(); });
  } else poll();
  const vis = () => {
    if (document.visibilityState !== 'visible' || closed) return;
    if (mode === 'poll') return poll();
    // 화면을 다시 켰을 때 연결이 끊겨 있으면 바로 다시 붙습니다.
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) { wsFails = 0; openWs(); }
  };
  document.addEventListener('visibilitychange', vis);
  window.addEventListener('online', vis);
  window.addEventListener('pageshow', (e) => { if (e.persisted) vis(); });
  return { close() {
    closed = true; clearTimeout(timer); clearTimeout(flushTimer); clearInterval(pinger);
    try { ws && ws.close(); } catch (_) { /* 무시 */ }
    document.removeEventListener('visibilitychange', vis);
    document.removeEventListener('pointerdown', down, true); document.removeEventListener('pointerup', up, true); document.removeEventListener('pointercancel', up, true);
  } };
}

const PHASE_NAME = {
  lobby: '대기', briefing: '역할 확인', active: '활동', gathering: '회의 집결',
  discussion: '토론', voting: '투표', result: '투표 결과', ended: '게임 종료',
};
const ROLE_NAME = { mafia: '마피아', citizen: '시민' };
const GAME_NAME = {
  fire: '🔥 화재 진압', power: '🔌 전원 복구', lock: '🔐 문 잠금 해제', order: '🔢 순서 점검',
  lens: '🧽 렌즈 닦기', sort: '📦 화물 분류', level: '⚡ 출력 조정', shape: '🧩 부품 끼우기',
  mole: '🐭 해충 퇴치', cards: '🃏 카드 짝 맞추기',
};

// 탭 보정: 손가락으로 버튼을 짧게 눌렀는데 브라우저가 click을 만들지 않는 경우가 있습니다
// (끌기 미니게임 직후 등). 0.4초 안에 click이 오지 않으면 대신 눌러 줍니다. 미니게임 화면은 제외.
(() => {
  let down = null;
  document.addEventListener('pointerdown', (e) => {
    down = null;
    if (e.pointerType !== 'touch' || !e.target.closest) return;
    const el = e.target.closest('button, a, [data-a], [data-run], [data-tab], [data-act]');
    if (!el || el.closest('.game')) return;
    down = { el, x: e.clientX, y: e.clientY, t: Date.now() };
  }, true);
  document.addEventListener('pointerup', (e) => {
    const d = down; down = null;
    if (!d || e.pointerType !== 'touch' || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 12 || Date.now() - d.t > 800) return;
    let clicked = false;
    const seen = () => { clicked = true; };
    d.el.addEventListener('click', seen, { capture: true, once: true });
    setTimeout(() => {
      d.el.removeEventListener('click', seen, true);
      if (!clicked && d.el.isConnected && !d.el.disabled) { synth = { el: d.el, t: Date.now() }; d.el.click(); }
    }, 400);
  }, true);
  // 대신 누른 뒤 진짜 click이 늦게 도착하면(느린 휴대폰) 두 번 눌리지 않게 버립니다.
  let synth = null;
  document.addEventListener('click', (e) => {
    if (!e.isTrusted || !synth) return;
    const hit = e.target.closest && e.target.closest('button, a, [data-a], [data-run], [data-tab], [data-act]') === synth.el && Date.now() - synth.t < 1000;
    if (hit) { e.preventDefault(); e.stopImmediatePropagation(); }
    synth = null;
  }, true);
})();

// ───── 소리: 회의 사이렌 ─────
// 브라우저는 사용자가 한 번 터치한 뒤에만 소리를 허용하므로, 첫 터치 때 소리 장치를 켜 둡니다.
const Sound = (() => {
  let ctx = null;
  const unlock = () => {
    try {
      if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) ctx = new AC(); }
      if (ctx && ctx.state === 'suspended') ctx.resume();
    } catch (_) { /* 소리 미지원 */ }
  };
  document.addEventListener('pointerdown', unlock, true);
  document.addEventListener('keydown', unlock, true);
  // 높낮이가 오르내리는 사이렌 3번 (약 2.4초)
  function siren() {
    if (!ctx || ctx.state !== 'running') return false;
    const t0 = ctx.currentTime, osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = 'sawtooth';
    for (let i = 0; i < 3; i++) {
      osc.frequency.setValueAtTime(620, t0 + i * 0.8);
      osc.frequency.linearRampToValueAtTime(1250, t0 + i * 0.8 + 0.4);
      osc.frequency.linearRampToValueAtTime(620, t0 + i * 0.8 + 0.8);
    }
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.22, t0 + 0.05);
    gain.gain.setValueAtTime(0.22, t0 + 2.3);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.45);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0); osc.stop(t0 + 2.5);
    return true;
  }
  // 짧은 알림음 (단계가 바뀔 때)
  function chime() {
    if (!ctx || ctx.state !== 'running') return;
    const t0 = ctx.currentTime;
    [880, 1320].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f; g.gain.setValueAtTime(0.0001, t0 + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.18, t0 + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.18 + 0.3);
      o.connect(g).connect(ctx.destination); o.start(t0 + i * 0.18); o.stop(t0 + i * 0.18 + 0.32);
    });
  }
  return { unlock, siren, chime, ready: () => !!ctx && ctx.state === 'running' };
})();

// ───── 화면 켜 두기 (Wake Lock) ─────
// 화면이 꺼지면 실시간 연결이 끊겨 회의 알림을 놓치므로, 게임 중에는 화면을 켜 둡니다. 지원하지 않는 휴대폰은 그냥 넘어갑니다.
const Awake = (() => {
  let want = false, lock = null;
  async function sync() {
    try {
      if (want && document.visibilityState === 'visible' && !lock && navigator.wakeLock) {
        lock = await navigator.wakeLock.request('screen');
        lock.addEventListener('release', () => { lock = null; });
      } else if (!want && lock) { await lock.release(); lock = null; }
    } catch (_) { lock = null; }
  }
  document.addEventListener('visibilitychange', sync);
  return { set(v) { if (want !== !!v) { want = !!v; sync(); } } };
})();

// ───── 화면 저장(서비스 워커) ─────
// 앱 화면과 파일을 휴대폰에 저장해 두어 전파가 약해도 화면이 열리고, 회의 알림(푸시)을 받습니다.
const SW = (() => {
  const ok = 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1');
  const reg = ok ? navigator.serviceWorker.register('/sw.js').catch(() => null) : Promise.resolve(null);
  return { reg };
})();

// ───── 회의 알림(웹 푸시) 구독 ─────
const Push = (() => {
  const supported = () => 'PushManager' in window && 'Notification' in window && 'serviceWorker' in navigator;
  // 아이폰·아이패드는 홈 화면에 추가한 앱으로 열었을 때만 알림을 받을 수 있습니다.
  const iosNeedsInstall = () => /iP(hone|ad|od)/.test(navigator.userAgent) && !(window.navigator.standalone || matchMedia('(display-mode: standalone)').matches);
  let serverOk = null;
  async function serverSupports() {
    if (serverOk !== null) return serverOk;
    try { const j = await (await fetch('/api/ping', { cache: 'no-store' })).json(); serverOk = !!(j && j.push); } catch (_) { serverOk = false; }
    return serverOk;
  }
  const b64ToBytes = (s) => { const p = '='.repeat((4 - s.length % 4) % 4); const raw = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, c => c.charCodeAt(0)); };
  // 구독하고 서버에 등록. 권한을 묻는 창은 버튼을 누를 때만 띄울 수 있습니다.
  async function subscribe(code, token, ask) {
    if (!supported() || !(await serverSupports())) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    if (Notification.permission !== 'granted') {
      if (!ask) return 'default';
      const p = await Notification.requestPermission();
      if (p !== 'granted') return p;
    }
    const reg = await SW.reg;
    if (!reg) return 'unsupported';
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { key } = await (await fetch('/api/push-key', { cache: 'no-store' })).json();
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
    }
    const r = await postJSON('/api/push', { code, token, sub: sub.toJSON() });
    return r.ok ? 'granted' : 'error';
  }
  return { supported, iosNeedsInstall, serverSupports, subscribe, permission: () => ('Notification' in window ? Notification.permission : 'unsupported') };
})();

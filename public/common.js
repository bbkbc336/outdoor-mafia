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

function toast(msg, kind = '', ms = 2600) {
  document.querySelectorAll('.toast').forEach(x => x.remove());
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  document.body.appendChild(t);
  if (navigator.vibrate && kind) { try { navigator.vibrate(kind === 'bad' ? [80, 60, 80] : 60); } catch (_) { /* 무시 */ } }
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

// 상태 받기 (폴링). 화면이 켜져 있으면 2.5초마다 묻고, 바뀐 게 없으면 서버가 짧게 답합니다.
// 화면 잠금·앱 전환 후 돌아오면 즉시 다시 묻습니다.
function connectStream(code, token, { onState, onDenied, onKicked, onStatus, host = false }) {
  const EVERY = 2500, HIDDEN = 20000;
  let closed = false, timer = null, inflight = false, rev = null, got = false, n = 0, last = null;
  const schedule = () => { clearTimeout(timer); if (!closed) timer = setTimeout(poll, document.visibilityState === 'visible' ? EVERY : HIDDEN); };
  async function poll() {
    if (closed || inflight) return;
    inflight = true; clearTimeout(timer);
    const r = await postJSON('/api/state', { code, token, rev, host, beat: n++ % 4 === 0 });
    inflight = false;
    if (closed) return;
    if (r.ok) {
      onStatus(true); got = true; syncClock(r); rev = r.rev;
      if (r.view) {
        // 같은 내용이 다시 오면 화면을 다시 그리지 않습니다(펼친 메뉴·입력 유지).
        const s = JSON.stringify({ ...r.view, serverNow: 0 });
        if (s !== last) { last = s; onState(r.view); }
      }
    } else if (r.network || r.status >= 500) {
      onStatus(false);
    } else {
      closed = true;
      return got ? onKicked(r.error) : onDenied(r.error);
    }
    schedule();
  }
  poll();
  const vis = () => { if (document.visibilityState === 'visible' && !closed) poll(); };
  document.addEventListener('visibilitychange', vis);
  window.addEventListener('online', vis);
  window.addEventListener('pageshow', (e) => { if (e.persisted) vis(); });
  return { close() { closed = true; clearTimeout(timer); document.removeEventListener('visibilitychange', vis); } };
}

const PHASE_NAME = {
  lobby: '대기', briefing: '역할 확인', active: '활동', gathering: '회의 집결',
  discussion: '토론', voting: '투표', result: '투표 결과', ended: '게임 종료',
};
const ROLE_NAME = { mafia: '마피아', citizen: '시민' };
const GAME_NAME = {
  fire: '🔥 화재 진압', power: '🔌 전원 복구', lock: '🔐 문 잠금 해제', order: '🔢 순서 점검',
  lens: '🧽 렌즈 닦기', sort: '📦 화물 분류', level: '⚡ 출력 조정', shape: '🧩 부품 끼우기',
};

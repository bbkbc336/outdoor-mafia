// 진행자용 큰 화면 (TV·노트북·빔프로젝터). 모두가 보는 화면이므로 공개해도 되는 정보만 보여 줍니다.
// 역할, 아직 발견되지 않은 사망자, 개인 투표 내용은 절대 표시하지 않습니다. 단계가 바뀌면 소리와 음성으로 안내합니다.
'use strict';

const qs = new URLSearchParams(location.search);
// 다른 기기(TV 등)에서 열 때는 진행자 화면이 만들어 준 주소의 key로 들어옵니다.
if (qs.get('code') && qs.get('key')) {
  store.set('mafia:host:' + qs.get('code').toUpperCase(), qs.get('key'));
  history.replaceState(null, '', '/screen?room=' + qs.get('code').toUpperCase());
}
const SC = { code: (qs.get('room') || qs.get('code') || store.get('mafia:hostlast') || '').toUpperCase(), view: null, voice: true };
SC.token = store.get('mafia:host:' + SC.code);
const root = document.getElementById('app');
const pad = (n) => String(n).padStart(2, '0');

function say(text) {
  if (!SC.voice || !('speechSynthesis' in window)) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ko-KR'; u.rate = 1;
    speechSynthesis.speak(u);
  } catch (_) { /* 음성 미지원 */ }
}

// 단계가 바뀔 때 소리·음성 안내
function announce(prev, v) {
  if (prev && prev.phase === v.phase && prev.paused === v.paused) return;
  if (prev && prev.paused !== v.paused) return say(v.paused ? '일시 정지되었습니다.' : '다시 시작합니다.');
  const m = v.meeting || {};
  if (v.phase === 'gathering') {
    Sound.siren();
    const why = m.trigger === 'report' ? `${m.by} 님이 쓰러진 ${m.body} 님을 발견했습니다.` : m.trigger === 'emergency' ? `${m.by} 님이 긴급회의를 요청했습니다.` : '';
    setTimeout(() => say(`회의가 소집되었습니다. ${why} 모두 ${m.place}로 모여 주세요.`), 2400);
    return;
  }
  Sound.chime();
  if (v.phase === 'briefing') say('역할이 배정되었습니다. 각자 몰래 역할을 확인하세요.');
  else if (v.phase === 'active') say(prev && prev.phase === 'result' ? '활동을 다시 시작합니다. 흩어지세요.' : '게임을 시작합니다.');
  else if (v.phase === 'discussion') say('토론을 시작합니다.');
  else if (v.phase === 'voting') say('투표를 시작합니다. 휴대폰에서 투표하세요.');
  else if (v.phase === 'result' && v.lastResult) say(v.lastResult.why || '투표가 끝났습니다.');
  else if (v.phase === 'ended' && v.end) say(v.end.winner === 'citizen' ? '시민 승리입니다!' : v.end.winner === 'mafia' ? '마피아 승리입니다!' : '게임이 종료되었습니다.');
}

// 기다리는 사람(먼저, 크게)과 끝낸 사람 두 묶음. note(p)가 있으면 이름 옆에 작게 붙입니다.
function waitLists(waiting, done, waitLabel, doneLabel, note = () => '') {
  return `<div class="scr-wait-lists">
    <div class="wl wait"><div class="wl-head">${waitLabel} <b>${waiting.length}</b>명</div>
      <ul>${waiting.map(p => `<li>${esc(p.name)}${note(p) ? `<small>${note(p)}</small>` : ''}</li>`).join('') || '<li class="none">없음 🎉</li>'}</ul></div>
    <div class="wl done"><div class="wl-head">${doneLabel} <b>${done.length}</b>명</div>
      <ul>${done.map(p => `<li>${esc(p.name)} ✔</li>`).join('')}</ul></div></div>`;
}

const timer = (v) => v.phaseEndsAt ? `<div class="scr-timer" data-until="${v.phaseEndsAt}" ${v.paused ? `data-frozen="${v.remainMs}"` : ''}></div>` : '';
// 공개 상태: 신고·회의로 확인된 탈락자만 '탈락', 아직 발견되지 않은 사망자는 참가 중으로 보입니다.
const pubOut = (p) => p.status === 'deadRevealed' || p.status === 'ejected';

function viewOf(v) {
  const m = v.meeting || {};
  const ps = v.players || [];
  switch (v.phase) {
    case 'lobby': {
      const joinUrl = `${location.origin}/?room=${v.code}`;
      return `<div class="scr-grid"><div class="scr-join"><img src="/qr.svg?text=${encodeURIComponent(joinUrl)}" alt="입장 QR"><p class="scr-url">${esc(joinUrl.replace(/^https?:\/\//, ''))}</p></div>
        <div><div class="scr-kicker">방 코드</div><div class="scr-code">${esc(v.code)}</div>
        <div class="scr-stats"><div><b>${ps.length}</b>입장</div><div><b class="ok">${ps.filter(p => p.ready).length}</b>준비 완료</div></div>
        ${waitLists(ps.filter(p => !p.ready), ps.filter(p => p.ready), '아직 준비 안 함', '준비 완료', p => (p.tag ? '' : '이름표 미연결'))}</div></div>`;
    }
    case 'briefing':
      return `<div class="scr-center"><div class="scr-title">역할 확인 중</div><div class="scr-big">${ps.filter(p => p.ack).length} / ${ps.length}</div><p class="scr-sub">각자 휴대폰에서 몰래 역할을 확인하세요</p>
        ${waitLists(ps.filter(p => !p.ack), ps.filter(p => p.ack), '아직 확인 안 함', '확인 완료')}</div>`;
    case 'active': {
      const pr = v.progress || { pct: 0, goal: 80 };
      return `<div class="scr-center"><div class="scr-kicker">공동 임무 진행률</div><div class="scr-big">${pr.pct}%</div>
        <div class="scr-bar"><div style="width:${Math.min(100, pr.pct)}%"></div><i style="left:${pr.goal}%"></i></div>
        <p class="scr-sub">목표 ${pr.goal}%에 닿으면 시민 승리 · 긴급회의 남은 ${v.emergencyLeft}회</p></div>`;
    }
    case 'gathering':
    case 'discussion': {
      const why = m.trigger === 'report' ? `🚨 <b>${esc(m.by)}</b> 님이 쓰러진 <b>${esc(m.body)}</b> 님을 발견${m.where ? ` · 📍 ${esc(m.where)}` : ''}`
        : m.trigger === 'emergency' ? `📢 <b>${esc(m.by)}</b> 님의 긴급회의` : '📢 진행자 소집';
      return `<div class="scr-center ${v.phase === 'gathering' ? 'alarm-bg' : ''}"><div class="scr-title">${v.phase === 'gathering' ? '회의 소집!' : '토론'}</div>
        <p class="scr-sub">${why}</p>
        ${v.phase === 'gathering' ? `<p class="scr-place">집결 장소 <b>${esc(m.place)}</b></p>` : ''}
        ${timer(v)}
        <div class="scr-out">이번 회의에서 확인된 탈락자: <b>${(m.revealed || []).map(esc).join(', ') || '없음'}</b></div></div>`;
    }
    case 'voting': {
      const vt = v.vote || { cast: 0, eligible: 0 };
      return `<div class="scr-center"><div class="scr-title">투표</div>${timer(v)}<div class="scr-big">${vt.cast} / ${vt.eligible}</div><p class="scr-sub">휴대폰에서 투표하세요 · 누가 누구를 찍었는지는 공개되지 않습니다</p></div>`;
    }
    case 'result': {
      const r = v.lastResult || {};
      return `<div class="scr-center"><div class="scr-title">${r.ejected ? `${esc(r.ejected)} 님 추방` : '추방 없음'}</div>
        <p class="scr-sub">${esc(r.why || '')}${r.ejected && r.ejectedRole ? ` · ${esc(ROLE_NAME[r.ejectedRole] || '')}였습니다` : ''}</p>
        <ul class="scr-tally">${(r.tally || []).map(t => `<li><span>${esc(t.name)}</span><b>${t.count}표</b></li>`).join('')}<li><span>건너뛰기</span><b>${r.skip || 0}표</b></li></ul></div>`;
    }
    case 'ended': {
      const e = v.end || {};
      return `<div class="scr-center"><div class="scr-title ${e.winner === 'mafia' ? 'red' : ''}">${e.winner === 'citizen' ? '🎉 시민 승리' : e.winner === 'mafia' ? '🔪 마피아 승리' : '게임 종료'}</div>
        <p class="scr-sub">${esc(e.reason || '')}</p>
        <ul class="scr-roles">${ps.map(p => `<li class="${p.role}"><span>${esc(p.name)}</span><b>${ROLE_NAME[p.role] || '-'}</b></li>`).join('')}</ul></div>`;
    }
    default: return '';
  }
}

// 한켠의 생존자 목록. 아직 발견되지 않은 사망자는 살아 있는 사람으로 보입니다(공개 정보만).
function alivePanel(v) {
  const ps = v.players || [];
  const alive = ps.filter(p => !pubOut(p)), out = ps.filter(pubOut);
  return `<aside class="scr-alive"><div class="sa-head">생존 <b>${alive.length}</b>명</div>
    <ul>${alive.map(p => `<li>${esc(p.name)}</li>`).join('')}</ul>
    ${out.length ? `<div class="sa-head out">탈락 <b>${out.length}</b>명</div><ul class="out">${out.map(p => `<li>${esc(p.name)}<small>${p.status === 'ejected' ? '추방' : '사망'}</small></li>`).join('')}</ul>` : ''}</aside>`;
}

function render() {
  const v = SC.view;
  if (!v) return;
  const side = !['lobby', 'ended'].includes(v.phase);
  root.innerHTML = `<main class="scr">
    <header class="scr-head"><span>🕵️ 야외 마피아</span>${!Sound.ready() ? '<button class="scr-sound" id="snd">🔊 눌러서 소리·음성 안내 켜기</button>' : ''}<span class="scr-phase">${esc(PHASE_NAME[v.phase] || '')}${v.paused ? ' · ⏸ 일시 정지' : ''}</span></header>
    ${side ? `<div class="scr-body"><section class="scr-mainview">${viewOf(v)}</section>${alivePanel(v)}</div>` : viewOf(v)}</main>`;
  const b = document.getElementById('snd');
  if (b) b.onclick = () => { Sound.unlock(); say('소리 안내를 켰습니다.'); setTimeout(render, 300); };
}

if (!SC.code || !SC.token) {
  root.innerHTML = '<main class="scr"><p class="scr-wait">진행자 화면에서 "큰 화면 열기"로 들어오세요.</p></main>';
} else {
  connectStream(SC.code, SC.token, {
    host: true,
    onState: (v) => { const prev = SC.view; if (prev && v.version < prev.version) return; SC.view = v; announce(prev, v); render(); },
    onDenied: (msg) => { root.innerHTML = `<main class="scr"><p class="scr-wait">${esc(msg)}</p></main>`; },
    onKicked: (msg) => { root.innerHTML = `<main class="scr"><p class="scr-wait">${esc(msg)}</p></main>`; },
    onStatus: () => {},
  });
  Awake.set(true); // 큰 화면은 꺼지지 않게
}

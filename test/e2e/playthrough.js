// 준비: 이 폴더에서 npm i playwright@1.56.1 && npx playwright install chromium
'use strict';
// 실제 배포 서버에서 진행자 1명 + 참가자 12명(갤럭시 휴대폰 흉내)이 화면을 직접 눌러 한 판을 끝까지 진행합니다.
// 실행: node playthrough.js [서버주소]
const fs = require('fs');
const path = require('path');
const { chromium, devices } = require('playwright');

const B = process.argv[2] || 'https://outdoor-mafia.vercel.app';
const OUT = path.join(__dirname, '..', '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });
const PHONE = { ...devices['Galaxy S9+'], locale: 'ko-KR', acceptDownloads: true };
const NAMES = ['가은', '나래', '다솜', '라온', '마루', '바다', '사랑', '아라', '자람', '차오', '하늘', '타미'];
const PLACES = ['샤워장', '주차장', '캠프파이어', '매점', '놀이터'];

const results = [], errors = [], rejects = [], retries = [];
const ok = (c, m) => { results.push([!!c, m]); console.log((c ? '  ✔ ' : '  ✘ ') + m); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const step = (t) => console.log('\n[' + t + ']');

async function phone(browser, label) {
  const ctx = await browser.newContext(PHONE);
  // 클릭·스캐너 열림/닫힘·화면 다시 그리기를 기록 (문제 추적용)
  await ctx.addInitScript(() => {
    window.__ev = [];
    const t = () => (performance.now() / 1000).toFixed(2);
    document.addEventListener('click', e => { const a = e.target.closest && e.target.closest('[data-a]'); window.__ev.push(t() + ' click:' + (a ? a.dataset.a : e.target.tagName)); }, true);
    document.addEventListener('DOMContentLoaded', () => {
      new MutationObserver(ms => ms.forEach(m => {
        m.addedNodes.forEach(n => n.id === 'scanner' && window.__ev.push(t() + ' scanner+'));
        m.removedNodes.forEach(n => n.id === 'scanner' && window.__ev.push(t() + ' scanner-'));
      })).observe(document.body, { childList: true });
      new MutationObserver(() => window.__ev.push(t() + ' app-render')).observe(document.getElementById('app'), { childList: true });
    });
  });
  const page = await ctx.newPage();
  page.label = label;
  page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/status of 400/.test(m.text())) errors.push(`${label} console: ${m.text()}`); });
  // 서버가 거절한 요청은 내용까지 기록
  page.on('response', async r => { if (r.status() === 400 && r.url().includes('/api/')) { let b = ''; try { b = (await r.json()).error; } catch (_) {} const body = r.request().postData() || ''; rejects.push(`${label} ${(body.match(/"action":"(\w+)"/) || [])[1] || r.url().split('/api/')[1]}: ${b}`); } });
  page.cdp = await ctx.newCDPSession(page);
  return page;
}

// 진짜 터치 이벤트로 손가락 끌기
async function touchDrag(page, [x1, y1], [x2, y2], steps = 10) {
  const send = (type, x, y) => page.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await send('touchStart', x1, y1);
  for (let i = 1; i <= steps; i++) { await send('touchMove', x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps); await sleep(16); }
  await send('touchEnd');
}
const center = async (loc) => { const b = await loc.boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
const view = (page) => page.evaluate(() => (typeof S !== 'undefined' ? S.view : null));
const hview = (page) => page.evaluate(() => (typeof H !== 'undefined' ? H.view : null));
async function until(fn, ms = 15000, what = '') {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (_) { /* 다시 */ } await sleep(250); }
  throw new Error('시간 초과: ' + what);
}
let ROOM = null;
const serverHost = async () => (await (await fetch(`${B}/api/state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: ROOM.code, token: ROOM.token, host: true }) })).json()).view;
const tapConfirm = async (page) => { await page.locator('#confirm [data-act="ok"]').tap(); };

// 열려 있는 미니게임을 사람처럼 풀기
async function playGame(page) {
  const g = page.locator('.game');
  if (!(await g.waitFor({ timeout: 8000 }).then(() => true, () => false))) {
    await page.screenshot({ path: path.join(OUT, `fail-nogame-${page.label}.png`) });
    throw new Error(`${page.label} 미니게임 화면 안 열림: ` + JSON.stringify(await page.evaluate(() => ({ url: location.href, ev: (window.__ev || []).slice(-15), toast: (document.querySelector('.toast') || {}).textContent, modal: (document.querySelector('.modal') || {}).innerText, scanner: !!document.querySelector('#scanner'), task: S.view && S.view.me.task }))));
  }
  const title = await g.locator('.ghead b').innerText();
  const won = async () => (await g.locator('.gwin').count()) > 0 || !(await g.count());
  if (await g.locator('.flame').count()) {
    // 세 번씩 눌러야 꺼지고, 꺼진 불이 다시 붙기도 합니다.
    for (let k = 0; k < 80 && !(await won()); k++) {
      const f = g.locator('.flame:not(.out)').first();
      if (await f.count()) await f.tap(); else await sleep(300);
    }
  } else if (await g.locator('.simon').count()) {
    const d = (await view(page)).me.task.challenge;
    for (const [r, n] of d.rounds.entries()) {
      // 다른 사람이 마지막 임무를 끝내 게임이 끝나면 화면이 닫히므로 그때는 멈춥니다.
      await page.waitForFunction((want) => !document.querySelector('.game') || ((document.querySelector('.gstep') || {}).textContent || '') === want, `👆 ${r + 1}/${d.rounds.length}`, { timeout: 10000 });
      if (!(await g.count())) break;
      for (let k = 0; k < n; k++) await g.locator('.simon .pad').nth(d.seq[k]).tap();
      await sleep(300);
    }
  } else if (await g.locator('.lcd').count()) {
    for (let door = 0; door < 4 && !(await won()); door++) {
      const code = (await g.locator('.lcd').innerText()).replace(/\s/g, '');
      for (const c of code) await g.locator('.keypad button').filter({ hasText: new RegExp(`^${c}$`) }).tap();
      await sleep(400);
    }
  } else if (await g.locator('.order').count()) {
    for (let n = 1; n <= 25; n++) await g.locator('.order button').filter({ hasText: new RegExp(`^${n}$`) }).tap();
  } else if (await g.locator('canvas').count()) {
    for (let pass = 0; pass < 15 && !(await won()); pass++) {
      const b = await g.locator('canvas').boundingBox();
      if (!b) { await sleep(300); continue; }
      for (let y = b.y + 10; y < b.y + b.height; y += 36) {
        if (await won()) break;
        // 둥근 렌즈라 가운데에서 시작해 양쪽 끝까지 문지릅니다.
        const cx = b.x + b.width / 2;
        await touchDrag(page, [cx, y], [b.x + 4, y], 4);
        await touchDrag(page, [cx, y], [b.x + b.width - 4, y], 4);
      }
      await sleep(500); // 다음 렌즈로 넘어가는 시간
    }
  } else if (await g.locator('.crate').count()) {
    const NAME = { 'rgb(255, 77, 94)': 'red', 'rgb(77, 163, 255)': 'blue', 'rgb(255, 210, 63)': 'yellow', 'rgb(61, 220, 132)': 'green' };
    for (let i = 0; i < 16 && await g.locator('.crate').count(); i++) {
      const crate = g.locator('.crate');
      const color = NAME[await crate.evaluate(e => getComputedStyle(e).backgroundColor)];
      await touchDrag(page, await center(crate), await center(g.locator(`.bin[data-color="${color}"]`)));
      await sleep(150);
    }
  } else if (await g.locator('.track').count()) {
    for (let r = 0; r < 3 && !(await won()); r++) {
      for (const t of await g.locator('.track').all()) {
        const tb = await t.boundingBox(), lb = await t.locator('.target').boundingBox();
        await touchDrag(page, [tb.x + tb.width / 2, tb.y + tb.height - 8], [tb.x + tb.width / 2, lb.y + 2]);
      }
      await sleep(600);
    }
  } else if (await g.locator('.piece').count()) {
    for (let i = 0; i < 20 && !(await won()); i++) {
      const p = g.locator('.piece').first();
      if (!(await p.count())) { await sleep(300); continue; }
      const shape = await p.getAttribute('data-shape');
      await touchDrag(page, await center(p), await center(g.locator(`.hole[data-shape="${shape}"]:not(.full)`)));
      await sleep(150);
    }
  }
  if (!(await g.waitFor({ state: 'detached', timeout: 20000 }).then(() => true, () => false))) {
    await page.screenshot({ path: path.join(OUT, `fail-unsolved-${page.label}.png`) });
    throw new Error(`${page.label} ${title} 못 끝냄: ` + JSON.stringify(await page.evaluate(() => {
      const g = document.querySelector('.game');
      return { win: !!g.querySelector('.gwin'), flames: g.querySelectorAll('.flame:not(.out)').length, sw: g.querySelectorAll('.sw:not(.on)').length, crates: g.querySelectorAll('.crate').length, pieces: g.querySelectorAll('.piece').length,
        tracks: [...g.querySelectorAll('.track')].map(t => t.className + ' ' + t.querySelector('.fill').style.height + ' / target ' + t.querySelector('.target').style.bottom), order: g.querySelectorAll('.order button:not(.ok)').length, slots: (g.querySelector('.slots') || {}).innerText };
    })));
  }
  return title;
}

// 임무 하나: 장소 QR을 찍고(카메라 주소 또는 앱 안 코드 입력) 미니게임 완료
async function doTask(page, codeOf, how) {
  const v = await view(page);
  const t = v.me.task;
  if (!t) return null;
  const before = v.me.tasksDone;
  const code = codeOf[t.loc];
  if (how === 'camera') await page.goto(`${B}/?s=${code}`);
  else {
    await page.locator('[data-a="scan"]').tap();
    // 스크롤이 멈추는 순간 누르면 탭이 무시될 수 있어, 사람처럼 한 번 더 누릅니다(횟수 기록).
    if (!(await page.locator('#codeInput').waitFor({ timeout: 2000 }).then(() => true, () => false))) { retries.push(page.label); await page.locator('[data-a="scan"]').tap(); }
    try { await page.locator('#codeInput').waitFor({ timeout: 6000 }); } catch (e) {
      await page.screenshot({ path: path.join(OUT, `fail-${page.label}.png`) });
      const dbg = await page.evaluate(() => {
        const b = document.querySelector('[data-a="scan"]');
        const r = b.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { ev: window.__ev.slice(-12), scanner: !!document.querySelector('.scanner'), disabled: b.disabled, online: S.online, busy: S.busy, url: location.href,
          topAtButton: top && (top.className || top.tagName), modal: !!document.querySelector('.modal'), game: !!document.querySelector('.game'), toast: (document.querySelector('.toast') || {}).textContent };
      });
      throw new Error(`${page.label} 스캐너 코드 입력칸 없음: ${JSON.stringify(dbg)}`);
    }
    await page.locator('#codeInput').fill(code);
    await page.locator('.scanner button.primary').tap();
  }
  const title = await playGame(page);
  await until(async () => (await view(page)).me.tasksDone > before || (await view(page)).phase === 'ended', 10000, `${page.label} 임무 완료 반영`);
  return title;
}

(async () => {
  const browser = await chromium.launch();
  try {
    step('1. 진행자: 방 만들기, 장소 이름, 설정');
    const host = await phone(browser, '진행자');
    await host.goto(`${B}/host`);
    await host.locator('#create').tap();
    const hv0 = await until(() => hview(host), 10000, '방 생성');
    const code = hv0.code;
    ROOM = { code, token: await host.evaluate(() => H.token) };
    ok(/^[A-Z0-9]{4}$/.test(code), `방 생성 ${code}`);
    ok(hv0.settings.mafiaCount === 5 && hv0.settings.taskGoalPct === 80, '1시간용 기본값으로 생성');
    await host.locator('[data-tab="places"]').tap();
    const inputs = host.locator('.locedit [data-f="name"]');
    for (let i = 0; i < PLACES.length; i++) await inputs.nth(i).fill(PLACES[i]);
    await host.locator('[data-loc="save"]').tap();
    await until(async () => (await hview(host)).locations.map(l => l.name).join() === PLACES.join(), 8000, '장소 이름 저장');
    ok(true, '장소 이름을 바꿔 저장 (번호는 01~05 유지)');
    await host.locator('[data-tab="settings"]').tap();
    for (const [k, v] of [['mafiaCount', '3'], ['startProtect', '0'], ['killCooldown', '10'], ['emergencyCooldown', '0'], ['gatherSec', '60']]) await host.locator(`#setForm [name="${k}"]`).fill(v);
    await host.locator('#setForm button.primary').tap();
    await until(async () => (await hview(host)).settings.killCooldown === 10, 8000, '설정 저장');
    ok(true, '설정 탭에서 값 바꿔 저장');

    step('2. 설정 파일 저장 → 다시 불러오기');
    const [dl] = await Promise.all([host.waitForEvent('download'), host.locator('[data-run="exportSetup"]').tap()]);
    const file = path.join(OUT, 'setup.json');
    await dl.saveAs(file);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    ok(saved.app === 'outdoor-mafia' && saved.locations.length === 5 && saved.locations[2].name === '캠프파이어' && saved.settings.killCooldown === 10, '설정 파일 내려받기 (장소 이름·설정 포함)');
    await host.locator('#setupFile').setInputFiles(file);
    await tapConfirm(host);
    await host.locator('.toast.good').filter({ hasText: '불러왔습니다' }).waitFor({ timeout: 8000 });
    ok(true, '설정 파일 불러오기');

    step('3. 참가자 12명 입장, 이름표 연결');
    const P = {};
    await Promise.all(NAMES.map(async (n) => {
      const p = await phone(browser, n);
      await p.goto(`${B}/?room=${code}`);
      await p.locator('#fName').fill(n);
      await p.locator('#joinForm button.primary').tap();
      await until(async () => (await view(p)) && (await view(p)).phase === 'lobby', 12000, `${n} 입장`);
      P[n] = p;
    }));
    ok(Object.keys(P).length === 12, '12명 입장 (이름 입력 → 입장하기)');
    for (let i = 0; i < 6; i++) await P[NAMES[i]].goto(`${B}/?s=P${String(i + 1).padStart(2, '0')}`); // 휴대폰 카메라로 목걸이 QR
    for (let i = 6; i < 8; i++) { // 앱 안 스캐너에서 코드 입력
      const p = P[NAMES[i]];
      await p.locator('[data-a="scan"]').tap();
      await p.locator('#codeInput').fill(`P${i + 1}`);
      await p.locator('.scanner button.primary').tap();
    }
    await until(async () => (await hview(host)).players.filter(p => p.tag).length === 8, 12000, '이름표 8명 연결');
    ok(true, '카메라 주소 6명 + 앱 코드 입력 2명 이름표 연결');
    ok((await P[NAMES[0]].locator('.big').filter({ hasText: '01번' }).count()) === 1, '참가자 화면에 내 이름표 번호 표시');
    await host.locator('[data-tab="run"]').tap();
    await host.locator('[data-run="assignTags"]').tap();
    const tagged = await until(async () => { const v = await hview(host); return v.players.every(p => p.tag) && v.players; }, 8000, '자동 배정');
    ok(new Set(tagged.map(p => p.tag)).size === 12, '남은 4명 자동 배정 (번호 겹침 없음)');
    await host.screenshot({ path: path.join(OUT, '01-host-lobby.png') });

    step('4. 역할 배정, 확인, 시작');
    await host.locator('[data-run="assign"]').tap();
    await until(async () => (await hview(host)).phase === 'briefing', 8000, '배정');
    await Promise.all(NAMES.map(async n => {
      await until(async () => (await view(P[n])).phase === 'briefing', 10000, `${n} 역할 화면`);
      await P[n].locator('[data-a="toggleRole"]').tap();
      await P[n].locator('[data-a="ack"]').tap();
    }));
    await until(async () => (await hview(host)).players.every(p => p.ack), 10000, '전원 확인');
    await host.locator('[data-run="start"]').tap();
    await Promise.all(NAMES.map(n => until(async () => (await view(P[n])).phase === 'active', 10000, `${n} 시작`)));
    ok(true, '전원 역할 확인 → 게임 시작이 모든 휴대폰에 반영');
    let hv = await hview(host);
    const roleOf = Object.fromEntries(hv.players.map(p => [p.name, p.role]));
    const tagOf = Object.fromEntries(hv.players.map(p => [p.name, p.tag]));
    const codeOf = Object.fromEntries(hv.locations.map(l => [l.name, l.code]));
    const mafia = NAMES.filter(n => roleOf[n] === 'mafia'), cit = NAMES.filter(n => roleOf[n] === 'citizen');
    ok(mafia.length === 3 && cit.length === 9, `역할 배정 (마피아 ${mafia.join(', ')})`);

    step('5. 비밀 메뉴는 모두에게 같은 모양');
    const look = async (n) => P[n].locator('[data-a="toggleSecret"]').innerText();
    ok((await look(cit[0])) === (await look(mafia[0])), '닫힌 비밀 메뉴는 시민·마피아가 똑같음');
    await P[cit[0]].locator('[data-a="toggleSecret"]').tap();
    ok(await P[cit[0]].locator('[data-a="scanArea"].danger').count() === 1 && !(await P[cit[0]].locator('[data-a="kill"]').count()), '시민이 열면 위장 화면 (암살 버튼 없음)');
    await P[cit[0]].locator('[data-a="toggleSecret"]').tap();

    step('6. 미니게임 8종 (실제 터치)');
    const played = new Set();
    let k = 0;
    for (let round = 0; round < 2 && played.size < 8; round++) { // 3바퀴면 80%를 넘어 시민이 먼저 이김
      const titles = await Promise.all(cit.map(n => doTask(P[n], codeOf, (k++ % 2) ? 'camera' : 'app')));
      titles.filter(Boolean).forEach(t => played.add(t));
    }
    ok(played.size >= 6, `미니게임 ${played.size}종을 터치로 완료: ${[...played].join(', ')}`);
    hv = await hview(host);
    ok(hv.progress.done > 0, `진행률 반영 (${hv.progress.done}/${hv.progress.total})`);
    const before = (await serverHost()).progress.done;
    const mt = await doTask(P[mafia[0]], codeOf, 'app');
    ok(!!mt && (await serverHost()).progress.done === before, '마피아 위장 임무는 진행률에 안 들어감');

    step('7. 암살 → 신고(발견 장소) → 경보');
    const killer = mafia[0];
    const alive = async () => (await hview(host)).players.filter(p => p.status === 'alive' && p.role === 'citizen').map(p => p.name);
    const victim = (await alive()).find(n => n !== cit[0]);
    await P[killer].locator('[data-a="toggleSecret"]').tap();
    await until(async () => { await P[killer].locator('[data-a="kill"]:not([disabled])').waitFor({ timeout: 1000 }); return true; }, 20000, '암살 버튼 활성');
    await P[killer].locator('[data-a="kill"]').tap();
    await P[killer].locator('.modal [data-act="pick"]').filter({ hasText: victim }).tap();
    await tapConfirm(P[killer]);
    await P[victim].locator('.deadscreen').waitFor({ timeout: 10000 });
    ok(true, `${killer} → ${victim} 암살, 피해자 화면이 사망으로 바뀜`);
    const reporter = cit[0];
    await P[reporter].goto(`${B}/?s=P${String(tagOf[victim]).padStart(2, '0')}`);
    await P[reporter].locator('[data-act="report"]').tap();
    if (!(await P[reporter].locator('.modal [data-act="p"]').first().waitFor({ timeout: 5000 }).then(() => true, () => false))) {
      await P[reporter].screenshot({ path: path.join(OUT, 'fail-report.png') });
      throw new Error('발견 장소 창 없음: ' + JSON.stringify(await P[reporter].evaluate(() => ({ modal: (document.querySelector('.modal') || {}).innerText, places: S.view.places, ev: window.__ev.slice(-10) }))));
    }
    await P[reporter].locator('.modal [data-act="p"]').filter({ hasText: '매점' }).tap();
    const others = NAMES.filter(n => n !== victim);
    const alarmed = await Promise.all(others.map(n => P[n].locator('.alarm').waitFor({ timeout: 8000 }).then(() => true, () => false)));
    ok(alarmed.every(Boolean), `회의 경보가 살아 있는 ${others.length}명 화면에 모두 뜸`);
    ok((await P[mafia[1]].locator('.alarm').innerText()).includes('매점'), '경보에 발견 장소(매점) 표시');
    await P[mafia[1]].screenshot({ path: path.join(OUT, '02-alarm.png') });
    for (const n of others) await P[n].locator('.alarm').tap().catch(() => {});
    hv = await hview(host);
    ok(hv.phase === 'gathering' && hv.phaseEndsAt && await host.locator('.timer').count() === 1, '진행자 화면에 집결 타이머');
    ok(await P[cit[1]].locator('.timer').count() === 1, '참가자 화면에 토론 시작까지 남은 시간');

    step('8. 토론 → 투표 → 추방');
    await host.locator('[data-run="discussion"]').tap();
    await until(async () => (await hview(host)).phase === 'discussion', 8000, '토론');
    await host.locator('[data-run="vote"]').tap();
    const target = mafia[0];
    const voters = NAMES.filter(n => n !== victim);
    await Promise.all(voters.map(async n => {
      await until(async () => (await view(P[n])).phase === 'voting', 10000, `${n} 투표 화면`);
      const name = n === target ? '건너뛰기' : target; // 추방 대상 본인은 건너뛰기
      await P[n].locator(`.choice[data-a="vote"][data-name="${name}"]`).tap();
      await tapConfirm(P[n]);
    }));
    const res = await until(async () => { const v = await view(P[cit[2]]); return v.phase === 'result' && v.lastResult; }, 15000, '투표 결과');
    ok(res.ejected === target, `전원 투표 → ${target} 추방`);
    await host.locator('[data-run="resume"]').tap();
    await Promise.all(voters.map(n => until(async () => (await view(P[n])).phase === 'active', 10000, `${n} 재개`)));
    ok((await view(P[victim])).me.status === 'ghost', '피해자는 유령으로 임무 재개');

    step('9. 남은 임무 완료 → 시민 승리');
    const workers = cit; // 유령이 된 시민 포함
    await Promise.all(workers.map(async n => {
      for (let i = 0; i < 3; i++) {
        const v = await view(P[n]);
        if (v.phase !== 'active' || !v.me.task) break;
        await doTask(P[n], codeOf, i % 2 ? 'camera' : 'app').catch(e => { if (!/ended/.test(e.message)) throw e; });
      }
    }));
    await Promise.all(NAMES.map(n => until(async () => (await view(P[n])).phase === 'ended', 15000, `${n} 종료 화면`)));
    const end = (await view(P[cit[3]])).end;
    ok(end.winner === 'citizen' && /80%/.test(end.reason), `시민 승리: ${end.reason}`);
    await P[cit[3]].screenshot({ path: path.join(OUT, '03-ended.png') });

    step('10. 같은 참가자로 새 게임');
    await host.locator('[data-run="newGame"]').tap();
    await Promise.all(NAMES.map(n => until(async () => (await view(P[n])).phase === 'lobby', 10000, `${n} 대기 화면`)));
    hv = await hview(host);
    ok(hv.gameNo === 2 && hv.players.every(p => p.tag === tagOf[p.name]) && hv.settings.killCooldown === 10, '2판째: 이름표·설정 그대로 유지');
  } catch (e) {
    ok(false, '중단: ' + e.message);
  } finally {
    await browser.close();
  }
  console.log('\n서버가 거절한 요청:', rejects.length ? '\n  ' + rejects.join('\n  ') : '없음');
  console.log('\n오류(콘솔·페이지):', errors.length ? '\n  ' + [...new Set(errors)].join('\n  ') : '없음');
  const fails = results.filter(r => !r[0]).length;
  console.log(`\n결과: ${results.length - fails}개 통과, ${fails}개 실패`);
  process.exit(fails || errors.length ? 1 : 0);
})();

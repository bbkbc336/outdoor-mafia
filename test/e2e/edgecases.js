'use strict';
// 오작동 점검: 실제 휴대폰 화면(브라우저)과 서버를 함께 써서, 평소 흐름 밖의 상황을 하나씩 확인합니다.
// 유령·일시 정지·새로고침·진행자 수동 처리·연속으로 게임 열기·추방·새 판 등.
// 실행: GAME_FAST=1 로 서버를 띄운 뒤  node test/e2e/edgecases.js http://127.0.0.1:3000
const { chromium, devices } = require('playwright');
const B = process.argv[2] || 'http://127.0.0.1:3000';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  ✔', m); } else { failed++; console.log('  ✘', m); } };
const step = (t) => console.log(`\n[${t}]`);
const post = (p, b) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());

// 서버가 낸 문제의 정답 (test/rules.test.js 와 같은 방식)
const solve = (game, d) => ({
  fire: { out: d.spots && d.spots.length }, power: { links: (d.left || []).map((c, i) => [i, d.right.indexOf(c)]) }, lock: { seq: d.code },
  order: { seq: [...Array(25)].map((_, i) => i + 1) }, lens: { clean: 0.95 }, sort: { bins: d.boxes },
  level: { locked: 3 }, shape: { placed: (d.holes || []).map(x => x.s + '-' + x.c) },
  mole: { hits: [...Array(20)].map((_, i) => i) }, cards: { pairs: (d.deck || []).map((c, i) => [i, d.deck.indexOf(c, i + 1)]).filter(x => x[1] > 0) },
}[game]);

(async () => {
  const errors = [];
  const browser = await chromium.launch();
  const { code, hostToken: H } = await post('/api/rooms', {});
  const host = async (action, extra = {}) => { const r = await post('/api/act', { code, token: H, action, ...extra }); if (r.error) console.log('    (진행자)', action, '→', r.error); return r; };
  const hv = async () => (await post('/api/state', { code, token: H, host: true })).view;
  await host('settings', { settings: { mafiaCount: 2, startProtect: 0, resumeProtect: 0, killCooldown: 10, emergencyCooldown: 0, emergencyTotal: 4, tasksPerPlayer: 4, gatherSec: 0 } });
  const NAMES = ['가람', '나래', '다솜', '라온', '마루', '바다', '사랑', '아라'];
  const tok = {};
  for (const n of NAMES) tok[n] = (await post('/api/join', { code, name: n })).token;
  const P = {};
  const phone = async (n) => {
    if (P[n]) return P[n];
    const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'ko-KR' });
    await ctx.addInitScript(([c, t]) => { localStorage.setItem('mafia:p:' + c, JSON.stringify(t)); localStorage.setItem('mafia:last', JSON.stringify(c)); }, [code, tok[n]]);
    const pg = await ctx.newPage();
    pg.on('pageerror', e => errors.push(`${n}: ${e.message}`));
    pg.on('console', m => { if (m.type() === 'error') errors.push(`${n}: ${m.text()}`); });
    await pg.goto(`${B}/?room=${code}`);
    await pg.waitForFunction(() => typeof S !== 'undefined' && S.view, null, { timeout: 8000 });
    return (P[n] = pg);
  };
  const view = (n) => P[n].evaluate(() => S.view);
  const until = async (fn, ms, what) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(150); } console.log('    (시간 초과)', what); return false; };
  const act = (n, action, extra = {}) => post('/api/act', { code, token: tok[n], action, ...extra });
  const seq = async () => (await hv()).seq;
  const gameOpen = (n) => P[n].evaluate(() => !!document.querySelector('.game'));
  const locOf = async (n) => { const t = (await view(n)).me.task; return t && (await hv()).locations.find(l => l.name === t.loc); };
  const scanInApp = async (n) => { const L = await locOf(n); await P[n].evaluate(c => handleScan(c), L.code); await until(() => gameOpen(n), 5000, `${n} 게임 열림`); };
  // 열린 게임을 화면을 거치지 않고 정답으로 끝냄(서버 판정 확인용). 결과 메시지를 돌려줌
  const finishInApp = (n) => P[n].evaluate(async (src) => {
    const solve = eval(src);
    const t = S.view.me.task; Games.close();
    const r = await act('play', { taskId: t.id, result: solve(t.game, t.challenge) });
    return r ? r.message || 'ok' : 'fail';
  }, solve.toString());

  try {
    for (const n of NAMES) await phone(n);
    await host('assignTags'); await host('assign');
    const players = (await hv()).players;
    const mafia = players.filter(p => p.role === 'mafia').map(p => p.name);
    const cits = players.filter(p => p.role === 'citizen').map(p => p.name);
    const id = (n) => players.find(p => p.name === n).id;
    for (const n of NAMES) await act(n, 'ack');
    await host('start', { force: true });
    await until(async () => (await view(cits[0])).phase === 'active', 5000, '시작');
    const [A, Bn, C, D] = cits;

    step('1. 미니게임 도중 암살당하면');
    await scanInApp(A);
    ok(await gameOpen(A), `${A}: 장소 QR → 미니게임 열림`);
    await act(mafia[0], 'kill', { target: id(A), seq: await seq() });
    await until(async () => (await view(A)).me.status === 'dead', 5000, '사망 반영');
    ok(!(await gameOpen(A)), '암살당하면 하던 미니게임 창이 바로 닫힘');
    ok(await P[A].locator('.deadscreen').count() === 1 && await P[A].locator('[data-a="scan"]').count() === 0, '쓰러짐 화면, QR 스캔 버튼 없음');
    const r1 = await act(A, 'play', { taskId: (await view(A)).me.task.id, result: {} });
    ok(r1.error && /사망 상태/.test(r1.error), '쓰러진 상태로는 미션 완료 불가');
    await P[A].reload(); await P[A].waitForFunction(() => typeof S !== 'undefined' && S.view);
    ok(await P[A].locator('.deadscreen').count() === 1, '새로고침해도 쓰러짐 화면 유지');

    step('2. 신고 → 회의 → 활동 재개 후 유령');
    const ar = await act(Bn, 'report', { qr: players.find(p => p.name === A).code, seq: await seq() });
    ok(!ar.error, `${Bn}: 시체 신고`);
    await host('vote');
    for (const n of NAMES.filter(n => n !== A)) await act(n, 'vote', { target: 'skip', seq: await seq() });
    await until(async () => (await hv()).phase === 'result', 5000, '결과');
    await host('resume');
    await until(async () => (await view(A)).me.status === 'ghost', 5000, '유령으로 재개');
    await sleep(300);
    let va = await view(A);
    ok(va.me.status === 'ghost', '활동 재개 후 유령 상태');
    ok(await P[A].locator('text=유령 상태').count() === 1 && await P[A].locator('[data-a="scan"]').count() === 1, '유령 안내와 QR 스캔 버튼 보임');
    ok(await P[A].locator('[data-a="emergency"]').count() === 0 && await P[A].locator('[data-a="toggleSecret"]').count() === 0, '유령은 긴급회의·비밀 메뉴 없음');
    ok(await P[A].locator('[data-a="resumeGame"]').count() === 1, '하던 미니게임은 "이어서 하기"로 남아 있음');

    step('3. 유령: 이어서 하기 → 완료 → 버튼 사라지고 다음 임무');
    const before = (await hv()).progress.done;
    await P[A].locator('[data-a="resumeGame"]').click();
    ok(await until(() => gameOpen(A), 3000, '이어서 하기'), '"이어서 하기" 누르면 같은 미니게임이 열림');
    const msg = await finishInApp(A);
    ok(/임무 완료|모든 임무/.test(msg), `유령도 미션 완료 (${msg})`);
    await sleep(500);
    va = await view(A);
    ok(await P[A].locator('[data-a="resumeGame"]').count() === 0, '완료 후 "이어서 하기" 버튼이 사라짐');
    ok(va.me.task && va.me.task.index === 2 && !va.me.task.challenge, '다음 임무(2번)로 넘어감');
    ok((await hv()).progress.done === before + 1, '시민 유령의 미션이 공동 진행률에 반영');
    await scanInApp(A);
    ok(await gameOpen(A), '유령도 다음 장소 QR을 찍으면 미니게임이 열림');
    await P[A].evaluate(() => Games.close());
    ok(await P[A].locator('[data-a="resumeGame"]').count() === 1, '창을 닫으면 다시 "이어서 하기"');

    step('4. 일시 정지 중 미니게임');
    await scanInApp(Bn);
    await host('pause');
    await until(async () => (await view(Bn)).paused, 5000, '정지');
    ok(!(await gameOpen(Bn)), '진행자가 일시 정지하면 하던 게임 창이 닫힘');
    const rp = await act(Bn, 'play', { taskId: (await view(Bn)).me.task.id, result: {} });
    ok(rp.error, '정지 중에는 미션 완료 불가');
    await host('unpause');
    await until(async () => !(await view(Bn)).paused, 5000, '정지 해제');
    ok(await P[Bn].locator('[data-a="resumeGame"]').count() === 1, '정지를 풀면 "이어서 하기"로 계속');
    ok(/임무 완료|모든 임무/.test(await finishInApp(Bn)), '정지 전 문제로 이어서 완료');

    step('5. 진행자가 미션을 대신 완료하면');
    await scanInApp(C);
    await host('pause');
    await host('completeTask', { pid: id(C) });
    await host('unpause');
    await until(async () => (await view(C)).me.task.index === 2, 5000, '수동 완료 반영');
    ok(!(await gameOpen(C)), '임무가 바뀌면 열려 있던 게임 창이 닫힘');
    ok(await P[C].locator('[data-a="resumeGame"]').count() === 0, '바뀐 임무에는 "이어서 하기" 없음');

    step('6. 게임을 끝내자마자 다른 게임을 열어도');
    const keepOpen = await P[D].evaluate(async () => {
      const deck = ['🍎', '🍎', '🍌', '🍌', '🍇', '🍇', '🍉', '🍉', '🍒', '🍒', '🥝', '🥝'];
      Games.open({ game: 'cards', data: { deck } }, () => {});
      await new Promise(r => setTimeout(r, 400));
      const cards = [...document.querySelectorAll('.card9')];
      for (let i = 0; i < 12; i += 2) { cards[i].click(); cards[i + 1].click(); await new Promise(r => setTimeout(r, 350)); }
      await new Promise(r => setTimeout(r, 100)); // 완료 표시(0.7초) 도중
      Games.open({ game: 'order', data: { layout: [...Array(25)].map((_, i) => i + 1) } }, () => {});
      await new Promise(r => setTimeout(r, 1200));
      return !!document.querySelector('.game .order');
    });
    ok(keepOpen, '앞 게임의 완료 동작이 새로 연 게임 창을 닫지 않음');
    await P[D].evaluate(() => Games.close());

    step('7. 새로고침해도 하던 미니게임 유지');
    await scanInApp(D);
    const ch1 = JSON.stringify((await view(D)).me.task.challenge);
    await P[D].reload(); await P[D].waitForFunction(() => typeof S !== 'undefined' && S.view);
    ok(await P[D].locator('[data-a="resumeGame"]').count() === 1 && JSON.stringify((await view(D)).me.task.challenge) === ch1, '새로고침 후 같은 문제로 "이어서 하기"');
    await P[D].locator('[data-a="resumeGame"]').click();
    ok(await until(() => gameOpen(D), 3000, '재개'), '새로고침 후에도 이어서 열림');
    await P[D].evaluate(() => Games.close());

    step('8. 다른 장소 QR · 같은 장소 다시 찍기');
    const curLoc = (await view(D)).me.task.loc;
    const others = (await hv()).locations.filter(l => l.name !== curLoc);
    const wr = await act(D, 'scan', { value: others[0].code, seq: await seq() });
    ok(wr.error && /임무 장소가 아닙니다/.test(wr.error), '다른 장소 QR은 거부');
    const L = await locOf(D);
    const again = await act(D, 'scan', { value: L.code, seq: await seq() });
    ok(again.result && again.result.kind === 'game', '같은 장소를 다시 찍으면 새 문제로 다시 시작');

    step('9. 긴급회의 전체 횟수');
    const em = await act(Bn, 'emergency', { seq: await seq() });
    ok(!em.error, '긴급회의 요청');
    await until(async () => (await view(C)).phase === 'gathering', 5000, '집결');
    ok(!(await gameOpen(D)), '회의가 열리면 하던 게임 창이 닫힘');
    const rm = await act(D, 'play', { taskId: (await view(D)).me.task.id, result: {} });
    ok(rm.error && /이어서 하기/.test(rm.error), '회의 중 완료 시도 → "이어서 하기" 안내');
    await host('vote');
    // 마피아 1명 추방
    for (const n of NAMES.filter(n => n !== A)) await act(n, 'vote', { target: n === mafia[0] ? 'skip' : id(mafia[0]), seq: await seq() });
    await until(async () => (await hv()).phase === 'result', 5000, '결과');
    ok((await hv()).lastResult.ejected === mafia[0], `${mafia[0]}(마피아) 추방`);
    await host('resume');
    await until(async () => (await view(mafia[0])).me.status === 'ghost', 8000, '추방된 마피아 유령으로 재개');
    const vm = await view(mafia[0]);
    ok(vm.me.status === 'ghost' && (!vm.mafia || !vm.mafia.targets || vm.mafia.targets.length === 0), '추방된 마피아는 유령, 암살 대상 없음');
    const km = await act(mafia[0], 'kill', { target: id(D), seq: await seq() });
    ok(km.error, '추방된 마피아는 암살 불가');
    ok((await view(Bn)).me.emergencyLeft === 3, '긴급회의 1번 쓴 뒤 전체 남은 3회');

    step('10. 남은 마피아의 암살 대상');
    const vm2 = await view(mafia[1]);
    const targetNames = (vm2.mafia.targets || []).map(t => t.name);
    ok(!targetNames.includes(A) && !targetNames.includes(mafia[0]) && !targetNames.includes(mafia[1]), '유령·동료·자신은 암살 대상에 없음');

    step('11. 마피아 승리 조건');
    // 살아 있는 시민을 마피아 수와 같아질 때까지 암살
    let alive = (await hv()).players.filter(p => p.role === 'citizen' && p.status === 'alive').map(p => p.name);
    while (alive.length > 1) {
      await sleep(10300); // 암살 대기시간(최소 10초)
      const r = await act(mafia[1], 'kill', { target: id(alive[0]), seq: await seq() });
      if (r.error) { console.log('    ', r.error); break; }
      alive = (await hv()).players.filter(p => p.role === 'citizen' && p.status === 'alive').map(p => p.name);
      if ((await hv()).phase === 'ended') break;
    }
    const end = (await hv()).end;
    ok(end && end.winner === 'mafia', `마피아 승리: ${end && end.reason}`);
    await until(async () => (await view(D)).phase === 'ended', 5000, '종료 화면');
    ok(await P[D].locator('text=마피아 승리').count() >= 1, '참가자 화면에 마피아 승리 표시');

    step('12. 새 판');
    await host('newGame');
    await until(async () => (await view(A)).phase === 'lobby', 5000, '대기');
    const vl = await view(A);
    ok(vl.me.status === 'alive' && !vl.me.task && await P[A].locator('.deadscreen').count() === 0, '새 판: 모두 대기 화면, 지난 임무·상태 초기화');
    ok(!(await gameOpen(A)) && await P[A].locator('.alarm').count() === 0, '남아 있는 게임 창·경보 없음');
    await host('assign'); for (const n of NAMES) await act(n, 'ack'); await host('start', { force: true });
    await until(async () => (await view(A)).phase === 'active', 5000, '2판 시작');
    ok((await view(A)).me.emergencyLeft === 4 && (await view(A)).me.task.index === 1, '2판: 긴급회의 4회로 다시 채워지고 임무 1번부터');
  } catch (e) {
    ok(false, '중단: ' + e.message.split('\n')[0]);
  }
  console.log('\n화면 오류(콘솔·페이지):', errors.length ? '\n  ' + errors.join('\n  ') : '없음');
  if (errors.length) failed++;
  console.log(`\n결과: ${passed}개 통과, ${failed}개 실패`);
  await browser.close();
  process.exit(failed ? 1 : 0);
})();

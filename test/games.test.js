'use strict';
// 미니게임 규칙 시험. 실행: node test/games.test.js
delete process.env.GAME_FAST;
const G = require('../lib/game');
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  ✔', m); } else { failed++; console.log('  ✘', m); } };
const throws = (fn, re, m) => { try { fn(); ok(false, m); } catch (e) { ok(e instanceof G.GameError && re.test(e.message), `${m} — "${e.message}"`); } };

// 시간을 직접 움직여 최소 플레이 시간을 시험합니다.
let clock = Date.now();
Date.now = () => clock;

const right = (game, d) => ({
  fire: { out: d.spots && d.spots.length }, power: { links: (d.left || []).map((c, i) => [i, d.right.indexOf(c)]) }, lock: { seq: d.code },
  order: { seq: [...Array(25)].map((_, i) => i + 1) }, lens: { clean: 0.95 }, sort: { bins: d.boxes },
  level: { locked: 3 }, shape: { placed: (d.holes || []).map(x => x.s + '-' + x.c) },
    mole: { hits: [...Array(20)].map((_, i) => i) }, cards: { pairs: (d.deck || []).map((c, i) => [i, d.deck.indexOf(c, i + 1)]).filter(x => x[1] > 0) },
}[game]);
const wrong = (game, d) => ({
  fire: { out: 3 }, power: { links: (d.left || []).map((c, i) => [i, i]) }, lock: { seq: (d.code || []).slice(0, 3) },
  order: { seq: [2, 1, ...[...Array(23)].map((_, i) => i + 3)] }, lens: { clean: 0.3 }, sort: { bins: (d.boxes || []).map(c => (c === 'red' ? 'blue' : 'red')) },
  level: { locked: 2 }, shape: { placed: (d.holes || []).map(x => x.s + '-' + x.c).slice(0, 7) },
  mole: { hits: [...Array(19)].map((_, i) => i) }, cards: { pairs: [[0, 1], [2, 3], [4, 5], [6, 7], [8, 9], [10, 11]] },
}[game]);

const room = G.createRoom(new Set());
['가', '나', '다', '라'].forEach(n => G.join(room, n));
G.assignTags(room);
G.updateSettings(room, { mafiaCount: 1, tasksPerPlayer: 10, startProtect: 0 });
const L = room.locations[0];
G.saveMissions(room, G.GAME_KINDS.map(k => ({ type: 'game', game: k, loc: L.id })));
G.assignRoles(room);
G.startGame(room, true);
const p = G.list(room).find(x => x.role === 'citizen');
const seq = () => room.phaseSeq;

console.log('\n[게임별 문제·판정]');
const seen = new Set();
for (let i = 0; i < 10; i++) {
  const t = p.tasks[p.taskIdx];
  const r = G.scan(room, p, L.code, seq());
  seen.add(r.game);
  ok(r.kind === 'game' && r.taskId === t.id && r.data, `${r.name}: QR을 찍으면 문제가 나옴`);
  if (r.game === 'lock') ok(!JSON.stringify(G.playerView(room, p).roster).includes(r.data.code), '잠금 번호가 다른 정보에 섞이지 않음');
  throws(() => G.play(room, p, t.id, right(r.game, r.data), seq()), /완료되지 않았습니다/, `${r.name}: 너무 빨리 끝내면 거부`);
  clock += 9000;
  throws(() => G.play(room, p, t.id, wrong(r.game, r.data), seq()), /완료되지 않았습니다/, `${r.name}: 틀린 결과 거부`);
  const res = G.play(room, p, t.id, right(r.game, r.data), seq());
  ok(res.kind === 'done' && t.done, `${r.name}: 맞게 끝내면 임무 완료`);
}
ok(seen.size === 10, '10종 모두 시험');
ok(G.GAME_KINDS.every(k => G.GAMES[k].min >= 8000), '모든 게임은 8초 안에 끝낼 수 없음 (한 판 약 20초 분량)');

console.log('\n[진행 상황]');
G.newGame(room);
G.saveMissions(room, []);
G.updateSettings(room, { tasksPerPlayer: 4 });
G.assignRoles(room);
ok(G.list(room).every(x => x.tasks.every(t => t.type === 'game')), '임무 목록이 비면 모두 미니게임으로 자동 배정');
ok(G.list(room).every(x => new Set(x.tasks.map(t => t.game)).size === 4), '한 사람에게 같은 게임이 겹치지 않음');
G.startGame(room, true);
const q = G.list(room).find(x => x.role === 'citizen');
const t = q.tasks[0];
const wrongLoc = room.locations.find(l => l.id !== t.loc);
throws(() => G.scan(room, q, wrongLoc.code, seq()), /임무 장소가 아닙니다/, '다른 장소 QR은 거부');
const loc = room.locations.find(l => l.id === t.loc);
G.scan(room, q, loc.code, seq());
ok(G.playerView(room, q).me.task.challenge, '화면을 닫아도 이어서 할 수 있게 문제 유지');
clock += 9000;
const r2 = G.scan(room, q, loc.code, seq());
throws(() => G.play(room, q, t.id, right(r2.game, r2.data), seq()), /완료되지 않았습니다/, '다시 찍으면 새 문제로 처음부터 (시간도 다시)');
clock += 9000;
throws(() => G.play(room, q, 'nope', right(r2.game, r2.data), seq()), /바뀌었습니다/, '다른 임무 번호 거부');
G.pause(room);
throws(() => G.play(room, q, t.id, right(r2.game, r2.data)), /완료할 수 없습니다/, '일시 정지 중 완료 거부');
G.unpause(room);
G.play(room, q, t.id, right(r2.game, r2.data), seq() - 2);
ok(t.done, '진행자가 일시 정지했다 풀어도 하던 미니게임은 그대로 완료됨');
const m = G.list(room).find(x => x.role === 'mafia');
const before = G.progress(room).done;
const mt = m.tasks[0], ml = room.locations.find(l => l.id === mt.loc);
const mr = G.scan(room, m, ml.code, seq()); clock += 9000;
G.play(room, m, mt.id, right(mr.game, mr.data), seq());
ok(mt.done && G.progress(room).done === before, '마피아도 같은 게임을 하지만 진행률에는 반영 안 됨');

console.log('\n[신고 발견 장소]');
const victim = G.list(room).find(x => x.role === 'citizen' && x.id !== q.id && x.status === 'alive');
clock += 600000;
G.kill(room, m, victim.id, seq());
G.report(room, q, victim.code, seq(), '<script>없는 장소</script>');
ok(G.playerView(room, q).meeting.where === null, '장소 목록에 없는 이름은 표시하지 않음');

console.log('\n[회의 집결 제한 시간]');
ok(room.phase === 'gathering' && room.phaseEndsAt === clock + G.DEFAULT_SETTINGS.gatherSec * 1000, '신고하면 집결 제한 시간이 시작됨');
clock += G.DEFAULT_SETTINGS.gatherSec * 1000;
G.tick(room);
ok(room.phase === 'discussion', '집결 시간이 끝나면 자동으로 토론 시작');

console.log('\n[긴급회의는 한 판 전체 합계]');
{
  const em = G.createRoom(new Set());
  ['가', '나', '다', '라', '마', '바'].forEach(n => G.join(em, n));
  G.assignTags(em);
  G.updateSettings(em, { mafiaCount: 1, emergencyTotal: 2, emergencyCooldown: 0, startProtect: 0 });
  G.assignRoles(em); G.startGame(em, true);
  const cs = G.list(em).filter(x => x.role === 'citizen');
  const round = (p) => { G.emergency(em, p, em.phaseSeq); G.startVoting(em); G.closeVoting(em); G.resumeActivity(em); };
  ok(G.playerView(em, cs[0]).me.emergencyLeft === 2, '시작 시 전체 2회');
  round(cs[0]);
  ok(G.playerView(em, cs[1]).me.emergencyLeft === 1, '한 사람이 쓰면 모두의 남은 횟수가 줄어듦');
  round(cs[0]);
  ok(G.playerView(em, cs[2]).me.emergencyLeft === 0, '같은 사람이 두 번 써도 전체에서 차감');
  throws(() => G.emergency(em, cs[2], em.phaseSeq), /모두 썼습니다/, '전체 횟수를 다 쓰면 다른 사람도 거부');
  G.newGame(em); G.assignRoles(em);
  ok(G.playerView(em, cs[0]).me.emergencyLeft === 2, '새 판이면 다시 채워짐');
}
ok(G.DEFAULT_SETTINGS.emergencyTotal === 4, '기본 긴급회의는 전체 4회');

console.log('\n[기본값]');
const d = G.DEFAULT_SETTINGS;
ok(d.mafiaCount === 5 && d.tasksPerPlayer === 3 && d.taskGoalPct === 80 && d.killCooldown === 60 && d.discussionSec === 120, '1시간 진행용 기본값');

console.log('\n[설정 파일 불러오기]');
const fresh = G.createRoom(new Set());
throws(() => G.importSetup(fresh, { hello: 1 }), /설정 파일이 아닙니다/, '다른 파일은 거부');
const setup = {
  app: 'outdoor-mafia', version: 1,
  settings: { mafiaCount: 2, gatherSec: 0, gatherPlace: '캠프 파이어' },
  locations: [{ no: 7, name: '샤워장' }, { no: 3, name: '주차장' }],
  missions: [{ type: 'game', game: 'lock', locNo: 7 }, { type: 'game', game: 'random', locNo: 3 }],
};
const res = G.importSetup(fresh, setup);
ok(res.locations === 2 && res.missions === 2, '설정·장소·임무를 한 번에 불러옴');
ok(fresh.locations.find(l => l.name === '샤워장').code === 'L07' && fresh.locations.find(l => l.name === '주차장').code === 'L03', '장소 번호(인쇄한 QR) 그대로 유지');
ok(fresh.missions[0].loc === fresh.locations.find(l => l.no === 7).id && fresh.missions[0].game === 'lock', '임무는 장소 번호로 다시 연결');
ok(fresh.settings.mafiaCount === 2 && fresh.settings.gatherSec === 0 && fresh.settings.gatherPlace === '캠프 파이어', '설정 값 반영');
['가', '나', '다', '라', '마'].forEach(n => G.join(fresh, n));
G.assignTags(fresh); G.assignRoles(fresh); G.startGame(fresh, true);
G.hostMeeting(fresh);
ok(fresh.phase === 'gathering' && fresh.phaseEndsAt === null, '집결 제한 0이면 진행자가 직접 토론 시작');

console.log(`\n결과: ${passed}개 통과, ${failed}개 실패`);
process.exit(failed ? 1 : 0);

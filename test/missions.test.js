'use strict';
// 진행자 임무 목록 기능 시험. 실행: node test/missions.test.js
const G = require('../lib/game');
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  ✔', m); } else { failed++; console.log('  ✘', m); } };
const throws = (fn, re, m) => { try { fn(); ok(false, m); } catch (e) { ok(e instanceof G.GameError && re.test(e.message), `${m} — "${e.message}"`); } };

const room = G.createRoom(new Set());
['가', '나', '다', '라', '마', '바'].forEach(n => G.join(room, n));
G.assignTags(room);
G.updateSettings(room, { mafiaCount: 1, tasksPerPlayer: 3, startProtect: 0 });
const [L1, L2, L3] = room.locations;

console.log('\n[임무 목록 저장 검사]');
throws(() => G.saveMissions(room, [{ type: 'visit', loc: 'nope' }]), /장소를 고르세요/, '없는 장소 거부');
throws(() => G.saveMissions(room, [{ type: 'carry', loc: L1.id, loc2: L1.id }]), /같습니다/, '출발지=도착지 거부');
throws(() => G.saveMissions(room, [{ type: 'report', loc: L1.id, q: { question: '색은?', options: ['빨강', '파랑'], answer: '초록' } }]), /정답이 선택지에 없습니다/, '정답이 선택지에 없으면 거부');

const list = [
  { type: 'visit', loc: L1.id, title: '소화기 점검', desc: '소화기 옆 QR을 찍으세요' },
  { type: 'report', loc: L2.id, title: '깃발 확인', q: { question: '깃발 색은?', options: ['빨강', '파랑', '노랑'], answer: '노랑' } },
  { type: 'carry', loc: L3.id, loc2: L1.id, title: '공 옮기기' },
  { type: 'visit', loc: L2.id },
];
G.saveMissions(room, list);
ok(room.missions.length === 4 && room.missions.every(m => m.id), '임무 4개 저장, 각각 고유 번호');
const keepId = room.missions[0].id;
G.saveMissions(room, room.missions.map(m => ({ ...m })));
ok(room.missions[0].id === keepId, '다시 저장해도 임무 번호 유지');

console.log('\n[배정]');
G.assignRoles(room);
const ps = G.list(room);
ok(ps.every(p => p.tasks.length === 3), '1인당 3개 배정 (목록 4개 중)');
ok(ps.every(p => new Set(p.tasks.map(t => t.mid)).size === 3), '한 사람에게 같은 임무 중복 없음');
ok(new Set(ps.map(p => p.tasks.map(t => t.mid).join())).size > 1, '사람마다 다른 순서/조합');
ok(ps.every(p => p.tasks.every(t => room.missions.some(m => m.id === t.mid))), '모든 임무가 등록 목록에서 나옴');
throws(() => G.saveMissions(room, []), /게임 시작 전에만/, '대기 단계가 아니면 임무 수정 거부');

console.log('\n[진행]');
G.startGame(room, true);
const p = ps.find(x => x.tasks.some(t => t.type === 'report'));
while (p.tasks[p.taskIdx].type !== 'report') p.taskIdx++; // 보고 임무까지 건너뜀 (시험용)
const t = p.tasks[p.taskIdx];
const v = G.playerView(room, p);
ok(v.me.task.title === '깃발 확인', '참가자 화면에 임무 이름 표시');
const r1 = G.scan(room, p, L2.code);
ok(r1.kind === 'question' && r1.question === '깃발 색은?', '장소 QR 후 등록한 질문 표시');
// 장소 표지를 지워도 진행 중인 임무 질문은 유지
L2.sign = null;
ok(G.playerView(room, p).me.task.question === '깃발 색은?', '장소 정보가 바뀌어도 진행 중 임무의 질문 유지');
throws(() => G.answer(room, p, t.id, '파랑'), /맞지 않습니다/, '오답 거부');
G.scan(room, p, L2.code);
const r2 = G.answer(room, p, t.id, '노랑');
ok(r2.kind === 'done', '정답이면 완료');

console.log('\n[목록 비우면 자동 배정]');
G.newGame(room);
G.saveMissions(room, []);
G.assignRoles(room);
ok(G.list(room).every(x => x.tasks.length === 3 && x.tasks.every(t => !t.mid)), '목록이 비면 장소 정보로 자동 배정');

console.log('\n[장소 QR 01~10번 고정, 장소 수는 1~10곳]');
G.newGame(room);
ok(room.locations.length === 10 && room.locations.map(l => l.code).join() === 'L01,L02,L03,L04,L05,L06,L07,L08,L09,L10', '새 방은 장소 10곳, QR 01~10번');
const L5 = room.locations[4];
G.saveMissions(room, [{ type: 'visit', loc: L5.id }]);
G.saveLocations(room, room.locations.slice(0, 6).filter(l => l.id !== L1.id));
ok(room.locations.length === 5 && room.locations.map(l => l.code).join() === 'L01,L02,L03,L04,L05', '장소를 줄이면 앞번호 QR부터 차례로 씀');
ok(room.locations.find(l => l.id === L5.id).code === 'L04', '중간 장소를 지우면 뒤 장소가 한 번호 앞 QR로');
ok(room.missions[0].loc === L5.id, '번호가 바뀌어도 임무 연결은 유지');
throws(() => G.saveLocations(room, Array.from({ length: 11 }, (_, i) => ({ name: '곳' + i }))), /1~10곳/, '11곳은 거부');
throws(() => G.saveLocations(room, []), /1~10곳/, '0곳은 거부');
G.saveLocations(room, [{ name: '' }, { name: '매점' }]);
ok(room.locations[0].name === '장소 1' && room.locations[1].code === 'L02', '빈 이름은 기본 이름, 번호는 순서대로');
G.saveMissions(room, []);
G.assignRoles(room);
ok(G.list(room).every(x => x.tasks.length >= 1 && x.tasks.every(t => room.locations.some(l => l.id === t.loc))), '줄인 장소로 임무 배정');

console.log('\n[암살: 이름표 QR 찍기 모드]');
{
  const r2 = G.createRoom(new Set());
  ['가', '나', '다', '라', '마', '바'].forEach(n => G.join(r2, n));
  G.assignTags(r2);
  G.updateSettings(r2, { mafiaCount: 2, startProtect: 0, killByScan: true });
  ok(r2.settings.killByScan === true, '설정 켜짐');
  G.assignRoles(r2); G.startGame(r2, true);
  const [m1, m2] = G.list(r2).filter(x => x.role === 'mafia');
  const [c1, c2] = G.list(r2).filter(x => x.role === 'citizen');
  m1.killReadyAt = 0;
  throws(() => G.kill(r2, m1, c1.id, r2.phaseSeq), /등 QR을 찍어야/, '목록(이름)으로는 암살 불가');
  throws(() => G.kill(r2, m1, null, r2.phaseSeq, r2.locations[0].code), /등 QR을 찍어야/, '장소 QR로는 불가');
  throws(() => G.kill(r2, m1, null, r2.phaseSeq, '?s=' + m2.code), /동료/, '동료 이름표는 불가');
  throws(() => G.kill(r2, m1, null, r2.phaseSeq, '?s=' + m1.code), /자신/, '내 이름표는 불가');
  const res = G.kill(r2, m1, c2.id, r2.phaseSeq, 'https://x.dev/?s=' + c1.code.toLowerCase());
  ok(res.targetName === c1.name && c1.status === 'dead' && c2.status === 'alive', '찍은 이름표의 사람이 대상 (목록에서 넘긴 id는 무시)');
  m2.killReadyAt = 0;
  const n = Number(c2.code.slice(1));
  throws(() => G.kill(r2, m2, null, r2.phaseSeq, 'p' + n), /코드 입력으로는/, '손으로 친 코드(p7)는 거부');
  throws(() => G.kill(r2, m2, null, r2.phaseSeq, c2.code), /코드 입력으로는/, '손으로 친 코드(P07)도 거부');
  ok(c2.status === 'alive' && m2.killReadyAt === 0, '거부되면 아무 일도 없음 (대기시간도 그대로)');
  ok(G.kill(r2, m2, null, r2.phaseSeq, 'https://x.dev/?s=' + c2.code).targetName === c2.name, '카메라로 찍은 QR(주소 형태)은 인식');
  const pv = G.playerView(r2, m1);
  ok(pv.settings.killByScan === true && pv.mafia.targets.every(t => /^P\d\d$/.test(t.code)), '마피아 화면에 모드와 대상 이름표 번호 전달');
  ok(G.playerView(r2, G.list(r2).find(x => x.role === 'citizen' && x.status === 'alive')).mafia === undefined, '시민은 대상 정보를 받지 않음');
}
{
  const r3 = G.createRoom(new Set());
  ['가', '나', '다', '라'].forEach(n => G.join(r3, n));
  G.assignTags(r3); G.updateSettings(r3, { mafiaCount: 1, startProtect: 0 });
  G.assignRoles(r3); G.startGame(r3, true);
  const m = G.list(r3).find(x => x.role === 'mafia'), c = G.list(r3).find(x => x.role === 'citizen');
  m.killReadyAt = 0;
  ok(G.kill(r3, m, c.id, r3.phaseSeq).targetName === c.name, '모드가 꺼져 있으면 지금처럼 목록으로 암살');
}

console.log(`\n결과: ${passed}개 통과, ${failed}개 실패`);
process.exit(failed ? 1 : 0);

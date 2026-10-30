'use strict';
// 방 저장소. 두 가지 방식이 같은 함수들을 제공합니다.
//  - Redis(Upstash REST): Vercel처럼 서버가 여러 개로 나뉘어 뜨는 곳. 버전 비교(CAS)로 동시 요청을 하나씩 확정합니다.
//  - 파일: 서버 하나가 계속 떠 있는 곳(로컬, Render). 메모리에 두고 data/rooms.json에 저장합니다.
//
// meta 문자열 "버전:단계종료시각" — 폴링 때 이것만 읽어 바뀐 게 없으면 방 전체를 읽지 않습니다.

const fs = require('fs');
const path = require('path');
const G = require('./game');

const TTL_SEC = 3 * 24 * 3600;
const ONLINE_MS = 25000;

const metaOf = (room, rev) => `${rev}:${room.paused ? 0 : (room.phaseEndsAt || 0)}`;
const revOf = (meta) => Number(String(meta).split(':')[0]) || 0;
// 토론·투표 시간이 끝났는데 아직 넘어가지 않았는지
const isDue = (meta) => { const e = Number(String(meta).split(':')[1]) || 0; return e > 0 && Date.now() >= e; };
const notFound = () => new G.GameError('방을 찾을 수 없습니다. 방 코드를 확인하세요.');

// 공통 갱신 절차: 읽기 → 시간 지난 단계 넘기기 → fn 실행 → 바뀌었으면 저장(충돌 시 처음부터 다시)
// fn이 GameError를 던져도 그 전에 바뀐 내용은 저장합니다(예: 보고 오답 시 임무 단계 되돌림).
async function runUpdate(load, cas, code, fn) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const cur = await load(code);
    if (!cur) throw notFound();
    const room = cur.room;
    const before = JSON.stringify(room);
    while (G.tick(room)) { /* 토론→투표→결과가 한꺼번에 밀렸을 때 */ }
    let result, err = null;
    try { result = fn ? fn(room) : undefined; } catch (e) { if (!(e instanceof G.GameError)) throw e; err = e; }
    let meta = cur.meta;
    if (JSON.stringify(room) !== before) {
      room.lastActive = Date.now();
      meta = await cas(code, cur.meta, room);
      if (!meta) { await new Promise(r => setTimeout(r, 15 + Math.random() * 40 * (attempt + 1))); continue; }
    }
    if (err) { err.room = room; err.meta = meta; throw err; }
    return { room, meta, result };
  }
  throw new Error('저장 충돌이 계속됩니다.');
}

// ───────────── Redis (Upstash REST) ─────────────
const CAS = `if (redis.call('GET', KEYS[2]) or '') ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[4])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[4])
return 1`;
const CREATE = `if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[3]) then
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3]) return 1 end
return 0`;
const BEAT = `redis.call('HSET', KEYS[1], ARGV[1], ARGV[2]) redis.call('EXPIRE', KEYS[1], ARGV[3]) return 1`;
const LIMIT = `local n = redis.call('INCR', KEYS[1]) if n == 1 then redis.call('EXPIRE', KEYS[1], 3600) end return n`;

function redisStore(url, token) {
  const K = { room: c => `mafia:room:${c}`, meta: c => `mafia:meta:${c}`, seen: c => `mafia:seen:${c}`, rl: ip => `mafia:rl:${ip}` };
  async function cmd(...args) {
    const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(args) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error('Redis 오류: ' + (j.error || r.status));
    return j.result;
  }
  // 같은 서버 인스턴스 안에서는 같은 버전의 방을 다시 내려받지 않습니다(읽기 전용 사본).
  const cache = new Map();
  const remember = (code, meta, room) => { cache.set(code, { meta, room }); if (cache.size > 200) cache.delete(cache.keys().next().value); };

  async function load(code) {
    const [s, meta] = await cmd('MGET', K.room(code), K.meta(code));
    if (!s || !meta) return null;
    return { room: JSON.parse(s), meta };
  }
  async function cas(code, expected, room) {
    const meta = metaOf(room, revOf(expected) + 1);
    const json = JSON.stringify(room);
    const ok = await cmd('EVAL', CAS, 2, K.room(code), K.meta(code), expected, meta, json, TTL_SEC);
    if (Number(ok) !== 1) return null;
    remember(code, meta, JSON.parse(json));
    return meta;
  }
  return {
    kind: 'redis',
    meta: (code) => cmd('GET', K.meta(code)),
    async snapshot(code, meta) {
      const c = cache.get(code);
      if (c && c.meta === meta) return { room: c.room, meta };
      const cur = await load(code);
      if (cur) remember(code, cur.meta, cur.room);
      return cur;
    },
    get: load,
    update: (code, fn) => runUpdate(load, cas, code, fn),
    async create(room) {
      const meta = metaOf(room, 1);
      return Number(await cmd('EVAL', CREATE, 2, K.room(room.code), K.meta(room.code), JSON.stringify(room), meta, TTL_SEC)) === 1;
    },
    beat: (code, pid) => cmd('EVAL', BEAT, 1, K.seen(code), pid, String(Date.now()), TTL_SEC),
    async online(code) {
      const arr = await cmd('HGETALL', K.seen(code)) || [];
      const t = Date.now(), set = new Set();
      for (let i = 0; i < arr.length; i += 2) if (t - Number(arr[i + 1]) < ONLINE_MS) set.add(arr[i]);
      return set;
    },
    async allowCreate(ip) { return Number(await cmd('EVAL', LIMIT, 1, K.rl(ip || '?'))) <= 30; },
  };
}

// ───────────── 파일 (서버 하나) ─────────────
function fileStore(dataDir) {
  const file = path.join(dataDir, 'rooms.json');
  const rooms = new Map(), revs = new Map(), seen = new Map(), limits = new Map();
  try {
    for (const r of JSON.parse(fs.readFileSync(file, 'utf8'))) rooms.set(r.code, r);
    console.log(`저장된 방 ${rooms.size}개를 불러왔습니다.`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('저장 파일을 읽지 못했습니다:', e.message);
  }
  let timer = null;
  function saveNow() {
    if (timer) { clearTimeout(timer); timer = null; }
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify([...rooms.values()]));
      fs.renameSync(file + '.tmp', file);
    } catch (e) { console.error('저장 실패:', e.message); }
  }
  const save = () => { if (!timer) timer = setTimeout(saveNow, 200); };
  const meta = (code) => { const r = rooms.get(code); return r ? metaOf(r, revs.get(code) || 1) : null; };
  const load = async (code) => (rooms.has(code) ? { room: rooms.get(code), meta: meta(code) } : null);
  // 한 프로세스가 같은 객체를 직접 고치므로 충돌이 없습니다.
  const cas = async (code) => { revs.set(code, (revs.get(code) || 1) + 1); save(); return meta(code); };
  const onlineSet = (code) => {
    const m = seen.get(code) || {}, t = Date.now();
    return new Set(Object.keys(m).filter(pid => t - m[pid] < ONLINE_MS));
  };
  return {
    kind: 'file',
    meta: async (code) => meta(code),
    snapshot: load,
    get: load,
    update: (code, fn) => runUpdate(load, cas, code, fn),
    async create(room) { if (rooms.has(room.code)) return false; room.lastActive = Date.now(); rooms.set(room.code, room); save(); return true; },
    async beat(code, pid) { const m = seen.get(code) || {}; m[pid] = Date.now(); seen.set(code, m); },
    online: async (code) => onlineSet(code),
    async allowCreate(ip) {
      const t = Date.now(), arr = (limits.get(ip) || []).filter(x => t - x < 3600e3);
      if (arr.length >= 30) return false;
      arr.push(t); limits.set(ip, arr); return true;
    },
    // 서버가 계속 떠 있을 때만: 타이머 진행, 오래된 방 정리
    codes: () => [...rooms.keys()],
    isDue: (code) => { const m = meta(code); return !!m && isDue(m); },
    cleanup() {
      const t = Date.now();
      for (const [code, room] of rooms) {
        if (t - (room.lastActive || room.createdAt) > TTL_SEC * 1000 && !onlineSet(code).size) { rooms.delete(code); revs.delete(code); seen.delete(code); save(); }
      }
    },
    saveNow,
  };
}

function createStore() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return redisStore(url.replace(/\/$/, ''), token);
  if (process.env.VERCEL) return null; // Vercel에서는 파일 저장이 불가능하므로 Redis 연결이 필수
  return fileStore(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
}

module.exports = { createStore, redisStore, fileStore, isDue };

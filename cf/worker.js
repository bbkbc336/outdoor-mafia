// Cloudflare Workers 입구. 방 하나 = Durable Object 하나(Room).
//  - 정적 파일(public/)은 Workers Static Assets가 직접 내보냅니다(요청 수에 안 셈).
//  - /api/*, /print 는 방 코드로 해당 Room에 넘기고, Room이 기존 처리 코드(lib/handler.js)를 그대로 돌립니다.
//  - 휴대폰은 /api/ws 로 WebSocket을 열어 두고, 방이 바뀔 때만 새 화면 데이터를 받습니다(2.5초마다 묻지 않음).
//  - 토론·투표 시간이 끝나면 Durable Object 알람이 다음 단계로 넘깁니다.
import { DurableObject } from 'cloudflare:workers';
import G from '../lib/game.js';
import QR from '../lib/qr.js';
import { createHandler } from '../lib/handler.js';

const TTL_MS = 3 * 24 * 3600 * 1000; // 마지막 활동 후 3일 지나면 방을 지웁니다
const ONLINE_MS = 25000;
const metaOf = (room, rev) => `${rev}:${room.paused ? 0 : (room.phaseEndsAt || 0)}`;
const upper = (s) => String(s || '').trim().toUpperCase();
const jsonRes = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

// 토큰으로 진행자/참가자 구분 (lib/handler.js 와 같은 규칙)
function authIn(room, tok) {
  if (tok && tok === room.hostToken) return { who: 'host' };
  const p = tok && Object.values(room.players).find(x => x.token === tok);
  return p ? { who: 'player', pid: p.id } : null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const route = url.pathname;
    try {
      if (route === '/qr.svg') {
        const text = (url.searchParams.get('text') || '').slice(0, 200);
        return new Response(QR.svg(text), { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' } });
      }
      if (route === '/api/ping') return jsonRes(200, { ok: true, t: Date.now(), ws: true });
      if (route === '/api/ws' || route === '/print') {
        const code = upper(url.searchParams.get('code'));
        if (!/^[A-Z0-9]{4}$/.test(code)) return new Response('방을 찾을 수 없습니다. 방 코드를 확인하세요.', { status: 404 });
        return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request);
      }
      if (route.startsWith('/api/')) {
        if (request.method !== 'POST') return jsonRes(405, { error: '허용되지 않은 요청입니다.' });
        const text = await request.text();
        if (text.length > 100000) return jsonRes(400, { error: '잘못된 요청입니다.' });
        let body;
        try { body = text ? JSON.parse(text) : {}; } catch (_) { return jsonRes(400, { error: '잘못된 요청입니다.' }); }
        if (route === '/api/rooms') return createRoom(request, env);
        const code = upper(body.code);
        if (!/^[A-Z0-9]{4}$/.test(code)) return jsonRes(400, { error: '방을 찾을 수 없습니다. 방 코드를 확인하세요.' });
        return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(new Request(request.url, { method: 'POST', headers: request.headers, body: text }));
      }
      return env.ASSETS.fetch(request);
    } catch (e) {
      console.error(e);
      return jsonRes(500, { error: '서버 오류가 발생했습니다.' });
    }
  },
};

// 새 방: 코드를 정하고 그 코드의 Room에 처음 상태를 넣습니다. 같은 코드가 이미 있으면 다시 뽑습니다.
async function createRoom(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || '?';
  const lim = await env.LIMITS.get(env.LIMITS.idFromName(ip)).fetch('https://limit/hit');
  if (lim.status === 429) return jsonRes(429, { error: '방을 너무 많이 만들었습니다. 잠시 후 다시 시도하세요.' });
  for (let i = 0; i < 20; i++) {
    const room = G.createRoom(new Set());
    room.lastActive = Date.now();
    const r = await env.ROOMS.get(env.ROOMS.idFromName(room.code)).fetch('https://room/__init', { method: 'POST', body: JSON.stringify(room) });
    if (r.ok) return jsonRes(200, { code: room.code, hostToken: room.hostToken });
  }
  return jsonRes(500, { error: '방 코드를 만들지 못했습니다.' });
}

// 방 만들기 횟수 제한: IP마다 한 시간에 30개
export class Limiter extends DurableObject {
  async fetch() {
    const t = Date.now();
    const arr = ((await this.ctx.storage.get('hits')) || []).filter(x => t - x < 3600e3);
    if (arr.length >= 30) return new Response('', { status: 429 });
    arr.push(t);
    await this.ctx.storage.put('hits', arr);
    return new Response('ok');
  }
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = null;
    this.rev = 1;
    this.seen = new Map(); // WebSocket 없이 묻기(폴링)로 붙은 휴대폰의 마지막 접속 시각
    this.sent = new Map(); // 연결마다 마지막으로 보낸 화면 내용(버전·서버 시각 제외). 같으면 다시 보내지 않습니다.
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get('room')) || null;
      this.rev = (await ctx.storage.get('rev')) || 1;
    });
    // 이 방 하나만 담는 저장소. lib/handler.js 가 쓰는 함수 이름을 그대로 맞춥니다.
    const self = this;
    this.store = {
      kind: 'durable-object',
      meta: async () => (self.room ? metaOf(self.room, self.rev) : null),
      snapshot: async () => (self.room ? { room: self.room, meta: metaOf(self.room, self.rev) } : null),
      get: async () => (self.room ? { room: self.room, meta: metaOf(self.room, self.rev) } : null),
      update: (code, fn) => self.update(fn),
      create: async () => false, // 새 방은 /__init 으로만 만듭니다
      beat: async (code, pid) => { self.seen.set(pid, Date.now()); },
      online: async () => self.onlineSet(),
      allowCreate: async () => true,
    };
    this.handle = createHandler(this.store);
  }

  onlineSet() {
    const set = new Set(), t = Date.now();
    for (const ws of this.ctx.getWebSockets()) { const a = ws.deserializeAttachment(); if (a && a.pid) set.add(a.pid); }
    for (const [pid, at] of this.seen) if (t - at < ONLINE_MS) set.add(pid);
    return set;
  }

  // lib/store.js 의 runUpdate 와 같은 절차: 시간 지난 단계 넘기기 → fn → 바뀌었으면 저장·알림.
  // Durable Object는 한 번에 요청 하나씩 처리하므로 충돌 재시도가 필요 없습니다.
  async update(fn) {
    if (!this.room) throw new G.GameError('방을 찾을 수 없습니다. 방 코드를 확인하세요.');
    const room = this.room;
    const before = JSON.stringify(room);
    while (G.tick(room)) { /* 토론→투표→결과가 한꺼번에 밀렸을 때 */ }
    let result, err = null;
    try { result = fn ? fn(room) : undefined; } catch (e) { if (!(e instanceof G.GameError)) throw e; err = e; }
    if (JSON.stringify(room) !== before) {
      room.lastActive = Date.now();
      this.rev++;
      await this.ctx.storage.put({ room, rev: this.rev });
      await this.schedule();
      this.broadcast();
    }
    const meta = metaOf(room, this.rev);
    if (err) { err.room = room; err.meta = meta; throw err; }
    return { room, meta, result };
  }

  // 다음 알람: 단계 종료 시각(정지 중이 아니면), 없으면 방 정리 시각
  async schedule() {
    const r = this.room;
    if (!r) return;
    const at = r.phaseEndsAt && !r.paused ? r.phaseEndsAt + 50 : (r.lastActive || Date.now()) + TTL_MS;
    await this.ctx.storage.setAlarm(at);
  }

  async alarm() {
    const r = this.room;
    if (!r) return;
    if (r.phaseEndsAt && !r.paused && Date.now() >= r.phaseEndsAt) {
      try { await this.update(null); } catch (e) { console.error(e); }
      return;
    }
    if (Date.now() - (r.lastActive || 0) > TTL_MS && !this.ctx.getWebSockets().length) {
      this.room = null;
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.schedule();
  }

  // 휴대폰마다 자기 화면 데이터를 보냅니다. 진행자 화면은 접속 표시 때문에 hostOnly로도 다시 보냅니다.
  // 화면 내용이 지난번에 보낸 것과 같으면(방 전체 버전·서버 시각만 바뀐 경우) 보내지 않습니다.
  sendView(ws, meta, now, view) {
    const { version, serverNow, remainMs, ...rest } = view;
    const key = JSON.stringify(rest);
    if (this.sent.get(ws) === key) return;
    this.sent.set(ws, key);
    ws.send(JSON.stringify({ type: 'state', rev: meta, serverNow: now, view }));
  }

  broadcast(hostOnly = false) {
    const r = this.room;
    if (!r) return;
    const meta = metaOf(r, this.rev), now = Date.now();
    let online = null;
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (!a || (hostOnly && a.who !== 'host')) continue;
      try {
        if (a.who === 'host') {
          online = online || this.onlineSet();
          this.sendView(ws, meta, now, G.hostView(r, (pid) => online.has(pid)));
        } else {
          const p = r.players[a.pid];
          if (!p) { ws.send(JSON.stringify({ type: 'kicked', error: '진행자가 내보냈거나 방이 바뀌었습니다.' })); ws.close(4001, 'kicked'); continue; }
          this.sendView(ws, meta, now, G.playerView(r, p));
        }
      } catch (_) { /* 끊긴 연결은 무시 */ }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/__init') {
      if (this.room) return new Response('exists', { status: 409 });
      this.room = await request.json();
      this.rev = 1;
      await this.ctx.storage.put({ room: this.room, rev: 1 });
      await this.schedule();
      return new Response('ok');
    }
    if (url.pathname === '/api/ws') return this.connect(request, url);
    return this.runHandler(request, url);
  }

  // WebSocket 연결: 토큰 확인 후 받아들이고, 지금 화면을 바로 보냅니다.
  connect(request, url) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket이 필요합니다.', { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const deny = (msg) => { server.send(JSON.stringify({ type: 'denied', error: msg })); server.close(4003, 'denied'); };
    if (!this.room) deny('방을 찾을 수 없습니다. 방 코드를 확인하세요.');
    else {
      const a = authIn(this.room, url.searchParams.get('token'));
      if (!a) deny('접속 정보가 없습니다. 다시 입장하거나 복구 코드를 입력하세요.');
      else {
        server.serializeAttachment(a);
        const meta = metaOf(this.room, this.rev), now = Date.now();
        const online = this.onlineSet();
        const view = a.who === 'host' ? G.hostView(this.room, (pid) => online.has(pid)) : G.playerView(this.room, this.room.players[a.pid]);
        this.sendView(server, meta, now, view);
        if (a.who === 'player') this.broadcast(true); // 진행자 화면의 접속 표시 갱신
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, msg) {
    if (msg === 'ping') ws.send('pong'); // 연결 유지용
  }

  async webSocketClose(ws) {
    this.sent.delete(ws);
    try { ws.close(); } catch (_) { /* 이미 닫힘 */ }
    const a = ws.deserializeAttachment();
    if (a && a.who === 'player') this.broadcast(true);
  }

  async webSocketError(ws) { await this.webSocketClose(ws); }

  // 기존 처리 코드(lib/handler.js)를 Node 요청·응답 모양으로 감싸서 그대로 돌립니다.
  async runHandler(request, url) {
    const headers = {};
    for (const [k, v] of request.headers) headers[k.toLowerCase()] = v;
    headers['x-forwarded-proto'] = url.protocol.replace(':', '');
    headers['x-forwarded-host'] = url.host;
    const text = request.method === 'POST' ? await request.text() : '';
    const req = { method: request.method, url: url.pathname + url.search, headers, body: text, socket: {} };
    return new Promise((resolve) => {
      let status = 200, h = {};
      const res = {
        writeHead(s, hh) { status = s; h = hh || {}; },
        end(body) { resolve(new Response(body === undefined ? null : body, { status, headers: h })); },
      };
      this.handle(req, res).catch((e) => { console.error(e); resolve(jsonRes(500, { error: '서버 오류가 발생했습니다.' })); });
    });
  }
}

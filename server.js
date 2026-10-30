'use strict';
// 야외 마피아 서버 (로컬·Render용). 외부 패키지 없이 Node.js 18 이상에서 실행됩니다.
// Vercel에서는 이 파일 대신 api/handler.js가 같은 처리 코드를 씁니다.
// KV_REST_API_URL/TOKEN(또는 UPSTASH_REDIS_REST_URL/TOKEN)이 있으면 Redis에, 없으면 data/rooms.json에 저장합니다.

const http = require('http');
const path = require('path');
const { createStore } = require('./lib/store');
const { createHandler } = require('./lib/handler');

const PORT = Number(process.env.PORT) || 3000;
const store = createStore();
const handle = createHandler(store, { publicDir: path.join(__dirname, 'public') });

if (store.kind === 'file') {
  // 서버 재시작·재배포 시 마지막 상태를 저장하고 종료
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { store.saveNow(); process.exit(0); });
  // 아무도 화면을 보고 있지 않아도 토론·투표 시간이 끝나면 넘어가게 합니다.
  setInterval(() => {
    for (const code of store.codes()) if (store.isDue(code)) store.update(code, null).catch(() => {});
  }, 500);
  setInterval(() => store.cleanup(), 60000);
}

const server = http.createServer((req, res) => { handle(req, res); });
server.keepAliveTimeout = 65000;
server.listen(PORT, () => console.log(`야외 마피아 서버 실행 중: http://localhost:${PORT} (저장: ${store.kind})`));

module.exports = { server };

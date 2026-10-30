'use strict';
// Vercel 서버리스 함수. vercel.json이 /api/*, /print, /qr.svg 요청을 이곳으로 보냅니다.
const { createStore } = require('../lib/store');
const { createHandler } = require('../lib/handler');

module.exports = createHandler(createStore());

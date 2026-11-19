'use strict';
// 의존성 없는 QR 코드 생성기 (바이트 모드, 오류정정 M, 버전 1~10).
// 출력: SVG 문자열. 인쇄용 이름표·장소 카드에 사용합니다.

const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const NUM_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];

function rawModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}
function dataCodewords(ver) {
  return Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];
}
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}
function rsDivisor(degree) {
  const r = new Array(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = gfMul(r[j], root);
      if (j + 1 < r.length) r[j] ^= r[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return r;
}
function rsRemainder(data, div) {
  const r = div.map(() => 0);
  for (const b of data) {
    const f = b ^ r.shift();
    r.push(0);
    div.forEach((c, i) => { r[i] ^= gfMul(c, f); });
  }
  return r;
}

function encode(text) {
  const bytes = Array.from(Buffer.from(String(text), 'utf8'));
  let ver = 1;
  for (; ver <= 10; ver++) {
    const ccBits = ver < 10 ? 8 : 16;
    if (4 + ccBits + bytes.length * 8 <= dataCodewords(ver) * 8) break;
  }
  if (ver > 10) throw new Error('QR 내용이 너무 깁니다');
  const ccBits = ver < 10 ? 8 : 16;
  const bits = [];
  const push = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  push(4, 4);
  push(bytes.length, ccBits);
  bytes.forEach(b => push(b, 8));
  const cap = dataCodewords(ver) * 8;
  push(0, Math.min(4, cap - bits.length));
  push(0, (8 - bits.length % 8) % 8);
  for (let p = 0xec; bits.length < cap; p ^= 0xec ^ 0x11) push(p, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    data.push(b);
  }

  // 오류정정과 인터리브
  const nb = NUM_BLOCKS[ver], el = ECC_PER_BLOCK[ver];
  const raw = Math.floor(rawModules(ver) / 8);
  const nShort = nb - raw % nb, shortLen = Math.floor(raw / nb);
  const div = rsDivisor(el);
  const blocks = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const len = shortLen - el + (i < nShort ? 0 : 1);
    const dat = data.slice(k, k + len);
    k += len;
    const ecc = rsRemainder(dat, div);
    if (i < nShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const all = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((b, j) => {
      if (i !== shortLen - el || j >= nShort) all.push(b[i]);
    });
  }

  const size = ver * 4 + 17;
  const mod = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, v) => { mod[y][x] = !!v; fn[y][x] = true; };

  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  if (ver > 1) {
    const n = Math.floor(ver / 7) + 2;
    const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    const pos = [6];
    for (let p = size - 7; pos.length < n; p -= step) pos.splice(1, 0, p);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)
        set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  const drawFormat = (mask) => {
    const d = (0 << 3) | mask; // M = 0
    let r = d;
    for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const b = ((d << 10) | r) ^ 0x5412;
    const g = i => (b >>> i) & 1;
    for (let i = 0; i <= 5; i++) set(8, i, g(i));
    set(8, 7, g(6)); set(8, 8, g(7)); set(7, 8, g(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, g(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, g(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, g(i));
    set(8, size - 8, 1);
  };
  drawFormat(0);
  if (ver >= 7) {
    let r = ver;
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const b = (ver << 12) | r;
    for (let i = 0; i < 18; i++) {
      const bit = (b >>> i) & 1, a = size - 11 + i % 3, c = Math.floor(i / 3);
      set(a, c, bit); set(c, a, bit);
    }
  }
  // 데이터 배치
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - v : v;
      if (!fn[y][x] && i < all.length * 8) {
        mod[y][x] = ((all[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
        i++;
      }
    }
  }
  const maskFn = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0, (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => x * y % 2 + x * y % 3 === 0, (x, y) => (x * y % 2 + x * y % 3) % 2 === 0,
    (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0,
  ];
  const applyMask = (m) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++)
      if (!fn[y][x] && maskFn[m](x, y)) mod[y][x] = !mod[y][x];
  };
  const penalty = () => {
    let p = 0, dark = 0;
    const line = (get) => {
      for (let a = 0; a < size; a++) {
        let run = 1, s = '';
        for (let b = 0; b < size; b++) {
          const v = get(a, b);
          s += v ? '1' : '0';
          if (b > 0) {
            if (v === get(a, b - 1)) { run++; if (run === 5) p += 3; else if (run > 5) p++; }
            else run = 1;
          }
        }
        const t = '0000' + s + '0000';
        for (let k = t.indexOf('1011101'); k !== -1; k = t.indexOf('1011101', k + 1)) {
          if (t.slice(k - 4, k) === '0000' || t.slice(k + 7, k + 11) === '0000') p += 40;
        }
      }
    };
    line((a, b) => mod[a][b]);
    line((a, b) => mod[b][a]);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (mod[y][x]) dark++;
      if (x < size - 1 && y < size - 1) {
        const c = mod[y][x];
        if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) p += 3;
      }
    }
    const total = size * size;
    p += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return p;
  };
  let best = 0, bestP = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m); drawFormat(m);
    const p = penalty();
    if (p < bestP) { bestP = p; best = m; }
    applyMask(m);
  }
  applyMask(best); drawFormat(best);
  return mod;
}

function svg(text, opts = {}) {
  const mod = encode(text);
  const n = mod.length, q = 4, t = n + q * 2;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++)
    if (mod[y][x]) d += `M${x + q} ${y + q}h1v1h-1z`;
  const px = opts.size ? ` width="${opts.size}" height="${opts.size}"` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${t} ${t}"${px} shape-rendering="crispEdges"><rect width="${t}" height="${t}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

// 장소 QR용 '밝은 우주' 디자인(시안 A): 연한 하늘·보라 우주 바탕 + 옅은 별, 남색 동그라미 점.
// 모서리 찾기 무늬 3개는 표준 모양(각진 네모)으로 진하게 둡니다(둥글게 깎으면 인식률이 크게 떨어짐).
// 판독 시험: 어려운 조건 7가지 중 6가지 통과(아주 비스듬히 찍을 때만 실패). 그래서 정면에서 찍는 장소 QR에만 씁니다.
let artId = 0;
function artSvg(text) {
  const mod = encode(text);
  const n = mod.length, q = 4, t = n + q * 2, id = 'qa' + (++artId), NAVY = '#0d1b4f';
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let stars = '';
  for (let i = 0; i < 70; i++) stars += `<circle cx="${(rnd() * t).toFixed(2)}" cy="${(rnd() * t).toFixed(2)}" r="${(0.08 + rnd() * 0.18).toFixed(2)}" fill="#9fc4ff" opacity="${(0.35 + rnd() * 0.4).toFixed(2)}"/>`;
  const inFinder = (x, y) => (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);
  const finder = (x, y) => `<rect x="${x + 0.5}" y="${y + 0.5}" width="6" height="6" rx="0.25" fill="none" stroke="${NAVY}" stroke-width="1"/><rect x="${x + 2}" y="${y + 2}" width="3" height="3" rx="0.15" fill="${NAVY}"/>`;
  let dots = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (mod[y][x] && !inFinder(x, y)) dots += `<circle cx="${x + q + 0.5}" cy="${y + q + 0.5}" r="0.5"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${t} ${t}"><defs>`
    + `<radialGradient id="${id}a" cx="25%" cy="20%" r="60%"><stop offset="0" stop-color="#e9ddff"/><stop offset="1" stop-color="#e9ddff" stop-opacity="0"/></radialGradient>`
    + `<radialGradient id="${id}b" cx="80%" cy="85%" r="55%"><stop offset="0" stop-color="#d5f3ff"/><stop offset="1" stop-color="#d5f3ff" stop-opacity="0"/></radialGradient></defs>`
    + `<rect width="${t}" height="${t}" fill="#f3f8ff"/><rect width="${t}" height="${t}" fill="url(#${id}a)"/><rect width="${t}" height="${t}" fill="url(#${id}b)"/>${stars}`
    + finder(q, q) + finder(q + n - 7, q) + finder(q, q + n - 7)
    + `<g fill="${NAVY}">${dots}</g></svg>`;
}

module.exports = { encode, svg, artSvg };

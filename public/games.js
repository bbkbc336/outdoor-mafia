// 임무 미니게임 10종. 설명 없이 화면만 보고 알 수 있게: 목표가 보이고, 조작은 한 가지, 첫 동작은 반짝임.
// 한 판은 약 20초 분량입니다(한 번에 끝나는 한 판, 양과 난이도로 조절). 머리글 오른쪽에 진행 상황이 보입니다.
// Games.open({ game, data }, onWin(result)) — 문제(data)는 서버가 만들고, 결과는 서버가 다시 확인합니다.
'use strict';

const Games = (() => {
  const TITLE = {
    fire: '🔥 불을 모두 끄세요',
    power: '🔌 같은 색끼리 이으세요',
    lock: '🔐 다이얼을 돌려 맞추세요',
    order: '🔢 1부터 차례로 누르세요',
    lens: '🧽 문질러서 닦으세요',
    sort: '📦 같은 색 칸으로 옮기세요',
    level: '⚡ 막대를 점선에 맞추세요',
    shape: '🧩 같은 모양·색에 끼우세요',
    mole: '🐭 튀어나온 쥐를 누르세요',
    cards: '🃏 같은 그림 두 장을 찾으세요',
  };
  const COLOR = { red: '#ff4d5e', blue: '#4da3ff', yellow: '#ffd23f', green: '#3ddc84' };
  const shake = (el) => { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); buzz([40, 40, 40]); };
  const tick = () => buzz(20);
  const h = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

  // 누르기: 손가락을 뗄 때(pointerup) 바로 처리합니다. 브라우저가 click을 만들지 않는 경우가 있어서입니다.
  // 마우스·키보드는 click으로도 동작하고, 한 번 누름이 두 번 처리되지 않게 막습니다.
  function onTap(el, fn) {
    let down = null, fired = 0;
    el.addEventListener('pointerdown', (e) => { down = { id: e.pointerId, x: e.clientX, y: e.clientY }; });
    el.addEventListener('pointercancel', () => { down = null; });
    el.addEventListener('pointerup', (e) => {
      const d = down; down = null;
      if (!d || d.id !== e.pointerId || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 24) return;
      fired = Date.now(); fn();
    });
    el.addEventListener('click', () => { if (Date.now() - fired > 800) fn(); });
  }

  let root = null, done = false;

  function close() { if (root) root.remove(); root = null; }

  function open(info, onWin) {
    close();
    done = false;
    root = h('div', 'game');
    root.innerHTML = `<div class="ghead"><b>${TITLE[info.game] || '임무'}</b><span class="gstep"></span><button class="gx" aria-label="닫기">✕</button></div><div class="gbody"></div>`;
    onTap(root.querySelector('.gx'), close);
    document.body.appendChild(root);
    const body = root.querySelector('.gbody');
    const win = (result) => {
      if (done) return;
      done = true; buzz([60, 40, 120]);
      // 완료: 체크 표시와 함께 반짝이가 사방으로 튑니다.
      const w = h('div', 'gwin', '✅');
      for (let i = 0; i < 16; i++) {
        const a = i / 16 * Math.PI * 2, dist = 120 + Math.random() * 90;
        const sp = h('span', 'spark', ['✨', '🎉', '⭐', '💚'][i % 4]);
        sp.style.setProperty('--dx', Math.cos(a) * dist + 'px'); sp.style.setProperty('--dy', Math.sin(a) * dist + 'px');
        sp.style.setProperty('--r', (Math.random() * 360 - 180) + 'deg');
        w.appendChild(sp);
      }
      body.appendChild(w);
      setTimeout(() => { close(); onWin(result); }, 700);
    };
    const step = root.querySelector('.gstep');
    win.step = (t) => {
      if (step.textContent === t) return;
      const first = !step.textContent;
      step.textContent = t;
      if (!first) { step.classList.remove('bump'); void step.offsetWidth; step.classList.add('bump'); }
    };
    (BUILD[info.game] || (() => { body.textContent = '알 수 없는 게임입니다.'; }))(body, info.data || {}, win);
  }

  // 손가락으로 끌기. 놓은 곳의 요소를 onDrop(대상, 움직였는지)으로 알려 줍니다.
  function draggable(el, onDrop) {
    el.addEventListener('pointerdown', (e) => {
      if (done) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const sx = e.clientX, sy = e.clientY;
      el.classList.add('dragging');
      const move = (ev) => { el.style.transform = `translate(${ev.clientX - sx}px, ${ev.clientY - sy}px) scale(1.1)`; };
      const up = (ev) => {
        el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
        el.classList.remove('dragging');
        el.style.visibility = 'hidden';
        const target = document.elementFromPoint(ev.clientX, ev.clientY);
        el.style.visibility = ''; el.style.transform = '';
        onDrop(target, Math.hypot(ev.clientX - sx, ev.clientY - sy) > 12);
      };
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    });
  }

  const shapeSvg = (s, filled) => {
    const st = filled ? `fill="currentColor"` : `fill="none" stroke="currentColor" stroke-width="5" stroke-dasharray="9 7"`;
    const d = s === 'circle' ? `<circle cx="50" cy="50" r="38" ${st}/>`
      : s === 'triangle' ? `<polygon points="50,10 90,86 10,86" ${st} stroke-linejoin="round"/>`
      : s === 'star' ? `<polygon points="50,8 61,38 93,38 67,57 77,89 50,70 23,89 33,57 7,38 39,38" ${st} stroke-linejoin="round"/>`
      : s === 'diamond' ? `<polygon points="50,6 92,50 50,94 8,50" ${st} stroke-linejoin="round"/>`
      : `<rect x="14" y="14" width="72" height="72" rx="6" ${st}/>`;
    return `<svg viewBox="0 0 100 100">${d}</svg>`;
  };

  const BUILD = {
    // 1. 불꽃 12개를 눌러 끄기. 한 번에 안 꺼지고 작아지며, 꺼진 불이 가끔 다시 붙습니다.
    fire(body, d, win) {
      const area = h('div', 'garea fire');
      const hp = d.hp || 1, SIZE = [0, 26, 34, 42];
      let out = 0, relit = 0;
      const flames = d.spots.map((p, i) => {
        const b = h('button', 'flame' + (i === 0 ? ' hint' : ''), '🔥');
        b.style.left = p.x + '%'; b.style.top = p.y + '%';
        b.hp = hp;
        const draw = () => { b.style.fontSize = SIZE[Math.min(3, b.hp)] + 'px'; };
        draw();
        onTap(b, () => {
          if (done || b.hp <= 0) return;
          area.querySelectorAll('.hint').forEach(x => x.classList.remove('hint'));
          tick();
          if (--b.hp > 0) return draw();
          b.classList.add('out'); b.textContent = '💨';
          if (++out === d.spots.length) return win({ out });
          // 다시 붙는 불: 판마다 최대 4번, 2.5초 뒤
          if (relit < 4 && out % 3 === 0) {
            relit++;
            setTimeout(() => {
              if (done) return;
              const dead = flames.filter(f => f.hp <= 0 && f !== b);
              const f = dead[Math.floor(Math.random() * dead.length)];
              if (!f) return;
              f.hp = 2; f.classList.remove('out'); f.textContent = '🔥'; f.style.fontSize = SIZE[2] + 'px'; out--;
              buzz([30, 30, 30]);
            }, 2500);
          }
        });
        area.appendChild(b);
        return b;
      });
      body.appendChild(area);
    },

    // 2. 왼쪽 색 점을 오른쪽 같은 색 점까지 끌어서 전선 잇기 (점을 차례로 눌러도 됨). 8쌍.
    power(body, d, win) {
      const WIRE = { red: '#ff4d5e', orange: '#ff9f1c', yellow: '#ffd23f', green: '#3ddc84', blue: '#4da3ff', purple: '#b07cff', pink: '#ff7ad9', white: '#f4f6fb' };
      const box = h('div', 'wires');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      box.appendChild(svg);
      const links = [];
      const mk = (side, c, i) => {
        const e = h('div', 'wdot ' + side + (side === 'l' && i === 0 ? ' hint' : ''));
        e.style.background = WIRE[c]; e.style.top = ((i + 0.5) / d.left.length * 100) + '%';
        e.dataset.i = i; e.dataset.c = c;
        box.appendChild(e);
        return e;
      };
      const L = d.left.map((c, i) => mk('l', c, i)), R = d.right.map((c, i) => mk('r', c, i));
      const mid = (e) => { const b = box.getBoundingClientRect(), r = e.getBoundingClientRect(); return [r.left + r.width / 2 - b.left, r.top + r.height / 2 - b.top]; };
      const line = (c, [x1, y1], [x2, y2]) => {
        const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        Object.entries({ x1, y1, x2, y2, stroke: WIRE[c], 'stroke-width': 12, 'stroke-linecap': 'round' }).forEach(([k, v]) => ln.setAttribute(k, v));
        svg.appendChild(ln);
        return ln;
      };
      let picked = null;
      const connect = (l, r) => {
        picked = null; L.forEach(x => x.classList.remove('sel'));
        if (!r || r.classList.contains('done') || l.classList.contains('done')) return;
        if (r.dataset.c !== l.dataset.c) return shake(r);
        l.classList.add('done'); r.classList.add('done');
        line(l.dataset.c, mid(l), mid(r)).classList.add('fresh');
        links.push([Number(l.dataset.i), Number(r.dataset.i)]); tick();
        win.step(`${links.length}/${d.left.length}`);
        if (links.length === d.left.length) win({ links });
      };
      L.forEach(l => {
        l.addEventListener('pointerdown', (e) => {
          if (done || l.classList.contains('done')) return;
          e.preventDefault();
          l.setPointerCapture(e.pointerId);
          box.querySelectorAll('.hint').forEach(x => x.classList.remove('hint'));
          const from = mid(l), sx = e.clientX, sy = e.clientY;
          const tmp = line(l.dataset.c, from, from);
          tmp.setAttribute('opacity', '0.6');
          const b = box.getBoundingClientRect();
          const move = (ev) => { tmp.setAttribute('x2', ev.clientX - b.left); tmp.setAttribute('y2', ev.clientY - b.top); };
          const up = (ev) => {
            l.removeEventListener('pointermove', move); l.removeEventListener('pointerup', up); l.removeEventListener('pointercancel', up);
            tmp.remove();
            if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 12) { L.forEach(x => x.classList.remove('sel')); picked = l; l.classList.add('sel'); return; }
            const t = document.elementFromPoint(ev.clientX, ev.clientY);
            const r = t && t.closest && t.closest('.wdot.r');
            if (r) connect(l, r); else shake(l);
          };
          l.addEventListener('pointermove', move); l.addEventListener('pointerup', up); l.addEventListener('pointercancel', up);
        });
      });
      R.forEach(r => onTap(r, () => { if (picked) connect(picked, r); }));
      win.step(`0/${d.left.length}`);
      body.appendChild(box);
    },

    // 3. 다이얼을 돌려 화살표(▼)를 위에 보이는 숫자 6개에 차례로 맞추기. 손을 떼면 가까운 숫자에 멈춥니다.
    lock(body, d, win) {
      const N = 20, STEP = 360 / N;
      const goal = h('div', 'dialgoal', d.code.map((n, i) => `<span class="${i === 0 ? 'hint' : ''}">${n}</span>`).join(''));
      const wrap = h('div', 'dialwrap', '<div class="dialarrow">▼</div>');
      const dial = h('div', 'dial');
      dial.innerHTML = [...Array(N)].map((_, i) => `<span style="transform:rotate(${i * STEP}deg)"><b>${i}</b></span>`).join('') + '<div class="dialnow">0</div>';
      wrap.appendChild(dial);
      const now = dial.querySelector('.dialnow');
      let rot = 0, k = 0, last = null;
      const under = () => ((Math.round(-rot / STEP) % N) + N) % N;
      const draw = () => {
        dial.style.transform = `rotate(${rot}deg)`;
        now.style.transform = `translate(-50%, -50%) rotate(${-rot}deg)`;
        now.textContent = under();
      };
      const ang = (e) => { const r = dial.getBoundingClientRect(); return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180 / Math.PI; };
      dial.addEventListener('pointerdown', (e) => {
        if (done) return;
        e.preventDefault(); dial.setPointerCapture(e.pointerId);
        dial.classList.remove('snap'); last = ang(e);
        goal.querySelectorAll('.hint').forEach(x => x.classList.remove('hint'));
      });
      dial.addEventListener('pointermove', (e) => {
        if (last === null || done) return;
        const a = ang(e); let da = a - last; last = a;
        if (da > 180) da -= 360; if (da < -180) da += 360;
        const before = under(); rot += da; draw();
        if (under() !== before) buzz(5);
      });
      const up = () => {
        if (last === null) return;
        last = null;
        rot = Math.round(rot / STEP) * STEP; dial.classList.add('snap'); draw();
        if (under() !== d.code[k]) return;
        goal.children[k].classList.add('ok'); tick();
        now.classList.remove('ok'); void now.offsetWidth; now.classList.add('ok');
        if (++k === d.code.length) return win({ seq: d.code.slice() });
      };
      dial.addEventListener('pointerup', up); dial.addEventListener('pointercancel', up);
      draw();
      body.append(goal, wrap);
    },

    // 4. 1부터 25까지 차례로. 처음 1만 반짝입니다.
    order(body, d, win) {
      const grid = h('div', 'ggrid g5 order');
      let next = 1; const seq = [], N = d.layout.length;
      d.layout.forEach(n => {
        const b = h('button', n === 1 ? 'hint' : '', String(n));
        onTap(b, () => {
          if (b.classList.contains('ok') || done) return;
          if (n !== next) return shake(b);
          b.classList.add('ok'); b.classList.remove('hint'); seq.push(n); tick();
          win.step(`${next}/${N}`);
          if (++next > N) win({ seq });
        });
        grid.appendChild(b);
      });
      win.step(`0/${N}`);
      body.appendChild(grid);
    },

    // 5. 먼지가 두껍게 낀 렌즈를 문질러 닦기. 한 번에 다 안 지워져 여러 번 문질러야 합니다.
    lens(body, d, win) {
      const area = h('div', 'garea lens', '<div class="view">🪐<span>✨</span></div><canvas></canvas><div class="finger">👆</div>');
      body.appendChild(area);
      const cv = area.querySelector('canvas'), finger = area.querySelector('.finger');
      const W = area.clientWidth, H = area.clientHeight;
      cv.width = W; cv.height = H;
      const g = cv.getContext('2d');
      g.fillStyle = '#7a6a55'; g.fillRect(0, 0, W, H);
      for (let i = 0; i < 900; i++) { // 먼지 얼룩
        g.fillStyle = `rgba(${60 + Math.random() * 80},${50 + Math.random() * 60},${30 + Math.random() * 40},0.5)`;
        g.beginPath(); g.arc(Math.random() * W, Math.random() * H, 2 + Math.random() * 10, 0, 7); g.fill();
      }
      g.globalCompositeOperation = 'destination-out';
      g.lineCap = 'round'; g.lineJoin = 'round'; g.lineWidth = Math.max(40, W / 8);
      let last = null, checkAt = 0;
      const pos = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
      // 둥근 렌즈 안쪽만 셉니다(바깥 모서리는 손가락이 닿지 않음).
      const R2 = (Math.min(W, H) / 2 - 4) ** 2;
      const cleaned = () => {
        const px = g.getImageData(0, 0, W, H).data; let clear = 0, n = 0;
        for (let i = 3; i < px.length; i += 4 * 37) {
          const k = (i - 3) / 4, x = k % W - W / 2, y = Math.floor(k / W) - H / 2;
          if (x * x + y * y > R2) continue;
          n++; if (px[i] < 40) clear++;
        }
        return clear / n;
      };
      win.step('0%');
      // 아주 빨리 문질러도 더 많이 지워지지 않게, 손가락 속도가 SPEED(px/초)를 넘으면 그만큼 덜 지웁니다.
      const SPEED = d.speed || 1e9;
      let lastT = 0;
      cv.addEventListener('pointerdown', (e) => { if (done) return; cv.setPointerCapture(e.pointerId); last = pos(e); lastT = e.timeStamp; finger.remove(); });
      cv.addEventListener('pointermove', (e) => {
        if (!last || done) return;
        const p = pos(e), len = Math.hypot(p[0] - last[0], p[1] - last[1]), dt = Math.max(1, e.timeStamp - lastT);
        g.globalAlpha = (d.wipe || 1) * Math.min(1, SPEED / (len / dt * 1000));
        g.beginPath(); g.moveTo(last[0], last[1]); g.lineTo(p[0], p[1]); g.stroke();
        last = p; lastT = e.timeStamp;
        if (Date.now() > checkAt) {
          checkAt = Date.now() + 150;
          const c = cleaned();
          win.step(Math.min(100, Math.floor(c / 0.88 * 100)) + '%');
          if (c >= 0.88) { g.clearRect(0, 0, W, H); area.classList.add('clean'); win({ clean: c }); }
        }
      });
      const end = () => { last = null; };
      cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
    },

    // 6. 위에서 오는 상자 16개를 같은 색 칸으로 끌어 넣기 (칸을 눌러도 됨)
    sort(body, d, win) {
      let i = 0; const bins = [];
      const top = h('div', 'sorttop');
      const queue = h('div', 'queue');
      const bottom = h('div', 'bins b4');
      Object.keys(COLOR).forEach(c => {
        const b = h('div', 'bin', '');
        b.dataset.color = c; b.style.borderColor = COLOR[c]; b.style.background = COLOR[c] + '33';
        onTap(b, () => drop(c));
        bottom.appendChild(b);
      });
      const drawQueue = () => {
        top.innerHTML = '';
        win.step(`${i}/${d.boxes.length}`);
        if (i >= d.boxes.length) return;
        const box = h('div', 'crate', '📦');
        box.style.background = COLOR[d.boxes[i]];
        draggable(box, (t, moved) => { const bin = t && t.closest && t.closest('.bin'); if (bin) drop(bin.dataset.color); else if (moved) shake(box); });
        top.appendChild(box);
        queue.innerHTML = d.boxes.slice(i + 1, i + 7).map(c => `<span style="background:${COLOR[c]}"></span>`).join('');
        bottom.querySelectorAll('.bin').forEach(b => b.classList.toggle('hint', i === 0 && b.dataset.color === d.boxes[0]));
      };
      const drop = (c) => {
        if (done || i >= d.boxes.length) return;
        if (c !== d.boxes[i]) return shake(top.firstChild || top);
        bins.push(c); i++; tick();
        const bin = bottom.querySelector(`[data-color="${c}"]`);
        bin.textContent = '📦'.repeat(Math.min(6, bins.filter(x => x === c).length));
        bin.classList.remove('got'); void bin.offsetWidth; bin.classList.add('got');
        drawQueue();
        if (i === d.boxes.length) win({ bins });
      };
      drawQueue();
      body.append(queue, top, bottom);
    },

    // 7. 천천히 오르내리는 점선을 막대로 따라가기. 점선에 맞춰 둔 동안 아래 칸이 차고, 다 차면 그 막대는 고정됩니다.
    level(body, d, win) {
      const wrap = h('div', 'levels');
      const TOL = 7;
      let locked = 0, lastTs = performance.now();
      const mine = root; // 이 게임 화면이 닫히면 움직임을 멈춥니다(다음 게임에 영향 없게).
      const bars = d.targets.map((t, k) => {
        const col = h('div', 'lvcol');
        const track = h('div', 'track' + (k === 0 ? ' hint' : ''), '<div class="target"></div><div class="fill"></div>');
        const meter = h('div', 'lvmeter', '<div></div>');
        col.append(track, meter);
        wrap.appendChild(col);
        const bar = { t, track, fill: track.querySelector('.fill'), line: track.querySelector('.target'), meter: meter.firstChild, v: 0, held: 0, pos: t.base, done: false };
        const set = (e) => {
          const r = track.getBoundingClientRect();
          bar.v = Math.round(Math.max(0, Math.min(100, (r.bottom - e.clientY) / r.height * 100)));
          bar.fill.style.height = bar.v + '%';
        };
        track.addEventListener('pointerdown', (e) => { if (done || bar.done) return; e.preventDefault(); track.setPointerCapture(e.pointerId); wrap.querySelectorAll('.hint').forEach(x => x.classList.remove('hint')); set(e); bar.drag = true; });
        track.addEventListener('pointermove', (e) => { if (bar.drag && !done && !bar.done) set(e); });
        const up = () => { bar.drag = false; };
        track.addEventListener('pointerup', up); track.addEventListener('pointercancel', up);
        return bar;
      });
      const frame = (ts) => {
        if (root !== mine || done) return;
        const dt = Math.min(100, ts - lastTs); lastTs = ts;
        bars.forEach(b => {
          if (b.done) return;
          b.pos = b.t.base + b.t.amp * Math.sin(ts / b.t.period * Math.PI * 2 + b.t.phase);
          b.line.style.bottom = b.pos + '%';
          const ok = Math.abs(b.v - b.pos) <= TOL;
          b.track.classList.toggle('ok', ok);
          if (ok) b.held += dt;
          b.meter.style.width = Math.min(100, b.held / d.hold * 100) + '%';
          if (b.held >= d.hold) {
            b.done = true; b.drag = false; b.track.classList.add('ok', 'locked'); tick();
            win.step(`${++locked}/${bars.length}`);
            if (locked === bars.length) win({ locked });
          }
        });
        requestAnimationFrame(frame);
      };
      win.step(`0/${bars.length}`);
      body.appendChild(wrap);
      requestAnimationFrame(frame);
    },

    // 8. 조각을 모양과 색이 같은 구멍으로 끌기 (조각을 누르고 구멍을 눌러도 됨). 한 판에 8조각.
    shape(body, d, win) {
      const PART = { blue: '#4da3ff', orange: '#ff9f1c' };
      const key = (x) => x.s + '-' + x.c;
      const pieces = h('div', 'shapes');
      const holes = h('div', 'shapes holes');
      const placed = []; let picked = null;
      d.holes.forEach(x => {
        const hole = h('div', 'hole', shapeSvg(x.s, false));
        hole.dataset.key = key(x); hole.style.color = PART[x.c];
        onTap(hole, () => { if (picked) put(picked, hole); });
        holes.appendChild(hole);
      });
      const put = (piece, hole) => {
        if (hole.dataset.key !== piece.dataset.key || hole.classList.contains('full')) { picked = null; piece.classList.remove('sel'); return shake(piece); }
        hole.classList.add('full'); hole.innerHTML = shapeSvg(hole.dataset.key.split('-')[0], true);
        piece.remove(); picked = null; placed.push(hole.dataset.key); tick();
        win.step(`${placed.length}/${d.holes.length}`);
        if (placed.length === d.holes.length) win({ placed });
      };
      d.pieces.forEach((x, k) => {
        const p = h('div', 'piece' + (k === 0 ? ' hint' : ''), shapeSvg(x.s, true));
        p.dataset.key = key(x); p.style.color = PART[x.c];
        draggable(p, (t, moved) => {
          pieces.querySelectorAll('.hint').forEach(y => y.classList.remove('hint'));
          const hole = t && t.closest && t.closest('.hole');
          if (hole) return put(p, hole);
          if (!moved) { pieces.querySelectorAll('.sel').forEach(y => y.classList.remove('sel')); picked = p; p.classList.add('sel'); }
        });
        pieces.appendChild(p);
      });
      win.step(`0/${d.holes.length}`);
      body.append(pieces, h('div', 'arrow', '⬇'), holes);
    },

    // 9. 구멍에서 튀어나온 쥐 20마리를 눌러 잡기. 놓친 쥐는 들어가고 다음 쥐가 나옵니다.
    mole(body, d, win) {
      const grid = h('div', 'ggrid g3 mole');
      const mine = root;
      const holes = [...Array(9)].map(() => { const b = h('button', 'hole9', '<span></span>'); grid.appendChild(b); return b; });
      const hits = [];
      let k = -1, up = -1, timer = 0;
      const next = (wait) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (root !== mine || done) return;
          if (up >= 0) holes[up].classList.remove('up');
          k++; up = d.seq[k % d.seq.length];
          holes[up].classList.add('up'); holes[up].firstChild.textContent = '🐭';
          if (k === 0) holes[up].classList.add('hint');
          timer = setTimeout(() => { if (root !== mine || done) return; holes[up].classList.remove('up'); up = -1; next(250); }, d.show);
        }, wait);
      };
      holes.forEach((b, i) => onTap(b, () => {
        if (done || root !== mine) return;
        if (i !== up) return; // 빈 구멍은 무시
        b.classList.remove('hint');
        b.firstChild.textContent = '💥'; b.classList.add('hit'); tick();
        setTimeout(() => b.classList.remove('up', 'hit'), 180);
        up = -1; hits.push(k);
        win.step(`${hits.length}/${d.hits}`);
        if (hits.length === d.hits) { clearTimeout(timer); return win({ hits }); }
        next(300);
      }));
      win.step(`0/${d.hits}`);
      body.appendChild(grid);
      next(500);
    },

    // 10. 카드를 두 장씩 뒤집어 같은 그림 찾기. 다르면 잠깐 보여 주고 다시 덮습니다.
    cards(body, d, win) {
      const grid = h('div', 'ggrid g4 cards');
      const pairs = []; let open = [], lock = false;
      d.deck.forEach((ic, i) => {
        const c = h('button', 'card9' + (i === 0 ? ' hint' : ''), `<span>${ic}</span>`);
        onTap(c, () => {
          if (done || lock || c.classList.contains('up')) return;
          grid.querySelectorAll('.hint').forEach(x => x.classList.remove('hint'));
          c.classList.add('up'); buzz(10);
          open.push(i);
          if (open.length < 2) return;
          const [a, b] = open; open = [];
          if (d.deck[a] === d.deck[b]) {
            pairs.push([a, b]); tick();
            [a, b].forEach(j => grid.children[j].classList.add('ok'));
            win.step(`${pairs.length}/${d.deck.length / 2}`);
            if (pairs.length === d.deck.length / 2) win({ pairs });
            return;
          }
          lock = true;
          setTimeout(() => { [a, b].forEach(j => grid.children[j].classList.remove('up')); lock = false; }, 700);
        });
        grid.appendChild(c);
      });
      win.step(`0/${d.deck.length / 2}`);
      body.appendChild(grid);
    },
  };

  return { open, close, TITLE };
})();

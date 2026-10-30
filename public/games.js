// 임무 미니게임 8종. 설명 없이 화면만 보고 알 수 있게: 목표가 보이고, 조작은 한 가지, 첫 동작은 반짝임.
// 한 판은 약 20초 분량입니다. 여러 단계인 게임은 머리글 오른쪽에 진행 단계(1/3)가 보입니다.
// Games.open({ game, data }, onWin(result)) — 문제(data)는 서버가 만들고, 결과는 서버가 다시 확인합니다.
'use strict';

const Games = (() => {
  const TITLE = {
    fire: '🔥 불을 모두 끄세요',
    power: '💡 깜빡인 순서대로',
    lock: '🔐 같은 번호를 누르세요',
    order: '🔢 1부터 차례로 누르세요',
    lens: '🧽 문질러서 닦으세요',
    sort: '📦 같은 색 칸으로 옮기세요',
    level: '⚡ 막대를 점선에 맞추세요',
    shape: '🧩 같은 모양에 끼우세요',
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
      body.appendChild(h('div', 'gwin', '✅'));
      setTimeout(() => { close(); onWin(result); }, 700);
    };
    const step = root.querySelector('.gstep');
    win.step = (t) => { step.textContent = t; };
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
    // 1. 불꽃을 눌러 끄기. 한 번에 안 꺼지고 작아지며, 꺼진 불이 가끔 다시 붙습니다.
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
          // 다시 붙는 불: 판마다 최대 3번, 2.5초 뒤
          if (relit < 3 && out % 3 === 0) {
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

    // 2. 전구 네 개가 깜빡인 순서를 그대로 누르기. 판마다 하나씩 길어집니다(3→6).
    power(body, d, win) {
      const grid = h('div', 'ggrid g2 simon');
      const LAMP = ['#ff4d5e', '#3ddc84', '#4da3ff', '#ffd23f'];
      let round = 0, input = 0, lock = true, timers = [];
      const pads = LAMP.map((c, i) => {
        const b = h('button', 'pad', '💡');
        b.style.setProperty('--c', c);
        onTap(b, () => press(i));
        grid.appendChild(b);
        return b;
      });
      const flash = (i, ms) => { pads[i].classList.add('lit'); timers.push(setTimeout(() => pads[i].classList.remove('lit'), ms)); };
      const show = () => {
        lock = true; input = 0;
        const n = d.rounds[round];
        win.step(`👀 ${round + 1}/${d.rounds.length}`);
        for (let k = 0; k < n; k++) timers.push(setTimeout(() => flash(d.seq[k], 380), 700 + k * 600));
        timers.push(setTimeout(() => { lock = false; win.step(`👆 ${round + 1}/${d.rounds.length}`); }, 700 + n * 600));
      };
      const press = (i) => {
        if (lock || done || !root) return;
        flash(i, 160);
        if (i !== d.seq[input]) { shake(grid); return show(); }
        tick();
        if (++input < d.rounds[round]) return;
        if (++round === d.rounds.length) { lock = true; return win({ seq: d.seq.slice() }); }
        lock = true; timers.push(setTimeout(show, 450));
      };
      body.appendChild(grid);
      show();
    },

    // 3. 위에 보이는 번호를 키패드로 그대로 입력. 문 네 개(4·5·6·6자리).
    lock(body, d, win) {
      const show = h('div', 'lcd');
      const slots = h('div', 'slots');
      let door = 0, typed = '';
      const code = () => d.codes[door];
      const draw = () => {
        show.innerHTML = code().split('').map(c => `<span>${c}</span>`).join('');
        slots.innerHTML = code().split('').map((_, i) => `<span class="${typed[i] ? 'f' : ''}">${typed[i] || ''}</span>`).join('');
        win.step(`🚪 ${door + 1}/${d.codes.length}`);
      };
      const pad = h('div', 'ggrid g3 keypad');
      ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].forEach(k => {
        const b = h('button', k === '' ? 'blank' : '', k);
        if (k === d.codes[0][0]) b.classList.add('hint');
        onTap(b, () => {
          if (!k || done) return;
          pad.querySelectorAll('.hint').forEach(x => x.classList.remove('hint'));
          if (k === '⌫') typed = typed.slice(0, -1);
          else if (typed.length < code().length) typed += k;
          buzz(10); draw();
          if (typed.length < code().length) return;
          if (typed !== code()) { shake(slots); setTimeout(() => { typed = ''; draw(); }, 350); return; }
          tick();
          if (++door === d.codes.length) return win({ codes: d.codes.slice() });
          typed = ''; setTimeout(draw, 250);
        });
        pad.appendChild(b);
      });
      draw();
      body.append(show, slots, pad);
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

    // 5. 먼지 덮인 렌즈 세 개를 차례로 문질러 닦기. 두껍게 낀 먼지는 여러 번 문질러야 지워집니다.
    lens(body, d, win) {
      const results = [];
      const area = h('div', 'garea lens');
      body.appendChild(area);
      const VIEWS = ['🪐', '🌙', '🌍', '☄️'];
      const next = () => {
        const k = results.length;
        win.step(`🔭 ${k + 1}/${d.n}`);
        area.innerHTML = `<div class="view">${VIEWS[k % VIEWS.length]}<span>✨</span></div><canvas></canvas>${k === 0 ? '<div class="finger">👆</div>' : ''}`;
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
        g.globalAlpha = 0.75; // 한 번에 다 안 닦이고 두 번쯤 문질러야 깨끗해짐
        g.lineCap = 'round'; g.lineJoin = 'round'; g.lineWidth = Math.max(40, W / 8);
        let last = null, checkAt = 0, finished = false;
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
        cv.addEventListener('pointerdown', (e) => { if (done || finished) return; cv.setPointerCapture(e.pointerId); last = pos(e); if (finger) finger.remove(); });
        cv.addEventListener('pointermove', (e) => {
          if (!last || done || finished) return;
          const p = pos(e);
          g.beginPath(); g.moveTo(last[0], last[1]); g.lineTo(p[0], p[1]); g.stroke();
          last = p;
          if (Date.now() > checkAt) {
            checkAt = Date.now() + 150;
            const c = cleaned();
            if (c >= 0.88) {
              finished = true; g.clearRect(0, 0, W, H); results.push(c); tick();
              if (results.length === d.n) win({ clean: results });
              else setTimeout(next, 450);
            }
          }
        });
        const end = () => { last = null; };
        cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
      };
      next();
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
        drawQueue();
        if (i === d.boxes.length) win({ bins });
      };
      drawQueue();
      body.append(queue, top, bottom);
    },

    // 7. 막대를 끌어 올려 점선 높이에 맞추기. 세 개씩 세 판.
    level(body, d, win) {
      const wrap = h('div', 'levels');
      body.appendChild(wrap);
      const values = [];
      const round = (r) => {
        win.step(`${r + 1}/3`);
        wrap.innerHTML = '';
        const tg = d.targets.slice(r * 3, r * 3 + 3), vs = [0, 0, 0];
        const ok = (k) => Math.abs(vs[k] - tg[k]) <= 5;
        let finished = false;
        tg.forEach((t, k) => {
          const track = h('div', 'track' + (r === 0 && k === 0 ? ' hint' : ''), `<div class="target" style="bottom:${t}%"></div><div class="fill"></div>`);
          const fill = track.querySelector('.fill');
          const set = (e) => {
            const rc = track.getBoundingClientRect();
            vs[k] = Math.round(Math.max(0, Math.min(100, (rc.bottom - e.clientY) / rc.height * 100)));
            fill.style.height = vs[k] + '%';
            track.classList.toggle('ok', ok(k));
          };
          track.addEventListener('pointerdown', (e) => { if (done || finished) return; e.preventDefault(); track.setPointerCapture(e.pointerId); wrap.querySelectorAll('.hint').forEach(x => x.classList.remove('hint')); set(e); track.dragging = true; });
          track.addEventListener('pointermove', (e) => { if (track.dragging && !done && !finished) set(e); });
          const up = () => {
            if (!track.dragging) return;
            track.dragging = false;
            if (ok(k)) tick();
            if (finished || ![0, 1, 2].every(ok)) return;
            finished = true; values.push(...vs);
            if (r === 2) win({ values });
            else setTimeout(() => round(r + 1), 400);
          };
          track.addEventListener('pointerup', up); track.addEventListener('pointercancel', up);
          wrap.appendChild(track);
        });
      };
      round(0);
    },

    // 8. 조각을 같은 모양 구멍으로 끌기 (조각을 누르고 구멍을 눌러도 됨). 네 개씩 세 판.
    shape(body, d, win) {
      const all = [];
      const round = (r) => {
        win.step(`${r + 1}/${d.rounds.length}`);
        body.innerHTML = '';
        const rd = d.rounds[r];
        const pieces = h('div', 'shapes');
        const holes = h('div', 'shapes holes');
        const placed = []; let picked = null;
        rd.holes.forEach(s => {
          const hole = h('div', 'hole', shapeSvg(s, false));
          hole.dataset.shape = s;
          onTap(hole, () => { if (picked) put(picked, hole); });
          holes.appendChild(hole);
        });
        const put = (piece, hole) => {
          if (hole.dataset.shape !== piece.dataset.shape || hole.classList.contains('full')) { picked = null; piece.classList.remove('sel'); return shake(piece); }
          hole.classList.add('full'); hole.innerHTML = shapeSvg(hole.dataset.shape, true);
          piece.remove(); picked = null; placed.push(hole.dataset.shape); tick();
          if (placed.length < rd.holes.length) return;
          all.push(placed);
          if (all.length === d.rounds.length) win({ placed: all });
          else setTimeout(() => round(r + 1), 400);
        };
        rd.pieces.forEach((s, k) => {
          const p = h('div', 'piece' + (r === 0 && k === 0 ? ' hint' : ''), shapeSvg(s, true));
          p.dataset.shape = s;
          draggable(p, (t, moved) => {
            pieces.querySelectorAll('.hint').forEach(x => x.classList.remove('hint'));
            const hole = t && t.closest && t.closest('.hole');
            if (hole) return put(p, hole);
            if (!moved) { pieces.querySelectorAll('.sel').forEach(x => x.classList.remove('sel')); picked = p; p.classList.add('sel'); }
          });
          pieces.appendChild(p);
        });
        body.append(pieces, h('div', 'arrow', '⬇'), holes);
      };
      round(0);
    },
  };

  return { open, close, TITLE };
})();

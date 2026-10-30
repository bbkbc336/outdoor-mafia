// 임무 미니게임 8종. 설명 없이 화면만 보고 알 수 있게: 목표가 보이고, 조작은 한 가지, 첫 동작은 반짝임.
// Games.open({ game, data }, onWin(result)) — 문제(data)는 서버가 만들고, 결과는 서버가 다시 확인합니다.
'use strict';

const Games = (() => {
  const TITLE = {
    fire: '🔥 불을 모두 끄세요',
    power: '🔌 스위치를 모두 켜세요',
    lock: '🔐 같은 번호를 누르세요',
    order: '🔢 1부터 차례로 누르세요',
    lens: '🧽 문질러서 닦으세요',
    sort: '📦 같은 색 칸으로 옮기세요',
    level: '⚡ 막대를 점선에 맞추세요',
    shape: '🧩 같은 모양에 끼우세요',
  };
  const COLOR = { red: '#ff4d5e', blue: '#4da3ff', yellow: '#ffd23f' };
  const shake = (el) => { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); buzz([40, 40, 40]); };
  const tick = () => buzz(20);
  const h = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

  let root = null, done = false;

  function close() { if (root) root.remove(); root = null; }

  function open(info, onWin) {
    close();
    done = false;
    root = h('div', 'game');
    root.innerHTML = `<div class="ghead"><b>${TITLE[info.game] || '임무'}</b><button class="gx" aria-label="닫기">✕</button></div><div class="gbody"></div>`;
    root.querySelector('.gx').onclick = close;
    document.body.appendChild(root);
    const body = root.querySelector('.gbody');
    const win = (result) => {
      if (done) return;
      done = true; buzz([60, 40, 120]);
      body.appendChild(h('div', 'gwin', '✅'));
      setTimeout(() => { close(); onWin(result); }, 700);
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
      : `<rect x="14" y="14" width="72" height="72" rx="6" ${st}/>`;
    return `<svg viewBox="0 0 100 100">${d}</svg>`;
  };

  const BUILD = {
    // 1. 불꽃을 눌러 끄기
    fire(body, d, win) {
      const area = h('div', 'garea fire');
      let out = 0;
      d.spots.forEach((p, i) => {
        const b = h('button', 'flame' + (i === 0 ? ' hint' : ''), '🔥');
        b.style.left = p.x + '%'; b.style.top = p.y + '%';
        b.onclick = () => {
          if (b.classList.contains('out')) return;
          b.classList.add('out'); b.textContent = '💨'; tick();
          area.querySelectorAll('.hint').forEach(x => x.classList.remove('hint'));
          if (++out === d.spots.length) win({ out });
        };
        area.appendChild(b);
      });
      body.appendChild(area);
    },

    // 2. 빨간 OFF 스위치를 모두 초록 ON으로
    power(body, d, win) {
      const grid = h('div', 'ggrid g2');
      let on = 0;
      for (let i = 0; i < d.n; i++) {
        const b = h('button', 'sw' + (i === 0 ? ' hint' : ''), '<span class="lamp"></span>OFF');
        b.onclick = () => {
          if (b.classList.contains('on')) return;
          b.classList.add('on'); b.innerHTML = '<span class="lamp"></span>ON'; tick();
          grid.querySelectorAll('.hint').forEach(x => x.classList.remove('hint'));
          if (++on === d.n) win({ on });
        };
        grid.appendChild(b);
      }
      body.appendChild(grid);
    },

    // 3. 위에 보이는 번호를 키패드로 그대로 입력
    lock(body, d, win) {
      const show = h('div', 'lcd', d.code.split('').map(c => `<span>${c}</span>`).join(''));
      const slots = h('div', 'slots');
      let typed = '';
      const draw = () => { slots.innerHTML = [0, 1, 2, 3].map(i => `<span class="${typed[i] ? 'f' : ''}">${typed[i] || ''}</span>`).join(''); };
      draw();
      const pad = h('div', 'ggrid g3 keypad');
      ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].forEach(k => {
        const b = h('button', k === '' ? 'blank' : '', k);
        if (k === d.code[0]) b.classList.add('hint');
        b.onclick = () => {
          if (!k || done) return;
          pad.querySelectorAll('.hint').forEach(x => x.classList.remove('hint'));
          if (k === '⌫') typed = typed.slice(0, -1);
          else if (typed.length < 4) typed += k;
          buzz(10); draw();
          if (typed.length === 4) {
            if (typed === d.code) win({ code: typed });
            else { shake(slots); setTimeout(() => { typed = ''; draw(); }, 350); }
          }
        };
        pad.appendChild(b);
      });
      body.append(show, slots, pad);
    },

    // 4. 1부터 9까지 차례로. 다음에 누를 숫자가 반짝입니다.
    order(body, d, win) {
      const grid = h('div', 'ggrid g3 order');
      let next = 1; const seq = [];
      const btns = d.layout.map(n => {
        const b = h('button', '', String(n));
        b.onclick = () => {
          if (b.classList.contains('ok')) return;
          if (n !== next) return shake(b);
          b.classList.add('ok'); b.classList.remove('hint'); seq.push(n); tick();
          next++;
          if (next > 9) return win({ seq });
          btns.find(x => x.textContent === String(next)).classList.add('hint');
        };
        grid.appendChild(b);
        return b;
      });
      btns.find(x => x.textContent === '1').classList.add('hint');
      body.appendChild(grid);
    },

    // 5. 먼지 덮인 창을 문질러 닦기
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
      g.lineCap = 'round'; g.lineJoin = 'round'; g.lineWidth = Math.max(44, W / 7);
      let last = null, checkAt = 0;
      const pos = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
      const cleaned = () => {
        const px = g.getImageData(0, 0, W, H).data; let clear = 0, n = 0;
        for (let i = 3; i < px.length; i += 4 * 37) { n++; if (px[i] < 40) clear++; }
        return clear / n;
      };
      cv.addEventListener('pointerdown', (e) => { if (done) return; cv.setPointerCapture(e.pointerId); last = pos(e); finger.remove(); });
      cv.addEventListener('pointermove', (e) => {
        if (!last || done) return;
        const p = pos(e);
        g.beginPath(); g.moveTo(last[0], last[1]); g.lineTo(p[0], p[1]); g.stroke();
        last = p;
        if (Date.now() > checkAt) {
          checkAt = Date.now() + 150;
          const c = cleaned();
          if (c >= 0.88) { g.clearRect(0, 0, W, H); win({ clean: c }); }
        }
      });
      const end = () => { last = null; };
      cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
    },

    // 6. 위에서 오는 상자를 같은 색 칸으로 끌어 넣기 (칸을 눌러도 됨)
    sort(body, d, win) {
      let i = 0; const bins = [];
      const top = h('div', 'sorttop');
      const queue = h('div', 'queue');
      const bottom = h('div', 'bins');
      ['red', 'blue', 'yellow'].forEach(c => {
        const b = h('div', 'bin', '');
        b.dataset.color = c; b.style.borderColor = COLOR[c]; b.style.background = COLOR[c] + '33';
        b.onclick = () => drop(c);
        bottom.appendChild(b);
      });
      const drawQueue = () => {
        top.innerHTML = '';
        if (i >= d.boxes.length) return;
        const box = h('div', 'crate', '📦');
        box.style.background = COLOR[d.boxes[i]];
        draggable(box, (t, moved) => { const bin = t && t.closest && t.closest('.bin'); if (bin) drop(bin.dataset.color); else if (moved) shake(box); });
        top.appendChild(box);
        queue.innerHTML = d.boxes.slice(i + 1).map(c => `<span style="background:${COLOR[c]}"></span>`).join('');
        bottom.querySelectorAll('.bin').forEach(b => b.classList.toggle('hint', i === 0 && b.dataset.color === d.boxes[0]));
      };
      const drop = (c) => {
        if (done || i >= d.boxes.length) return;
        if (c !== d.boxes[i]) return shake(top.firstChild || top);
        bins.push(c); i++; tick();
        const bin = bottom.querySelector(`[data-color="${c}"]`);
        bin.innerHTML = '📦'.repeat(bins.filter(x => x === c).length);
        if (i === d.boxes.length) { drawQueue(); return win({ bins }); }
        drawQueue();
      };
      drawQueue();
      body.append(queue, top, bottom);
    },

    // 7. 막대를 끌어 올려 점선 높이에 맞추기
    level(body, d, win) {
      const wrap = h('div', 'levels');
      const values = [0, 0, 0];
      const ok = (k) => Math.abs(values[k] - d.targets[k]) <= 5;
      d.targets.forEach((t, k) => {
        const track = h('div', 'track' + (k === 0 ? ' hint' : ''), `<div class="target" style="bottom:${t}%"></div><div class="fill"></div>`);
        const fill = track.querySelector('.fill');
        const set = (e) => {
          const r = track.getBoundingClientRect();
          values[k] = Math.round(Math.max(0, Math.min(100, (r.bottom - e.clientY) / r.height * 100)));
          fill.style.height = values[k] + '%';
          track.classList.toggle('ok', ok(k));
        };
        track.addEventListener('pointerdown', (e) => { if (done) return; e.preventDefault(); track.setPointerCapture(e.pointerId); wrap.querySelectorAll('.hint').forEach(x => x.classList.remove('hint')); set(e); track.dragging = true; });
        track.addEventListener('pointermove', (e) => { if (track.dragging && !done) set(e); });
        const up = () => { track.dragging = false; if (ok(k)) tick(); if ([0, 1, 2].every(ok)) win({ values: values.slice() }); };
        track.addEventListener('pointerup', up); track.addEventListener('pointercancel', up);
        wrap.appendChild(track);
      });
      body.appendChild(wrap);
    },

    // 8. 조각을 같은 모양 구멍으로 끌기 (조각을 누르고 구멍을 눌러도 됨)
    shape(body, d, win) {
      const pieces = h('div', 'shapes');
      const holes = h('div', 'shapes holes');
      const placed = []; let picked = null;
      d.holes.forEach(s => {
        const hole = h('div', 'hole', shapeSvg(s, false));
        hole.dataset.shape = s;
        hole.onclick = () => { if (picked) put(picked, hole); };
        holes.appendChild(hole);
      });
      const put = (piece, hole) => {
        if (hole.dataset.shape !== piece.dataset.shape || hole.classList.contains('full')) { picked = null; piece.classList.remove('sel'); return shake(piece); }
        hole.classList.add('full'); hole.innerHTML = shapeSvg(hole.dataset.shape, true);
        piece.remove(); picked = null; placed.push(hole.dataset.shape); tick();
        if (placed.length === 3) win({ placed });
      };
      d.pieces.forEach((s, k) => {
        const p = h('div', 'piece' + (k === 0 ? ' hint' : ''), shapeSvg(s, true));
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
    },
  };

  return { open, close, TITLE };
})();

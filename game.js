'use strict';
/* =========================================================
   體育館對打賽
   - 大廳：用方向鍵控制小人走動，走到球場門口可以加入比賽
   - 桌球：11 分，滑鼠控制球拍，每 2 分換發球
   - 羽球：21 分，方向鍵移動，J 一般回球 / K 殺球 / L 吊球
   - 球的高度用「影子 + 球的大小」表現
   ========================================================= */
(() => {
  const W = 1280, H = 720;
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const $ = (id) => document.getElementById(id);

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rand = (a, b) => a + Math.random() * (b - a);
  const other = (w) => (w === 'p' ? 'c' : 'p');

  const FONT = '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif';
  const NUM = '"Chakra Petch", "Noto Sans TC", monospace';

  const C = {
    wall: '#171c1e', wall2: '#22292c', floor: '#3b8a70',
    line: '#eef3ee', blue: '#2f5fb3', red: '#d0503c', amber: '#f2b23b',
    ink: '#f3f5f2', muted: '#a9b5b0', panel: 'rgba(18,24,26,0.86)',
  };

  /* ---------- 難度設定 ----------
     base：起始球速倍率   inc：第 5 拍後每拍增加多少   max：球速上限
     react：CPU 反應時間（秒）   move：CPU 移動速度   err：CPU 失誤率   reach：CPU 額外擊球範圍 */
  const DIFF = {
    easy:   { label: '簡單', base: 1.0,  inc: 0.06, max: 1.45, react: 0.38, move: 250, err: 0.16, reach: 0 },
    normal: { label: '普通', base: 1.15, inc: 0.07, max: 1.75, react: 0.22, move: 360, err: 0.09, reach: 6 },
    hard:   { label: '困難', base: 1.3,  inc: 0.08, max: 2.1,  react: 0.10, move: 480, err: 0.045, reach: 12 },
  };
  const SPORT = {
    tt: { label: '桌球', target: 11 },
    bd: { label: '羽球', target: 21 },
  };

  /* ---------- 狀態 ---------- */
  let scene = 'lobby';            // lobby | setup | match
  let paused = false;
  let match = null;
  let setupSport = 'tt';
  let lastName = '';
  let lastDiff = 'normal';
  const lastMatch = { tt: null, bd: null }; // 只存在記憶體，關掉網頁就不見
  const fx = [];                  // 落點波紋

  /* ---------- 輸入 ---------- */
  const keys = {};
  const mouse = { x: 640, y: 620, click: false };

  addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) {
      if (e.code === 'Escape') closeSetup();
      return;
    }
    keys[e.code] = true;
    if (e.code.startsWith('Arrow') || e.code === 'Space' || e.code === 'Enter') e.preventDefault();
    if (!e.repeat) onKey(e.code);
  });
  addEventListener('keyup', (e) => { keys[e.code] = false; });
  addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

  canvas.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    mouse.x = (e.clientX - r.left) * W / r.width;
    mouse.y = (e.clientY - r.top) * H / r.height;
  });
  canvas.addEventListener('mousedown', (e) => { if (e.button === 0) mouse.click = true; });

  function onKey(code) {
    if (scene === 'lobby') {
      if ((code === 'Enter' || code === 'Space') && lobby.near) openSetup(lobby.near);
      return;
    }
    if (scene === 'setup') {
      if (code === 'Escape') closeSetup();
      return;
    }
    if (scene !== 'match') return;
    if (code === 'Escape') {
      if (match.state !== 'over') setPaused(!paused);
      return;
    }
    if (paused || match.sport !== 'bd') return;
    if (code === 'KeyJ') bdPress('clear');
    else if (code === 'KeyK') bdPress('smash');
    else if (code === 'KeyL') bdPress('drop');
    else if (code === 'Space') bdPress('serve');
  }

  /* ---------- 音效（Web Audio 簡單合成） ---------- */
  let actx = null;
  function beep(freq, dur, type = 'square', vol = 0.06) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(vol, actx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + dur);
      o.connect(g).connect(actx.destination);
      o.start();
      o.stop(actx.currentTime + dur);
    } catch (err) { /* 沒有音效也能玩 */ }
  }
  const sfx = {
    hit: () => beep(620, 0.06, 'square', 0.05),
    bounce: () => beep(420, 0.05, 'triangle', 0.07),
    smash: () => beep(180, 0.12, 'sawtooth', 0.06),
    point: (good) => { beep(good ? 784 : 330, 0.18, 'triangle', 0.08); if (good) setTimeout(() => beep(1046, 0.2, 'triangle', 0.07), 120); },
  };

  /* =========================================================
     共用繪圖
     ========================================================= */
  function rr(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
  function line(g, x1, y1, x2, y2) {
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
  }

  // PU 地板：綠色底 + 天花板燈光照下來的亮區 + 細微顆粒
  function paintFloor(g, x, y, w, h) {
    g.fillStyle = C.floor;
    g.fillRect(x, y, w, h);
    g.save();
    g.beginPath(); g.rect(x, y, w, h); g.clip();
    for (let lx = x + 120; lx < x + w; lx += 260) {
      for (let ly = y + 110; ly < y + h; ly += 240) {
        const gr = g.createRadialGradient(lx, ly, 0, lx, ly, 170);
        gr.addColorStop(0, 'rgba(255,255,255,0.10)');
        gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr;
        g.fillRect(lx - 170, ly - 170, 340, 340);
      }
    }
    for (let i = 0; i < (w * h) / 900; i++) {
      g.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.04)';
      g.fillRect(x + Math.random() * w, y + Math.random() * h, 2, 2);
    }
    g.restore();
  }

  // 圍住球場的廣告擋板
  function paintBoards(g, rect, door, text) {
    const t = 10;
    const segs = [];
    const { x, y, w, h } = rect;
    segs.push([x, y - t, w, t]);                // 上
    segs.push([x - t, y - t, t, h + t * 2]);    // 左
    segs.push([x + w, y - t, t, h + t * 2]);    // 右
    if (door) {                                  // 下（留門）
      segs.push([x, y + h, door.x - 40 - x, t]);
      segs.push([door.x + 40, y + h, x + w - door.x - 40, t]);
    } else {
      segs.push([x, y + h, w, t]);
    }
    g.save();
    for (const [sx, sy, sw, sh] of segs) {
      g.fillStyle = 'rgba(0,0,0,0.35)';
      g.fillRect(sx + 3, sy + 4, sw, sh);
      g.fillStyle = C.blue;
      g.fillRect(sx, sy, sw, sh);
      g.fillStyle = 'rgba(255,255,255,0.85)';
      if (sw > sh) {
        for (let bx = sx + 4; bx < sx + sw - 30; bx += 74) {
          g.fillRect(bx + 60, sy, 2, sh);
          if (text) {
            g.font = `700 8px ${FONT}`;
            g.textBaseline = 'middle';
            g.fillText(text, bx + 14, sy + sh / 2 + 1);
          }
        }
      } else {
        for (let by = sy + 4; by < sy + sh - 30; by += 74) g.fillRect(sx, by + 60, sw, 2);
      }
    }
    g.restore();
  }

  /* =========================================================
     大廳
     ========================================================= */
  const ZONES = {
    tt: { rect: { x: 120, y: 160, w: 400, h: 390 }, door: { x: 320, y: 550 }, label: '桌球場' },
    bd: { rect: { x: 620, y: 180, w: 560, h: 300 }, door: { x: 900, y: 480 }, label: '羽球場' },
  };
  const lobby = { x: 640, y: 640, dir: -Math.PI / 2, walk: 0, near: null };

  function paintLobby(g) {
    g.fillStyle = C.wall;
    g.fillRect(0, 0, W, H);

    // 上方觀眾席
    g.fillStyle = C.wall2;
    g.fillRect(0, 0, W, 92);
    for (let r = 0; r < 4; r++) {
      const y = 12 + r * 18;
      g.fillStyle = r % 2 ? '#56616a' : '#6b767e';
      g.fillRect(150, y, 400, 12);
      g.fillRect(730, y, 400, 12);
    }
    g.fillStyle = C.muted;
    g.font = `500 13px ${FONT}`;
    g.textAlign = 'center';
    g.fillText('觀眾席', 640, 50);

    paintFloor(g, 36, 92, 1208, 600);

    // 地板上的各種球場線（籃球白線、排球藍線、黃線）
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(240,190,60,0.75)';
    g.strokeRect(200, 150, 880, 484);
    g.strokeStyle = 'rgba(52,100,200,0.9)';
    g.strokeRect(320, 210, 640, 364);
    line(g, 533, 210, 533, 574);
    line(g, 747, 210, 747, 574);
    g.strokeStyle = 'rgba(238,243,238,0.8)';
    g.strokeRect(80, 116, 1120, 552);
    line(g, 640, 116, 640, 668);
    g.beginPath(); g.arc(640, 392, 64, 0, Math.PI * 2); g.stroke();
    g.strokeRect(80, 322, 180, 140);
    g.strokeRect(1020, 322, 180, 140);
    g.beginPath(); g.arc(112, 392, 250, -1.2, 1.2); g.stroke();
    g.beginPath(); g.arc(1168, 392, 250, Math.PI - 1.2, Math.PI + 1.2); g.stroke();

    // 籃框
    for (const [bx, rx] of [[48, 70], [1226, 1204]]) {
      g.fillStyle = '#f4f6f4';
      g.fillRect(bx, 362, 6, 60);
      g.strokeStyle = '#e46a2c';
      g.lineWidth = 3;
      g.beginPath(); g.arc(rx, 392, 12, 0, Math.PI * 2); g.stroke();
    }

    // 入口
    g.fillStyle = '#2a3235';
    g.fillRect(586, 692, 108, 28);
    g.fillStyle = C.muted;
    g.font = `700 13px ${FONT}`;
    g.fillText('入口', 640, 711);

    // 桌球場
    paintZoneBase(g, ZONES.tt, 'TABLE TENNIS');
    paintMiniTable(g, 320, 352);
    // 羽球場
    paintZoneBase(g, ZONES.bd, 'BADMINTON');
    paintMiniCourt(g, 900, 330);

    // 門口地墊與名稱
    for (const z of Object.values(ZONES)) {
      g.fillStyle = 'rgba(242,178,59,0.22)';
      g.fillRect(z.door.x - 36, z.door.y + 10, 72, 34);
      g.strokeStyle = 'rgba(242,178,59,0.8)';
      g.setLineDash([6, 5]);
      g.lineWidth = 2;
      g.strokeRect(z.door.x - 36, z.door.y + 10, 72, 34);
      g.setLineDash([]);
      g.fillStyle = '#f7e2b4';
      g.font = `700 12px ${FONT}`;
      g.fillText('門口', z.door.x, z.door.y + 32);
      g.fillStyle = C.ink;
      g.font = `900 20px ${FONT}`;
      g.textAlign = 'left';
      g.fillText(z.label, z.rect.x + 14, z.rect.y + 30);
      g.textAlign = 'center';
    }
  }

  function paintZoneBase(g, z, text) {
    const r = z.rect;
    g.fillStyle = 'rgba(28,78,62,0.9)';
    g.fillRect(r.x, r.y, r.w, r.h);
    paintBoards(g, r, z.door, text);
  }

  function paintMiniTable(g, cx, cy) {
    const w = 120, h = 216;
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(cx - w / 2 + 8, cy - h / 2 + 10, w, h);
    g.fillStyle = '#1e56a6';
    g.fillRect(cx - w / 2, cy - h / 2, w, h);
    g.strokeStyle = '#fff';
    g.lineWidth = 3;
    g.strokeRect(cx - w / 2, cy - h / 2, w, h);
    g.lineWidth = 1.5;
    line(g, cx, cy - h / 2, cx, cy + h / 2);
    g.fillStyle = '#1b2023';
    g.fillRect(cx - w / 2 - 10, cy - 3, w + 20, 6);
    g.fillStyle = '#fff';
    g.fillRect(cx - w / 2 - 10, cy - 1, w + 20, 2);
  }

  function paintMiniCourt(g, cx, cy) {
    const s = 30, L = 13.4 * s, Wd = 6.1 * s;
    const x0 = cx - L / 2, y0 = cy - Wd / 2;
    g.strokeStyle = '#fff';
    g.lineWidth = 2.5;
    g.strokeRect(x0, y0, L, Wd);
    line(g, x0, y0 + 0.46 * s, x0 + L, y0 + 0.46 * s);
    line(g, x0, y0 + Wd - 0.46 * s, x0 + L, y0 + Wd - 0.46 * s);
    line(g, cx - 1.98 * s, y0, cx - 1.98 * s, y0 + Wd);
    line(g, cx + 1.98 * s, y0, cx + 1.98 * s, y0 + Wd);
    line(g, x0 + 0.76 * s, y0, x0 + 0.76 * s, y0 + Wd);
    line(g, x0 + L - 0.76 * s, y0, x0 + L - 0.76 * s, y0 + Wd);
    line(g, x0, cy, cx - 1.98 * s, cy);
    line(g, cx + 1.98 * s, cy, x0 + L, cy);
    g.strokeStyle = '#1b2023';
    g.lineWidth = 5;
    line(g, cx, y0 - 8, cx, y0 + Wd + 8);
    g.fillStyle = '#d9dde0';
    g.fillRect(cx - 4, y0 - 12, 8, 8);
    g.fillRect(cx - 4, y0 + Wd + 4, 8, 8);
  }

  function lobbyBlocked(x, y) {
    if (x < 56 || x > 1224 || y < 108 || y > 676) return true;
    for (const z of Object.values(ZONES)) {
      const r = z.rect;
      if (x > r.x - 26 && x < r.x + r.w + 26 && y > r.y - 26 && y < r.y + r.h + 24) return true;
    }
    return false;
  }

  function updateLobby(dt) {
    const dx = (keys.ArrowRight ? 1 : 0) - (keys.ArrowLeft ? 1 : 0);
    const dy = (keys.ArrowDown ? 1 : 0) - (keys.ArrowUp ? 1 : 0);
    if (dx || dy) {
      const l = Math.hypot(dx, dy);
      const sp = 230 * dt;
      const nx = lobby.x + (dx / l) * sp;
      const ny = lobby.y + (dy / l) * sp;
      if (!lobbyBlocked(nx, lobby.y)) lobby.x = nx;
      if (!lobbyBlocked(lobby.x, ny)) lobby.y = ny;
      lobby.dir = Math.atan2(dy, dx);
      lobby.walk += dt * 10;
    }
    let near = null;
    for (const [k, z] of Object.entries(ZONES)) {
      if (Math.hypot(lobby.x - z.door.x, lobby.y - (z.door.y + 34)) < 64) near = k;
    }
    if (near !== lobby.near) {
      lobby.near = near;
      const btn = $('joinBtn');
      if (near) {
        const z = ZONES[near];
        btn.textContent = `進入${z.label}・加入比賽`;
        btn.style.left = (z.door.x / W) * 100 + '%';
        btn.style.top = ((z.door.y - 8) / H) * 100 + '%';
      }
      btn.hidden = !near;
    }
  }

  function drawLobby() {
    ctx.drawImage(bgLobby, 0, 0);

    // 上一場小看板
    for (const [k, z] of Object.entries(ZONES)) {
      const rec = lastMatch[k];
      if (!rec) continue;
      const x = z.rect.x + z.rect.w - 132, y = z.rect.y + 12;
      ctx.fillStyle = C.panel;
      rr(ctx, x, y, 118, 40, 6);
      ctx.fill();
      ctx.fillStyle = C.muted;
      ctx.font = `500 11px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText('上一場', x + 10, y + 16);
      ctx.fillStyle = C.ink;
      ctx.font = `700 17px ${NUM}`;
      ctx.fillText(`${rec.p} : ${rec.c}`, x + 10, y + 34);
      ctx.fillStyle = C.muted;
      ctx.font = `500 11px ${FONT}`;
      ctx.textAlign = 'right';
      ctx.fillText(DIFF[rec.diff].label, x + 108, y + 34);
    }
    ctx.textAlign = 'center';

    drawPerson(lobby.x, lobby.y, lobby.dir, C.amber, lobby.walk, null);
    ctx.fillStyle = C.ink;
    ctx.font = `700 13px ${FONT}`;
    ctx.fillText('你', lobby.x, lobby.y - 26);
  }

  // 俯視的人：肩膀、頭、手臂，可選擇拿球拍
  function drawPerson(x, y, dir, color, walk, racket) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath(); ctx.ellipse(4, 6, 20, 14, 0, 0, Math.PI * 2); ctx.fill();
    ctx.rotate(dir + Math.PI / 2); // 讓「上」= 面向方向
    const sw = Math.sin(walk) * 6;
    ctx.fillStyle = '#e2b48f';
    ctx.beginPath(); ctx.arc(-17, -sw, 4.5, 0, Math.PI * 2); ctx.fill();
    if (!racket) { ctx.beginPath(); ctx.arc(17, sw, 4.5, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.ellipse(0, 0, 16, 9, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#2b2420';
    ctx.beginPath(); ctx.arc(0, 1, 7.5, 0, Math.PI * 2); ctx.fill();
    if (racket) {
      // racket.swing：0 = 準備，1 = 揮完
      const a = -0.9 + racket.swing * 1.9;
      ctx.translate(15, 0);
      ctx.rotate(a);
      ctx.fillStyle = '#e2b48f';
      ctx.beginPath(); ctx.arc(0, 0, 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 3;
      line(ctx, 0, 0, 0, -20);
      ctx.strokeStyle = racket.color;
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.ellipse(0, -31, 8, 11, 0, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 0.8;
      for (let i = -5; i <= 5; i += 2.5) line(ctx, i, -40, i, -22);
    }
    ctx.restore();
  }

  /* =========================================================
     比賽流程（兩種運動共用）
     ========================================================= */
  function openSetup(sport) {
    setupSport = sport;
    scene = 'setup';
    $('joinBtn').hidden = true;
    $('setupSport').textContent = ZONES[sport].label;
    $('nameInput').value = lastName;
    const radio = document.querySelector(`input[name="diff"][value="${lastDiff}"]`);
    if (radio) radio.checked = true;
    $('setupLast').textContent = lastText(lastMatch[sport]);
    $('setup').hidden = false;
    setTimeout(() => $('nameInput').focus(), 0);
    setHint();
  }

  function closeSetup() {
    $('setup').hidden = true;
    scene = 'lobby';
    lobby.near = null; // 讓按鈕重新出現
    document.activeElement && document.activeElement.blur();
    setHint();
  }

  function lastText(rec) {
    if (!rec) return '上一場：這是開啟網頁後的第一場';
    return `上一場（${DIFF[rec.diff].label}）：${rec.name} ${rec.p} : ${rec.c} CPU`;
  }

  $('setupForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('nameInput').value.trim() || 'Player';
    const diff = (document.querySelector('input[name="diff"]:checked') || {}).value || 'normal';
    lastName = $('nameInput').value.trim();
    lastDiff = diff;
    $('setup').hidden = true;
    document.activeElement && document.activeElement.blur();
    startMatch(setupSport, name, diff);
  });
  $('cancelBtn').addEventListener('click', closeSetup);
  $('joinBtn').addEventListener('click', () => { if (lobby.near) openSetup(lobby.near); });

  function startMatch(sport, name, diff) {
    match = {
      sport, name, diff, cfg: DIFF[diff],
      score: { p: 0, c: 0 },
      server: 'p', lastWinner: 'p',
      state: 'serve', pauseT: 0,
      msg: null, sub: null, flag: null, winner: null,
      speed: DIFF[diff].base, time: 0,
    };
    fx.length = 0;
    if (sport === 'tt') { ttInit(); ttNewPoint(); } else { bdInit(); bdNewPoint(); }
    scene = 'match';
    paused = false;
    canvas.classList.toggle('nocursor', sport === 'tt');
    setHint();
  }

  // 賽末點／決勝分提示
  function pointFlag() {
    const t = SPORT[match.sport].target, { p, c } = match.score;
    if (p === t - 1 && c === t - 1) return '決勝分';
    if (p === t - 1) return `${match.name} 賽末點`;
    if (c === t - 1) return 'CPU 賽末點';
    return null;
  }

  function awardPoint(winner, reason) {
    if (match.state !== 'play') return;
    match.score[winner]++;
    match.lastWinner = winner;
    match.state = 'point';
    match.pauseT = 1.4;
    match.msg = winner === 'p' ? `${match.name} 得分` : 'CPU 得分';
    match.sub = reason;
    match.flag = null;
    sfx.point(winner === 'p');
    if (match.score[winner] >= SPORT[match.sport].target) {
      match.winner = winner;
      match.pauseT = 1.8;
    }
  }

  function nextPoint() {
    const { p, c } = match.score;
    if (match.sport === 'tt') match.server = Math.floor((p + c) / 2) % 2 === 0 ? 'p' : 'c'; // 每 2 分換發
    else match.server = match.lastWinner;                                                   // 得分方發球
    match.state = 'serve';
    match.msg = null;
    match.flag = pointFlag();
    match.speed = match.cfg.base;
    if (match.sport === 'tt') ttNewPoint(); else bdNewPoint();
  }

  function updateMatch(dt) {
    match.time += dt;
    if (match.sport === 'tt') ttUpdate(dt); else bdUpdate(dt);
    if (match.state === 'point') {
      match.pauseT -= dt;
      if (match.pauseT <= 0) {
        if (match.winner) endMatch(); else nextPoint();
      }
    }
  }

  function setPaused(v) {
    paused = v;
    $('pause').hidden = !v;
    canvas.classList.toggle('nocursor', !v && match && match.sport === 'tt');
  }
  $('resumeBtn').addEventListener('click', () => setPaused(false));
  $('quitBtn').addEventListener('click', () => { setPaused(false); toLobby(); });

  function toLobby() {
    scene = 'lobby';
    match = null;
    paused = false;
    $('result').hidden = true;
    $('pause').hidden = true;
    canvas.classList.remove('nocursor');
    lobby.near = null;
    setHint();
  }

  /* ---------- 結算 ---------- */
  function fmtDate(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function endMatch() {
    match.state = 'over';
    const prev = lastMatch[match.sport];
    const rec = { name: match.name, p: match.score.p, c: match.score.c, diff: match.diff, date: new Date() };
    lastMatch[match.sport] = rec;
    match.record = rec;

    const won = match.winner === 'p';
    $('resSport').textContent = `${SPORT[match.sport].label}・${match.cfg.label}`;
    $('resTitle').textContent = won ? `${match.name} 獲勝！` : 'CPU 獲勝';
    const box = $('resScore');
    box.textContent = '';
    const side = (name, score, win) => {
      const s = document.createElement('span');
      s.className = 'side' + (win ? ' win' : '');
      const b = document.createElement('b'); b.textContent = name;
      const em = document.createElement('em'); em.textContent = score;
      s.append(b, em);
      return s;
    };
    const colon = document.createElement('i'); colon.textContent = ':';
    box.append(side(match.name, rec.p, won), colon, side('CPU', rec.c, !won));
    $('resMeta').textContent = `比賽時間：${fmtDate(rec.date)}`;
    $('resPrev').textContent = lastText(prev);
    $('result').hidden = false;
    canvas.classList.remove('nocursor');
    setHint();
  }

  $('againBtn').addEventListener('click', () => {
    $('result').hidden = true;
    startMatch(match.sport, match.name, match.diff);
  });
  $('lobbyBtn').addEventListener('click', toLobby);
  $('shotBtn').addEventListener('click', saveShot);

  // 截圖：以最後一個比賽畫面當背景，畫上結算卡片，下載成 PNG
  function saveShot() {
    if (!match || !match.record) return;
    const rec = match.record;
    const c = document.createElement('canvas');
    c.width = 1280; c.height = 720;
    const g = c.getContext('2d');
    g.drawImage(canvas, 0, 0);
    g.fillStyle = 'rgba(12,17,18,0.8)';
    g.fillRect(0, 0, 1280, 720);

    // 天花板色帶
    const cols = [C.red, C.amber, '#5aa86a', C.blue];
    for (let i = 0; i < 16; i++) {
      g.fillStyle = cols[i % 4];
      g.fillRect(i * 80, 0, 74, 10);
    }

    const won = match.winner === 'p';
    g.fillStyle = C.panel;
    rr(g, 290, 130, 700, 460, 18);
    g.fill();
    g.strokeStyle = '#34413f';
    g.lineWidth = 2;
    g.stroke();

    g.textAlign = 'center';
    g.fillStyle = C.amber;
    g.font = `700 22px ${FONT}`;
    g.fillText(`${SPORT[match.sport].label}單打・${match.cfg.label}`, 640, 190);
    g.fillStyle = C.ink;
    g.font = `900 46px ${FONT}`;
    g.fillText(won ? `${rec.name} 獲勝！` : 'CPU 獲勝', 640, 254);

    g.font = `700 26px ${FONT}`;
    g.fillText(rec.name, 470, 330);
    g.fillText('CPU', 810, 330);
    g.font = `700 120px ${NUM}`;
    g.fillStyle = won ? C.amber : C.ink;
    g.fillText(String(rec.p), 470, 460);
    g.fillStyle = won ? C.ink : C.amber;
    g.fillText(String(rec.c), 810, 460);
    g.fillStyle = C.muted;
    g.font = `700 70px ${NUM}`;
    g.fillText(':', 640, 445);

    g.font = `500 22px ${FONT}`;
    g.fillText(`比賽時間 ${fmtDate(rec.date)}`, 640, 530);
    g.font = `500 16px ${FONT}`;
    g.fillText('體育館對打賽', 640, 562);

    const p = (n) => String(n).padStart(2, '0');
    const d = rec.date;
    const file = `${match.sport === 'tt' ? '桌球' : '羽球'}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.png`;
    c.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = file;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, 'image/png');
  }

  /* ---------- 計分板（畫在 canvas 上） ---------- */
  function drawHUD() {
    const m = match;
    ctx.save();
    ctx.fillStyle = C.panel;
    rr(ctx, 18, 16, 262, 92, 10);
    ctx.fill();
    const row = (name, score, who, y) => {
      if (m.server === who && m.state !== 'over') {
        ctx.fillStyle = C.amber;
        ctx.beginPath(); ctx.arc(36, y - 7, 6, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = C.ink;
      ctx.textAlign = 'left';
      ctx.font = `700 19px ${FONT}`;
      const n = name.length > 9 ? name.slice(0, 9) + '…' : name;
      ctx.fillText(n, 52, y);
      ctx.textAlign = 'right';
      ctx.font = `700 32px ${NUM}`;
      ctx.fillText(String(score), 266, y + 4);
    };
    row(m.name, m.score.p, 'p', 54);
    row('CPU', m.score.c, 'c', 94);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    line(ctx, 30, 66, 268, 66);

    // 右上：項目、難度、球速
    ctx.fillStyle = C.panel;
    rr(ctx, W - 230, 16, 212, 92, 10);
    ctx.fill();
    ctx.textAlign = 'left';
    ctx.fillStyle = C.amber;
    ctx.font = `700 14px ${FONT}`;
    ctx.fillText(`${SPORT[m.sport].label}・先到 ${SPORT[m.sport].target} 分`, W - 214, 44);
    ctx.fillStyle = C.ink;
    ctx.font = `500 15px ${FONT}`;
    ctx.fillText(`難度：${m.cfg.label}`, W - 214, 70);
    ctx.fillText('球速', W - 214, 95);
    const ratio = (m.speed - 1) / (2.1 - 1);
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(W - 176, 86, 100, 8);
    ctx.fillStyle = m.speed >= m.cfg.max - 0.001 ? C.red : C.amber;
    ctx.fillRect(W - 176, 86, Math.max(4, ratio * 100), 8);
    ctx.fillStyle = C.ink;
    ctx.font = `700 14px ${NUM}`;
    ctx.fillText(`×${m.speed.toFixed(2)}`, W - 68, 95);

    // 賽末點 / 決勝分
    if (m.flag && m.state === 'serve') {
      ctx.font = `900 22px ${FONT}`;
      const tw = ctx.measureText(m.flag).width + 40;
      ctx.fillStyle = C.red;
      rr(ctx, 18, 120, tw, 40, 8);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.fillText(m.flag, 38, 148);
    }

    // 發球提示
    if (m.state === 'serve') {
      const txt = m.server === 'p'
        ? (m.sport === 'tt' ? '輪到你發球：點滑鼠左鍵' : '輪到你發球：按空白鍵')
        : 'CPU 準備發球…';
      ctx.font = `700 18px ${FONT}`;
      const tw = ctx.measureText(txt).width + 36;
      ctx.fillStyle = C.panel;
      rr(ctx, W / 2 - tw / 2, H - 56, tw, 38, 19);
      ctx.fill();
      ctx.fillStyle = m.server === 'p' ? C.amber : C.ink;
      ctx.textAlign = 'center';
      ctx.fillText(txt, W / 2, H - 31);
    }

    // 得分訊息
    if (m.state === 'point' && m.msg) {
      ctx.fillStyle = 'rgba(12,17,18,0.82)';
      rr(ctx, W / 2 - 220, H / 2 - 62, 440, 124, 14);
      ctx.fill();
      ctx.textAlign = 'center';
      ctx.fillStyle = m.lastWinner === 'p' ? C.amber : C.ink;
      ctx.font = `900 38px ${FONT}`;
      ctx.fillText(m.winner ? '比賽結束' : m.msg, W / 2, H / 2 - 6);
      ctx.fillStyle = C.muted;
      ctx.font = `500 19px ${FONT}`;
      ctx.fillText(m.winner ? `${m.msg}・${m.sub}` : m.sub, W / 2, H / 2 + 34);
    }
    ctx.restore();
  }

  // 落地波紋
  function addFx(x, y, color) { fx.push({ x, y, t: 0, color }); }
  function updateFx(dt) {
    for (let i = fx.length - 1; i >= 0; i--) {
      fx[i].t += dt;
      if (fx[i].t > 0.5) fx.splice(i, 1);
    }
  }
  function drawFx() {
    for (const f of fx) {
      const k = f.t / 0.5;
      ctx.strokeStyle = f.color;
      ctx.globalAlpha = 1 - k;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(f.x, f.y, 6 + k * 22, 4 + k * 14, 0, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function moveToward(o, tx, ty, speed, dt) {
    const dx = tx - o.x, dy = ty - o.y, d = Math.hypot(dx, dy);
    if (d < 1) return;
    const s = Math.min(d, speed * dt);
    o.x += (dx / d) * s;
    o.y += (dy / d) * s;
  }

  // 第 5 拍以後才開始加速
  function shotMult(hits) {
    const c = match.cfg;
    return Math.min(c.max, c.base + Math.max(0, hits - 4) * c.inc);
  }

  /* =========================================================
     桌球（俯視，玩家在下方，CPU 在上方）
     ========================================================= */
  const TT = { x0: 495, x1: 785, y0: 100, y1: 620, net: 360, netH: 14, g: 620, padR: 26, bounceVz: 215 };
  const inTable = (x, y) => x >= TT.x0 && x <= TT.x1 && y >= TT.y0 && y <= TT.y1;
  let tt = null;

  function ttInit() {
    tt = {
      ball: { x: 640, y: 600, z: 22, vx: 0, vy: 0, vz: 0, dead: false, netFail: false },
      pp: { x: 640, y: 670, vx: 0, vy: 0, swing: 0 },
      cp: { x: 640, y: 60, react: 0, swing: 0 },
      phase: 'serve1', hitter: 'p', bounces: 0, hits: { p: 0, c: 0 }, wait: 1,
    };
  }

  function ttNewPoint() {
    const b = tt.ball;
    Object.assign(b, { vx: 0, vy: 0, vz: 0, z: 22, dead: false, netFail: false });
    tt.bounces = 0;
    tt.hits = { p: 0, c: 0 };
    tt.wait = 1.1;
  }

  // 設定一個拋物線：在 T 秒後落在 (tx, ty)
  function ttLaunch(tx, ty, T) {
    const b = tt.ball;
    b.vx = (tx - b.x) / T;
    b.vy = (ty - b.y) / T;
    b.vz = (0.5 * TT.g * T * T - b.z) / T;
  }

  function ttServe(who) {
    const b = tt.ball, cfg = match.cfg;
    tt.hits[who]++;
    tt.hitter = who;
    tt.phase = 'serve1'; // 第一段：先彈自己這邊
    tt.bounces = 0;
    b.dead = false;
    b.netFail = false;
    match.state = 'play';
    const m = shotMult(tt.hits[who]);
    match.speed = m;
    let tx, ty;
    if (who === 'p') {
      tx = b.x + clamp(tt.pp.vx * 0.03, -30, 30);
      ty = clamp(b.y - 110, TT.net + 50, TT.y1 - 30);
    } else {
      tx = b.x + rand(-20, 20);
      ty = clamp(b.y + 110, TT.y0 + 30, TT.net - 50);
      if (Math.random() < cfg.err * 0.35) tx = Math.random() < 0.5 ? TT.x0 - 24 : TT.x1 + 24;
      tt.cp.swing = 0.15;
    }
    if (who === 'p') tt.pp.swing = 0.15;
    ttLaunch(tx, ty, 0.42 / m);
    sfx.hit();
  }

  function ttTarget(h, serve) {
    if (h === 'p') {
      const pp = tt.pp, b = tt.ball;
      if (serve) {
        return [640 + clamp(pp.vx * 0.08, -110, 110) + rand(-40, 40), rand(TT.y0 + 40, TT.net - 70)];
      }
      // 擊球點偏離球拍中心 + 揮拍方向 → 決定落點
      const off = clamp((b.x - pp.x) / TT.padR, -1.3, 1.3);
      const tx = 640 + (b.x - 640) * 0.25 + off * 120 + clamp(pp.vx * 0.1, -120, 120);
      const ty = TT.net - rand(70, 230) - clamp(-pp.vy * 0.04, 0, 30);
      return [tx, ty];
    }
    if (serve) return [640 + rand(-110, 110), rand(TT.net + 70, TT.y1 - 40)];
    const tx = match.diff === 'hard'
      ? (tt.pp.x > 640 ? rand(TT.x0 + 20, 600) : rand(680, TT.x1 - 20))
      : rand(TT.x0 + 30, TT.x1 - 30);
    return [tx, rand(TT.net + 60, TT.y1 - 35)];
  }

  function ttHit(who) {
    const b = tt.ball, cfg = match.cfg;
    tt.hits[who]++;
    tt.hitter = who;
    tt.bounces = 0;
    b.netFail = false;
    const m = shotMult(tt.hits[who]);
    match.speed = m;
    let [tx, ty] = ttTarget(who, false);
    if (who === 'c') {
      tt.cp.swing = 0.15;
      if (Math.random() < cfg.err) {
        if (Math.random() < 0.5) b.netFail = true;
        else if (Math.random() < 0.5) tx = Math.random() < 0.5 ? TT.x0 - 35 : TT.x1 + 35;
        else ty = TT.y1 + 45;
      }
    } else {
      tt.pp.swing = 0.15;
      tt.cp.react = cfg.react;
    }
    b.z = Math.max(b.z, 12);
    ttLaunch(tx, ty, 0.95 / m);
    sfx.hit();
  }

  function ttGround() {
    const b = tt.ball, on = inTable(b.x, b.y), side = b.y > TT.net ? 'p' : 'c';
    const h = tt.hitter, o = other(h);
    if (on) addFx(b.x, b.y, 'rgba(255,255,255,0.8)');
    if (tt.phase === 'serve1') {
      if (on && side === h) {
        // 發球第一彈成功 → 飛向對方桌面
        sfx.bounce();
        tt.phase = 'flight';
        tt.bounces = 0;
        const [tx, ty] = ttTarget(h, true);
        ttLaunch(tx, ty, 0.85 / match.speed);
      } else {
        b.dead = true; b.vz = 90;
        awardPoint(o, '發球沒有彈到自己這邊');
      }
      return;
    }
    if (tt.bounces === 0) {
      if (on && side === o) {
        tt.bounces = 1;
        b.vz = TT.bounceVz;
        sfx.bounce();
      } else {
        b.dead = true; b.vz = 90;
        awardPoint(o, on ? '打到自己這邊' : '出界');
      }
    } else {
      b.dead = true; b.vz = 90;
      awardPoint(h, o === 'p' ? '沒接到' : 'CPU 沒接到');
    }
  }

  function ttUpdate(dt) {
    const pp = tt.pp, cp = tt.cp, b = tt.ball, cfg = match.cfg;

    // 玩家球拍跟著滑鼠，只能在自己這半邊
    const mx = clamp(mouse.x, 300, 980), my = clamp(mouse.y, TT.net + 26, 712);
    pp.vx = pp.vx * 0.6 + ((mx - pp.x) / dt) * 0.4;
    pp.vy = pp.vy * 0.6 + ((my - pp.y) / dt) * 0.4;
    pp.x = mx; pp.y = my;
    pp.swing = Math.max(0, pp.swing - dt);
    cp.swing = Math.max(0, cp.swing - dt);

    if (match.state === 'serve') {
      if (match.server === 'p') {
        b.x = pp.x; b.y = pp.y - 24; b.z = 22 + Math.sin(match.time * 6) * 5;
        moveToward(cp, 640, 60, cfg.move * 0.5, dt);
        if (mouse.click) ttServe('p');
      } else {
        moveToward(cp, 640 + Math.sin(match.time * 1.7) * 80, 60, 160, dt);
        b.x = cp.x; b.y = cp.y + 24; b.z = 22 + Math.sin(match.time * 6) * 5;
        tt.wait -= dt;
        if (tt.wait <= 0) ttServe('c');
      }
      mouse.click = false;
      updateFx(dt);
      return;
    }
    mouse.click = false;

    // CPU 移動：反應時間過後，往球會經過的位置移動
    if (match.state === 'play' && tt.hitter === 'p' && !b.dead && b.vy < 0) {
      cp.react -= dt;
      if (cp.react <= 0) {
        const t = (cp.y - b.y) / b.vy;
        moveToward(cp, clamp(b.x + b.vx * t, 320, 960), 60, cfg.move, dt);
      }
    } else {
      moveToward(cp, 640, 60, cfg.move * 0.5, dt);
    }

    // 球的物理
    const py = b.y;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.vz -= TT.g * dt;
    b.z += b.vz * dt;

    if (b.dead || match.state !== 'play') {
      if (b.z <= 0) {
        b.z = 0;
        b.vz = Math.abs(b.vz) * 0.35;
        if (b.vz < 30) b.vz = 0;
        b.vx *= 0.6; b.vy *= 0.6;
      }
      updateFx(dt);
      return;
    }

    // 過網檢查
    if (tt.phase === 'flight' && (py - TT.net) * (b.y - TT.net) < 0) {
      if (b.z < TT.netH || b.netFail) {
        b.dead = true;
        b.y = TT.net + (py > TT.net ? 5 : -5);
        b.vx *= 0.2; b.vy = 0; b.vz = 40;
        awardPoint(other(tt.hitter), '掛網');
        updateFx(dt);
        return;
      }
    }

    if (b.z <= 0 && b.vz < 0) { b.z = 0; ttGround(); }

    // 擊球：球在自己這邊彈過一次後，碰到球拍就自動回擊
    if (!b.dead && match.state === 'play' && tt.phase === 'flight' && tt.bounces === 1) {
      const r = other(tt.hitter);
      const pad = r === 'p' ? pp : cp;
      const toward = r === 'p' ? b.vy > 0 : b.vy < 0;
      const reach = TT.padR + 7 + (r === 'c' ? cfg.reach : 0);
      if (toward && b.z < 95 && Math.hypot(b.x - pad.x, b.y - pad.y) < reach) ttHit(r);
    }
    updateFx(dt);
  }

  function paintTT(g) {
    g.fillStyle = C.wall;
    g.fillRect(0, 0, W, H);
    paintFloor(g, 250, 0, 780, H);
    paintBoards(g, { x: 250, y: -20, w: 780, h: 760 }, null, '');

    // 球桌
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(TT.x0 + 12, TT.y0 + 16, TT.x1 - TT.x0, TT.y1 - TT.y0);
    const gr = g.createLinearGradient(TT.x0, TT.y0, TT.x1, TT.y1);
    gr.addColorStop(0, '#2363b8');
    gr.addColorStop(1, '#1b4f97');
    g.fillStyle = gr;
    g.fillRect(TT.x0, TT.y0, TT.x1 - TT.x0, TT.y1 - TT.y0);
    g.strokeStyle = '#fff';
    g.lineWidth = 4;
    g.strokeRect(TT.x0 + 2, TT.y0 + 2, TT.x1 - TT.x0 - 4, TT.y1 - TT.y0 - 4);
    g.lineWidth = 2;
    line(g, 640, TT.y0, 640, TT.y1);
    // 球網
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.fillRect(TT.x0 - 16, TT.net + 3, TT.x1 - TT.x0 + 32, 8);
    g.fillStyle = '#1b2023';
    g.fillRect(TT.x0 - 16, TT.net - 4, TT.x1 - TT.x0 + 32, 8);
    g.fillStyle = '#fff';
    g.fillRect(TT.x0 - 16, TT.net - 4, TT.x1 - TT.x0 + 32, 2);
    g.fillStyle = '#9aa3a8';
    g.fillRect(TT.x0 - 22, TT.net - 7, 8, 14);
    g.fillRect(TT.x1 + 14, TT.net - 7, 8, 14);
  }

  function drawPaddle(p, rubber, top) {
    const lift = p.swing > 0 ? 4 : 0;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath(); ctx.ellipse(6, 8, TT.padR, TT.padR * 0.8, 0, 0, Math.PI * 2); ctx.fill();
    ctx.translate(0, -lift);
    ctx.fillStyle = '#c59457';
    rr(ctx, -6, top ? -TT.padR - 26 : TT.padR - 4, 12, 30, 4);
    ctx.fill();
    ctx.fillStyle = '#c59457';
    ctx.beginPath(); ctx.arc(0, 0, TT.padR + 2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = rubber;
    ctx.beginPath(); ctx.arc(0, 0, TT.padR, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath(); ctx.arc(-7, -8, TT.padR * 0.55, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // 影子在地面位置，球往上畫（越高離影子越遠、也越大）
  function drawTTBall(b) {
    ctx.fillStyle = `rgba(0,0,0,${Math.max(0.12, 0.38 - b.z / 300)})`;
    ctx.beginPath(); ctx.ellipse(b.x, b.y, 6, 4, 0, 0, Math.PI * 2); ctx.fill();
    const r = 6.5 + b.z * 0.04;
    const by = b.y - b.z * 0.55;
    ctx.fillStyle = '#fff4e2';
    ctx.beginPath(); ctx.arc(b.x, by, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#cdb98f';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function drawTT() {
    ctx.drawImage(bgTT, 0, 0);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = `700 14px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textAlign = 'left';
    ctx.fillText('CPU', TT.x1 + 40, 66);
    ctx.textAlign = 'center';
    drawFx();
    drawPaddle(tt.cp, '#1d1f22', true);
    if (tt.ball.y < tt.pp.y) { drawTTBall(tt.ball); drawPaddle(tt.pp, C.red, false); }
    else { drawPaddle(tt.pp, C.red, false); drawTTBall(tt.ball); }
  }

  /* =========================================================
     羽球（俯視，玩家在下方，CPU 在上方）
     ========================================================= */
  const BD = { x0: 524, x1: 756, dx0: 504, dx1: 776, y0: 60, y1: 660, net: 360, shortP: 449, shortC: 271, netH: 30 };
  const SHOT = {
    clear: { apex: 230, T: 1.35 },
    serve: { apex: 200, T: 1.4 },
    drop:  { apex: 80,  T: 1.25 }, // 吊球：慢、落在網前
    smash: { apex: 12,  T: 0.55 }, // 殺球：快、往下壓
  };
  let bd = null;

  function bdInit() {
    bd = {
      sh: { x: 640, y: 500, z: 50, sx: 0, sy: 0, sz: 0, tx: 0, ty: 0, apex: 0, T: 1, t: 0,
            flying: false, dead: false, netFail: false, type: 'clear', hx: 0, hy: -1 },
      me: { x: 700, y: 480, swing: 0, swingType: 'clear', anim: 0, walk: 0 },
      cpu: { x: 580, y: 200, react: 0, anim: 0, walk: 0 },
      hitter: 'p', hits: { p: 0, c: 0 }, wait: 1, serverX: 700, targetRight: false,
    };
  }

  function bdNewPoint() {
    const s = bd.sh, me = bd.me, cpu = bd.cpu;
    bd.hits = { p: 0, c: 0 };
    bd.wait = 1.1;
    Object.assign(s, { flying: false, dead: false, netFail: false, t: 0 });
    if (match.server === 'p') {
      // 分數雙數從右區發，單數從左區（從自己的方向看）
      me.x = match.score.p % 2 === 0 ? 700 : 580;
      me.y = 480;
      cpu.x = me.x > 640 ? 580 : 700;
      cpu.y = 200;
      bd.serverX = me.x;
    } else {
      // CPU 面向下方，它的右區在畫面左邊
      cpu.x = match.score.c % 2 === 0 ? 580 : 700;
      cpu.y = 240;
      me.x = cpu.x > 640 ? 580 : 700;
      me.y = 520;
      bd.serverX = cpu.x;
    }
    bd.targetRight = !(bd.serverX > 640); // 斜對角
  }

  function bdLaunch(type, tx, ty, m) {
    const s = bd.sh;
    s.sx = s.x; s.sy = s.y;
    s.sz = type === 'smash' ? 110 : type === 'drop' ? 70 : clamp(s.z, 55, 120);
    s.tx = tx; s.ty = ty;
    s.type = type;
    s.apex = SHOT[type].apex;
    s.T = SHOT[type].T / m;
    s.t = 0;
    s.flying = true;
    s.dead = false;
  }

  function bdServe(who) {
    const cfg = match.cfg, s = bd.sh;
    bd.hits[who]++;
    bd.hitter = who;
    match.state = 'play';
    const m = shotMult(bd.hits[who]);
    match.speed = m;
    const right = bd.targetRight;
    const tx = right ? rand(670, BD.x1 - 20) : rand(BD.x0 + 20, 610);
    let ty, netFail = false;
    if (who === 'p') {
      ty = rand(BD.y0 + 25, BD.shortC - 45);
      bd.me.anim = 0.25;
      bd.cpu.react = cfg.react;
    } else {
      ty = rand(BD.shortP + 45, BD.y1 - 25);
      if (Math.random() < cfg.err * 0.5) {
        if (Math.random() < 0.5) netFail = true; else ty = BD.shortP - 30; // 發太短
      }
      bd.cpu.anim = 0.25;
    }
    bdLaunch('serve', tx, ty, m);
    s.netFail = netFail;
    sfx.hit();
  }

  function bdPress(type) {
    if (!match || match.state === 'over') return;
    if (match.state === 'serve') {
      if (match.server === 'p') bdServe('p');
      return;
    }
    if (type === 'serve') return;
    bd.me.swing = 0.28;      // 揮拍有效時間
    bd.me.swingType = type;
    bd.me.anim = 0.25;
  }

  function bdHittable(who) {
    const s = bd.sh;
    if (!s.flying || s.dead || match.state !== 'play' || bd.hitter === who) return false;
    const p = who === 'p' ? bd.me : bd.cpu;
    const onSide = who === 'p' ? s.y > BD.net : s.y < BD.net;
    const reach = who === 'p' ? 58 : 50 + match.cfg.reach;
    return onSide && s.z < 150 && Math.hypot(s.x - p.x, s.y - p.y) < reach;
  }

  function bdHit(who, type, tx, ty, netFail) {
    bd.hits[who]++;
    bd.hitter = who;
    const m = shotMult(bd.hits[who]);
    match.speed = m;
    bdLaunch(type, tx, ty, m);
    bd.sh.netFail = !!netFail;
    if (type === 'smash') sfx.smash(); else sfx.hit();
  }

  function bdPlayerHit(type) {
    const m = shotMult(bd.hits.p + 1);
    const jit = (m - 1) * 25 + 12;   // 球速越快，落點越不穩
    const L = keys.ArrowLeft, R = keys.ArrowRight;
    let tx;
    if (L && !R) tx = rand(BD.x0 + 14, BD.x0 + 60);
    else if (R && !L) tx = rand(BD.x1 - 60, BD.x1 - 14);
    else tx = 640 + rand(-55, 55);
    tx += rand(-jit, jit);
    let ty;
    if (type === 'clear') ty = rand(BD.y0 + 18, BD.y0 + 85) + rand(-jit, jit * 0.5);
    else if (type === 'drop') ty = rand(BD.net - 100, BD.net - 40);
    else ty = rand(BD.y0 + 70, BD.y0 + 190);
    bd.cpu.react = match.cfg.react;
    bdHit('p', type, tx, ty, false);
  }

  function bdCpuHit() {
    const s = bd.sh, d = match.diff, cfg = match.cfg;
    let type = 'clear';
    const r = Math.random();
    if (d === 'hard') {
      if (s.z > 55 && (s.type === 'clear' || s.type === 'serve') && r < 0.4) type = 'smash';
      else if (r < 0.65) type = 'drop';
    } else if (d === 'normal') {
      if (r < 0.15) type = 'drop';
    }
    let tx = d === 'hard'
      ? (bd.me.x > 640 ? rand(BD.x0 + 15, 600) : rand(680, BD.x1 - 15))
      : rand(BD.x0 + 25, BD.x1 - 25);
    let ty = type === 'clear' ? rand(BD.y1 - 85, BD.y1 - 18)
      : type === 'drop' ? rand(BD.net + 40, BD.net + 95)
      : rand(BD.y1 - 200, BD.y1 - 70);
    let netFail = false;
    if (Math.random() < cfg.err) {
      const e = Math.random();
      if (e < 0.5) netFail = true;
      else if (e < 0.75) tx = Math.random() < 0.5 ? BD.x0 - 30 : BD.x1 + 30;
      else ty = BD.y1 + 30;
    }
    bd.cpu.anim = 0.25;
    bdHit('c', type, tx, ty, netFail);
  }

  function bdLand() {
    const s = bd.sh, h = bd.hitter, o = other(h);
    const side = s.y > BD.net ? 'p' : 'c';
    let inb;
    if (s.type === 'serve') {
      const xOk = bd.targetRight ? s.x >= 640 && s.x <= BD.x1 : s.x >= BD.x0 && s.x <= 640;
      const yOk = o === 'c' ? s.y >= BD.y0 && s.y <= BD.shortC : s.y >= BD.shortP && s.y <= BD.y1;
      inb = side === o && xOk && yOk;
    } else {
      inb = side === o && s.x >= BD.x0 && s.x <= BD.x1 && s.y >= BD.y0 && s.y <= BD.y1;
    }
    addFx(s.x, s.y, inb ? 'rgba(255,255,255,0.9)' : 'rgba(208,80,60,0.95)');
    if (inb) awardPoint(h, o === 'p' ? '沒接到' : 'CPU 沒接到');
    else awardPoint(o, s.type === 'serve' ? '發球沒有落在發球區' : '出界');
  }

  function bdUpdate(dt) {
    const s = bd.sh, me = bd.me, cpu = bd.cpu, cfg = match.cfg;
    me.anim = Math.max(0, me.anim - dt);
    cpu.anim = Math.max(0, cpu.anim - dt);

    // 玩家移動（發球時固定在發球位置）
    const lockMe = match.state === 'serve' && match.server === 'p';
    if (!lockMe && match.state !== 'over') {
      const dx = (keys.ArrowRight ? 1 : 0) - (keys.ArrowLeft ? 1 : 0);
      const dy = (keys.ArrowDown ? 1 : 0) - (keys.ArrowUp ? 1 : 0);
      if (dx || dy) {
        const l = Math.hypot(dx, dy);
        me.x += (dx / l) * 330 * dt;
        me.y += (dy / l) * 330 * dt;
        me.walk += dt * 12;
      }
      me.x = clamp(me.x, 440, 840);
      me.y = clamp(me.y, BD.net + 18, 705);
    }

    if (match.state === 'serve') {
      if (match.server === 'p') { s.x = me.x + 14; s.y = me.y - 20; s.z = 50; s.hx = 0; s.hy = -1; }
      else {
        s.x = cpu.x - 14; s.y = cpu.y + 20; s.z = 50; s.hx = 0; s.hy = 1;
        bd.wait -= dt;
        if (bd.wait <= 0) bdServe('c');
      }
      updateFx(dt);
      return;
    }

    // 羽球飛行：水平方向會減速（ease-out），高度是拋物線
    if (s.flying) {
      if (s.dead) {
        s.z = Math.max(0, s.z - 260 * dt);
        if (s.z === 0) s.flying = false;
      } else {
        const px = s.x, py = s.y;
        s.t += dt;
        const u = Math.min(1, s.t / s.T);
        const e = 1 - Math.pow(1 - u, 1.7);
        s.x = s.sx + (s.tx - s.sx) * e;
        s.y = s.sy + (s.ty - s.sy) * e;
        s.z = s.sz * (1 - u) + s.apex * 4 * u * (1 - u);
        if (Math.hypot(s.x - px, s.y - py) > 0.3) { s.hx = s.x - px; s.hy = s.y - py; }
        if (match.state === 'play') {
          if ((py - BD.net) * (s.y - BD.net) < 0 && (s.z < BD.netH || s.netFail)) {
            s.dead = true;
            s.y = BD.net + (py > BD.net ? 8 : -8);
            awardPoint(other(bd.hitter), '掛網');
          } else if (u >= 1) {
            s.z = 0;
            s.flying = false;
            bdLand();
          }
        } else if (u >= 1) { s.z = 0; s.flying = false; }
      }
    }

    // 玩家擊球：按下 J/K/L 後的短時間內，球在範圍內就打得到
    if (me.swing > 0) {
      me.swing -= dt;
      if (bdHittable('p')) { bdPlayerHit(me.swingType); me.swing = 0; }
    }

    // CPU
    if (match.state === 'play' && bd.hitter === 'p' && s.flying && !s.dead) {
      cpu.react -= dt;
      if (cpu.react <= 0) {
        const bx = cpu.x, by = cpu.y;
        moveToward(cpu, s.tx, s.ty - 8, cfg.move, dt);
        if (Math.hypot(cpu.x - bx, cpu.y - by) > 0.5) cpu.walk += dt * 12;
      }
      if (bdHittable('c')) bdCpuHit();
    } else if (match.state === 'play') {
      moveToward(cpu, 640, 200, cfg.move * 0.6, dt);
    }
    cpu.x = clamp(cpu.x, 440, 840);
    cpu.y = clamp(cpu.y, 40, BD.net - 18);
    updateFx(dt);
  }

  function paintBD(g) {
    g.fillStyle = C.wall;
    g.fillRect(0, 0, W, H);
    paintFloor(g, 410, 0, 460, H);
    paintBoards(g, { x: 410, y: -20, w: 460, h: 760 }, null, '');
    g.strokeStyle = '#fff';
    g.lineWidth = 3;
    g.strokeRect(BD.dx0, BD.y0, BD.dx1 - BD.dx0, BD.y1 - BD.y0);  // 雙打外框
    line(g, BD.x0, BD.y0, BD.x0, BD.y1);                         // 單打邊線
    line(g, BD.x1, BD.y0, BD.x1, BD.y1);
    line(g, BD.dx0, BD.shortC, BD.dx1, BD.shortC);               // 前發球線
    line(g, BD.dx0, BD.shortP, BD.dx1, BD.shortP);
    line(g, BD.dx0, BD.y0 + 34, BD.dx1, BD.y0 + 34);             // 雙打後發球線
    line(g, BD.dx0, BD.y1 - 34, BD.dx1, BD.y1 - 34);
    line(g, 640, BD.y0, 640, BD.shortC);                         // 中線
    line(g, 640, BD.shortP, 640, BD.y1);
    // 單打範圍淡淡標示
    g.fillStyle = 'rgba(255,255,255,0.035)';
    g.fillRect(BD.x0, BD.y0, BD.x1 - BD.x0, BD.y1 - BD.y0);
    // 網子
    g.fillStyle = 'rgba(0,0,0,0.3)';
    g.fillRect(BD.dx0 - 10, BD.net + 4, BD.dx1 - BD.dx0 + 20, 8);
    g.fillStyle = '#1b2023';
    g.fillRect(BD.dx0 - 10, BD.net - 3, BD.dx1 - BD.dx0 + 20, 6);
    g.fillStyle = '#fff';
    g.fillRect(BD.dx0 - 10, BD.net - 3, BD.dx1 - BD.dx0 + 20, 2);
    g.fillStyle = '#d9dde0';
    g.fillRect(BD.dx0 - 18, BD.net - 6, 10, 12);
    g.fillRect(BD.dx1 + 8, BD.net - 6, 10, 12);
    g.fillStyle = 'rgba(255,255,255,0.4)';
    g.font = `700 12px ${FONT}`;
    g.textAlign = 'left';
    g.fillText('← 單打邊線', BD.dx1 + 8, BD.y1 - 40);
  }

  function drawShuttle(s) {
    ctx.fillStyle = `rgba(0,0,0,${Math.max(0.1, 0.38 - s.z / 500)})`;
    ctx.beginPath(); ctx.ellipse(s.x, s.y, 7, 5, 0, 0, Math.PI * 2); ctx.fill();
    const sc = 1 + s.z / 240;
    const px = s.x, py = s.y - s.z * 0.5;
    const len = Math.hypot(s.hx, s.hy) || 1;
    const ang = Math.atan2(s.hy / len, s.hx / len);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(ang);
    ctx.scale(sc, sc);
    // 羽毛在後面
    ctx.fillStyle = '#f7f7f2';
    ctx.strokeStyle = '#b9bbb4';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(-2, -3);
    ctx.lineTo(-15, -8);
    ctx.lineTo(-15, 8);
    ctx.lineTo(-2, 3);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    line(ctx, -2, 0, -15, 0);
    // 球頭
    ctx.fillStyle = '#e8d7b0';
    ctx.beginPath(); ctx.arc(1, 0, 4, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function drawBD() {
    ctx.drawImage(bgBD, 0, 0);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = `700 14px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textAlign = 'left';
    ctx.fillText('CPU', BD.dx1 + 34, 66);
    ctx.textAlign = 'center';
    drawFx();
    const s = bd.sh;
    const swingOf = (p) => (p.anim > 0 ? 1 - p.anim / 0.25 : 0);
    drawPerson(bd.cpu.x, bd.cpu.y, Math.PI / 2, '#3d4a55', bd.cpu.walk, { swing: swingOf(bd.cpu), color: '#d9dde0' });
    const shuttleFront = s.y > bd.me.y;
    if (!shuttleFront) drawShuttle(s);
    drawPerson(bd.me.x, bd.me.y, -Math.PI / 2, C.amber, bd.me.walk, { swing: swingOf(bd.me), color: C.red });
    if (shuttleFront) drawShuttle(s);

    // 剛按的擊球種類
    if (bd.me.anim > 0 && match.state === 'play') {
      const label = { clear: '回球', smash: '殺球', drop: '吊球' }[bd.me.swingType];
      ctx.fillStyle = C.amber;
      ctx.font = `900 15px ${FONT}`;
      ctx.fillText(label, bd.me.x, bd.me.y + 38);
    }
  }

  /* =========================================================
     提示列、背景、主迴圈
     ========================================================= */
  function setHint() {
    const h = $('hint');
    let html;
    if (scene === 'match' && match && match.sport === 'tt') {
      html = '<span><kbd>滑鼠</kbd>移動球拍</span><span><kbd>左鍵</kbd>發球</span><span>球在你這邊彈一次後，碰到球拍就會自動回擊</span><span><kbd>Esc</kbd>暫停</span>';
    } else if (scene === 'match' && match && match.sport === 'bd') {
      html = '<span><kbd>←↑→↓</kbd>移動</span><span><kbd>J</kbd>一般回球</span><span><kbd>K</kbd>殺球</span><span><kbd>L</kbd>吊球</span><span>擊球時按住 <kbd>←</kbd>/<kbd>→</kbd> 控制落點</span><span><kbd>Space</kbd>發球</span><span><kbd>Esc</kbd>暫停</span>';
    } else {
      html = '<span><kbd>←↑→↓</kbd>走動</span><span>走到球場門口，按 <kbd>Enter</kbd> 或點按鈕加入比賽</span>';
    }
    h.innerHTML = html;
  }

  let bgLobby, bgTT, bgBD;
  function makeLayer(paint) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.textAlign = 'center';
    paint(g);
    return c;
  }
  function buildBackgrounds() {
    bgLobby = makeLayer(paintLobby);
    bgTT = makeLayer(paintTT);
    bgBD = makeLayer(paintBD);
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.033, (now - last) / 1000);
    last = now;
    if (scene === 'lobby') updateLobby(dt);
    else if (scene === 'match' && !paused && match.state !== 'over') updateMatch(dt);

    ctx.textAlign = 'center';
    if (scene === 'match' && match) {
      if (match.sport === 'tt') drawTT(); else drawBD();
      drawHUD();
    } else {
      drawLobby();
    }
    requestAnimationFrame(frame);
  }

  buildBackgrounds();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(buildBackgrounds);
  setHint();
  requestAnimationFrame(frame);
})();

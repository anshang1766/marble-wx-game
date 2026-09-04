const Matter = require('./matter.js');
const canvas = wx.createCanvas();
const ctx = canvas.getContext('2d');
const info = wx.getSystemInfoSync();
const dpr = info.pixelRatio || 1;
const width = info.windowWidth;
const height = info.windowHeight;
canvas.width = width * dpr;
canvas.height = height * dpr;
ctx.scale(dpr, dpr);
const frame = typeof wx.requestAnimationFrame === 'function' ? (fn) => wx.requestAnimationFrame(fn) : (fn) => setTimeout(fn, 16);
const { Engine, World, Bodies, Body } = Matter;
const engine = Engine.create({ enableSleeping: false });
engine.gravity.y = 0.85;
engine.positionIterations = 8;
engine.velocityIterations = 8;
engine.constraintIterations = 4;
const boardWidth = Math.min(width * 0.6, 420);
const left = (width - boardWidth) / 2;
const right = left + boardWidth;
const top = Math.max(120, height * 0.16);
const bottom = Math.min(height - 160, top + Math.max(360, height * 0.6));
const rows = 11;
const cols = 10;
// 钉子群单独缩小并下移，给右侧合并赛道留出完整的转弯空间。
const pegWidth = boardWidth;
const pegLeft = (width - pegWidth) / 2;
const pegGapX = pegWidth / (cols - 1);
const pegTop = Math.min(bottom - 240, top + 74);
const pegBottom = bottom - 18;
const pegGapY = (pegBottom - pegTop) / (rows - 1);
const slotCount = 10;
const slotWidth = boardWidth / slotCount;
const trackX = width - 42;
const trackRadius = 18;
// 赛道从右侧上行，在第一排钉子上方平滑转向后进入板面。
const trackExitY = top + 18;
const trackExitX = right - 14;
// —— 蓄力-弹道能量模型 ——
// 轨道段以 RAIL_T 为显示时间系数: 位移 = 物理速度×RAIL_T, 减速 = RAIL_G×RAIL_T。
// 为让"轨道重力手感"与板内一致, 需 RAIL_G×RAIL_T² = 0.28×gravity.y(=0.238), 故 RAIL_G=0.95。
// 出弯初速同样按 RAIL_T 缩放 → 轨道末端速度与进板速度连续(仅剩弯道摩擦 8% 损耗)。
// RAIL_F 决定过弯临界力度 ≈50: 低于临界冲不上弯道、自然回落(不扣弹珠, 可重新蓄力);
// 满力 100 → 净空带横穿, 撞到对侧边界反弹。
const RAIL_G = 0.95;
const RAIL_F = 1.1;
const RAIL_K = 0.92;
const RAIL_T = 0.5;
const RAIL_UP_T = RAIL_T;
const RAIL_DOWN_T = RAIL_T;
const RAIL_RETURN_G = 4; // 回落段重力倍数(快速滑回发射口, 减少低力度试射的等待)
const EXIT_VY = -0.8; // 出弯口上抛(负=向上, 显示速度), 让弹道更平、贴钉阵上方净空带飞到对侧
const AIR_DAMP = 0.004; // 弹珠空气阻力(轻微, 保留滚动余量)
// 由蓄力力度计算发射参数(初始上升速度 v0 / 发射点 startY)
function launchEnergy(power) {
  const startY = bottom - 10 - power * 0.22;
  const hTop100 = Math.max(0, bottom - 32 - trackExitY);
  const vRem100 = Math.sqrt(RAIL_F * 2 * RAIL_G * hTop100);
  const a2 = (vRem100 * vRem100 + 2 * RAIL_G * hTop100) / 100;
  return { v0: Math.sqrt(a2 * power), startY };
}
function trackGeometry(startY) {
  const centerX = trackX - trackRadius;
  const centerY = trackExitY + trackRadius;
  const verticalLength = Math.max(36, startY - centerY);
  const arcLength = Math.PI * trackRadius * 0.5;
  const horizontalLength = Math.max(12, centerX - trackExitX);
  return { centerX, centerY, verticalLength, arcLength, horizontalLength, total: verticalLength + arcLength + horizontalLength };
}
function trackPoint(t, startY) {
  const g = trackGeometry(startY);
  let distance = Math.max(0, Math.min(1, t)) * g.total;
  if (distance <= g.verticalLength) return { x: trackX, y: startY - distance };
  distance -= g.verticalLength;
  if (distance <= g.arcLength) {
    const angle = -distance / trackRadius;
    return { x: g.centerX + trackRadius * Math.cos(angle), y: g.centerY + trackRadius * Math.sin(angle) };
  }
  distance -= g.arcLength;
  return { x: g.centerX - Math.min(g.horizontalLength, distance), y: trackExitY };
}
function drawTrackPath(startY) {
  ctx.moveTo(trackX, startY);
  for (let i = 1; i <= 56; i += 1) { const p = trackPoint(i / 56, startY); ctx.lineTo(p.x, p.y); }
}
const pegs = [];
for (let row = 0; row < rows; row += 1) {
  for (let col = 0; col < cols; col += 1) {
    const x = row % 2 ? pegLeft + pegGapX * 0.5 + col * pegGapX : pegLeft + col * pegGapX;
    if (x <= pegLeft + pegWidth) pegs.push({ x, y: pegTop + row * pegGapY, boost: row === 2 || row === rows - 3, damp: row === 0 || row === 1 });
  }
}
// 注意: Matter 的 Body.setStatic 会把 isStatic 刚体的 restitution 清零(friction 设为 1),
// 所以钉子弹性必须在创建后回写, 否则三种钉物理上完全一样。
// 另: 碰撞弹性取两者较大值(pair.restitution = max), 故小球自身弹性必须 ≤ 最低档(蓝钉), 差异才不会被盖掉。
const pegBodies = pegs.map((p) => { const b = Bodies.circle(p.x, p.y, 4.5, { isStatic: true, friction: p.damp ? 0.05 : 0.02, frictionStatic: 0 }); b.restitution = p.boost ? 1.08 : (p.damp ? 0.1 : 0.55); return b; });
const walls = [Bodies.rectangle(left - 8, (top + bottom) / 2, 16, bottom - top + 60, { isStatic: true, frictionStatic: 0 }), Bodies.rectangle(right + 8, (top + bottom) / 2, 16, bottom - top + 60, { isStatic: true, frictionStatic: 0 }), Bodies.rectangle((left + right) / 2, bottom + 54, boardWidth + 32, 16, { isStatic: true, frictionStatic: 0 })]; walls[0].restitution = 0.5; walls[1].restitution = 0.5; walls[2].restitution = 0.25;
const dividerH = 30, dividers = [];
for (let i = 1; i < slotCount; i += 1) dividers.push(Bodies.rectangle(left + i * slotWidth, bottom + 31, 4, dividerH, { isStatic: true, frictionStatic: 0, restitution: 0.3 }));
World.add(engine.world, pegBodies.concat(walls, dividers));
const skins = [{ name: '经典银', color: '#f4f6f8', cost: 0 }, { name: '深海蓝', color: '#49a8ff', cost: 0 }, { name: '赤焰红', color: '#ff5064', cost: 0 }, { name: '鎏金', color: '#ffd34d', cost: 0 }, { name: '极光', color: '#52e9c0', cost: 0 }, { name: '紫电', color: '#b26cff', cost: 0 }, { name: '黑洞', color: '#2b2150', cost: 0 }];
const backgrounds = [{ name: '夜幕', color: '#11151a', cost: 0 }, { name: '深空', color: '#081a32', cost: 0 }, { name: '霓虹', color: '#21112e', cost: 0 }];
const trails = [{ name: '无拖尾', cost: 0 }, { name: '流光拖尾', cost: 0 }, { name: '星尘拖尾', cost: 0 }, { name: '炫彩拖尾', cost: 0 }];
const halos = [{ name: '无光环', cost: 0 }, { name: '微光环', cost: 0 }, { name: '星光环', cost: 0 }, { name: '炫彩光环', cost: 0 }];
const today = new Date().toISOString().slice(0, 10);
const saved = wx.getStorageSync('galtonGame') || {};
const ownedDefault = { skins: [0, saved.skin || 0].filter((v, i, a) => a.indexOf(v) === i), bgs: [0, saved.bg || 0].filter((v, i, a) => a.indexOf(v) === i), trails: [0, saved.trail || 0].filter((v, i, a) => a.indexOf(v) === i), halos: [0, saved.halo || 0].filter((v, i, a) => a.indexOf(v) === i) };
const owned = saved.owned ? { ...ownedDefault, ...saved.owned } : ownedDefault;
if (!Array.isArray(owned.halos) || owned.halos.length === 0) owned.halos = [0];
const state = { marbles: Number.isFinite(saved.marbles) ? saved.marbles : 1000, diamonds: Number.isFinite(saved.diamonds) ? saved.diamonds : 0, wager: 20, freeClaims: saved.freeDate === today ? (saved.freeClaims || 0) : 0, power: 0, powerDir: 1, powerShow: 0, powerKeep: 0, charging: false, phase: 'confirm', randomizing: false, running: false, ball: null, multiplier: 0, multiplierReady: false, lit: new Set(), shop: false, modal: false, skin: saved.skin || 0, bg: saved.bg || 0, trail: saved.trail || 0, halo: saved.halo || 0, owned };
function save() { wx.setStorageSync('galtonGame', { marbles: state.marbles, diamonds: state.diamonds, freeClaims: state.freeClaims, freeDate: today, skin: state.skin, bg: state.bg, trail: state.trail, halo: state.halo, owned: state.owned }); }
const uiWager = { mX: 0, pX: 0, y: 0, s: 0 }; const shopBtn = { x: 0, y: 0, w: 54, h: 30 }; const shopItems = [];
function hexToRgba(hex, a) { const h = hex.replace('#', ''); const r = parseInt(h.substring(0, 2), 16), g = parseInt(h.substring(2, 4), 16), b = parseInt(h.substring(4, 6), 16);   return `rgba(${r},${g},${b},${a})`; }
function drawSettleFx(b) {
  const sx = left + b.slot * slotWidth + slotWidth / 2;
  const cy = bottom + 42;
  const t = b.settleFrames;
  const p = Math.min(t / 45, 1);
  if (state.skin === 3) {
    ctx.strokeStyle = '#ffd35a'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(sx, cy, 10 + Math.sin(t * 0.35) * 4, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = Math.max(0, 1 - p);
    ctx.strokeStyle = 'rgba(255,211,90,.6)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(sx, cy, 8 + p * 16, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;
  } else if (state.skin === 4) {
    for (let q = 0; q < 3; q += 1) {
      const pp = Math.max(0, Math.min(1, (t - q * 8) / 40));
      ctx.globalAlpha = (1 - pp) * 0.7;
      ctx.strokeStyle = '#52e9c0'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(sx, cy, 6 + pp * 20, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  } else if (state.skin === 5) {
    const bolts = 7;
    const blink = (t % 6) < 3 ? 1 : 0.4;
    ctx.globalAlpha = blink;
    ctx.strokeStyle = '#c9a3ff'; ctx.lineWidth = 2;
    for (let q = 0; q < bolts; q += 1) {
      const ang = (q / bolts) * Math.PI * 2 + t * 0.05;
      const len = 14 + (t % 12);
      let px = sx, py = cy;
      ctx.beginPath(); ctx.moveTo(px, py);
      const segs = 3;
      for (let s = 1; s <= segs; s += 1) {
        const r = len * (s / segs);
        const jit = Math.sin(q * 3 + s + t) * 4;
        px = sx + Math.cos(ang) * r + Math.cos(ang + 1.57) * jit;
        py = cy + Math.sin(ang) * r + Math.sin(ang + 1.57) * jit;
        ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 0.8 * blink;
    ctx.fillStyle = '#e6d4ff';
    ctx.beginPath(); ctx.arc(sx, cy, 3, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  } else if (state.skin === 6) {
    const disc = 16 + p * 10;
    ctx.save();
    ctx.translate(sx, cy);
    ctx.rotate(t * 0.15);
    ctx.strokeStyle = 'rgba(150,90,255,.7)'; ctx.lineWidth = 3;
    for (let a = 0; a < 3; a += 1) {
      ctx.beginPath();
      ctx.arc(0, 0, disc - a * 4, a * 2, a * 2 + Math.PI * 1.3);
      ctx.stroke();
    }
    ctx.restore();
    const cr = 6 + p * 8;
    const g = ctx.createRadialGradient(sx, cy, 1, sx, cy, cr);
    g.addColorStop(0, '#000000');
    g.addColorStop(0.7, '#0a0418');
    g.addColorStop(1, 'rgba(40,10,70,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(sx, cy, cr, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  }
}
function draw() {
  ctx.fillStyle = backgrounds[state.bg].color; ctx.fillRect(0, 0, width, height); ctx.fillStyle = '#171c22'; ctx.fillRect(left - 8, top - 18, boardWidth + 16, bottom - top + 42);
  ctx.fillStyle = '#fff'; ctx.font = 'bold 18px sans-serif'; ctx.fillText('弹珠爽', 20, 72); ctx.font = 'bold 16px sans-serif'; ctx.fillStyle = '#f4f1e8'; ctx.fillText(`弹珠 ${state.marbles}`, 20, 98); ctx.fillStyle = '#70e8ff'; ctx.fillText(`◆ ${state.diamonds}`, 20, 120);
  pegs.forEach((p) => { if (p.damp) { ctx.fillStyle = 'rgba(70,150,255,.22)'; ctx.beginPath(); ctx.arc(p.x, p.y, 11, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = 'rgba(91,169,255,.9)'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(p.x, p.y, 11, 0, Math.PI * 2); ctx.stroke(); } if (p.boost) { ctx.fillStyle = 'rgba(80,225,160,.22)'; ctx.beginPath(); ctx.arc(p.x, p.y, 11, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = 'rgba(93,226,165,.95)'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(p.x, p.y, 11, 0, Math.PI * 2); ctx.stroke(); } ctx.fillStyle = p.damp ? '#7cc0ff' : (p.boost ? '#a8f7d6' : '#68737e'); ctx.beginPath(); ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2); ctx.fill(); });
  const slotTop = bottom + 28, slotBot = bottom + 46; for (let i = 0; i < slotCount; i += 1) { const x = left + i * slotWidth; ctx.fillStyle = state.lit.has(i) ? '#ffd35a' : '#39414b'; ctx.fillRect(x + 2, slotTop, slotWidth - 4, 7); } ctx.strokeStyle = '#343c46'; ctx.lineWidth = 2; for (let i = 0; i <= slotCount; i += 1) { if (i === 0 || i === slotCount) { const x = left + i * slotWidth; ctx.beginPath(); ctx.moveTo(x, slotTop - 12); ctx.lineTo(x, slotBot); ctx.stroke(); } } for (let i = 1; i < slotCount; i += 1) { const x = left + i * slotWidth; ctx.fillStyle = '#39414b'; ctx.beginPath(); ctx.moveTo(x, slotTop - 12); ctx.lineTo(x + 2, slotBot); ctx.lineTo(x - 2, slotBot); ctx.closePath(); ctx.fill(); ctx.strokeStyle = '#4a5560'; ctx.lineWidth = 1; ctx.stroke(); } ctx.fillStyle = '#20262e'; ctx.fillRect(left - 2, slotBot, boardWidth + 4, 12); ctx.fillStyle = '#3a434d'; ctx.fillRect(left - 2, slotBot, boardWidth + 4, 2);
const trackStartY = state.ball && state.ball.phase === 'rail' ? state.ball.startY : bottom - 10 - (state.charging ? state.power * 0.22 : 0);
  ctx.strokeStyle = '#5a6572'; ctx.lineWidth = 9; ctx.lineCap = 'round'; ctx.beginPath(); drawTrackPath(trackStartY); ctx.stroke();
  ctx.strokeStyle = '#aeb8c5'; ctx.lineWidth = 2; ctx.beginPath(); drawTrackPath(trackStartY); ctx.stroke();
  const rodY = bottom - 10 - (state.charging ? state.power * 0.22 : 0);
  ctx.strokeStyle = '#e23d48'; ctx.lineWidth = 7; ctx.beginPath(); ctx.moveTo(trackX, rodY); ctx.lineTo(trackX, bottom + 3); ctx.stroke(); ctx.fillStyle = '#f24b55'; ctx.fillRect(trackX - 12, rodY - 4, 24, 8);
  ctx.strokeStyle = '#f3c84b'; ctx.lineWidth = 2; ctx.beginPath(); for (let i = 0; i < 10; i += 1) { const sx = trackX + (i % 2 ? 6 : -6); const sy = rodY - i * 3; if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy); } ctx.stroke(); const pbTop = bottom + 14; const pbBottom = bottom + 80; const pbW = 12; const pbh = pbBottom - pbTop; ctx.fillStyle = '#171d24'; ctx.fillRect(trackX - pbW / 2 - 1, pbTop - 1, pbW + 2, pbh + 2); ctx.fillStyle = '#232b34'; ctx.fillRect(trackX - pbW / 2, pbTop, pbW, pbh); const pfill = Math.max(0, Math.min(100, state.powerShow)) / 100; const pfh = Math.round(pbh * pfill); ctx.fillStyle = state.charging ? '#ff5b66' : '#f3c84b'; ctx.fillRect(trackX - pbW / 2, pbBottom - pfh, pbW, pfh); ctx.strokeStyle = '#4a5560'; ctx.lineWidth = 1; ctx.strokeRect(trackX - pbW / 2 - 0.5, pbTop - 0.5, pbW + 1, pbh + 1); ctx.fillStyle = '#f3c84b'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(`${Math.round(state.powerShow)}%`, trackX, pbBottom + 13); ctx.textAlign = 'start'; const topInfoY = trackExitY - 12; const rdT = state.multiplierReady; const predN = rdT ? state.multiplier * state.wager : 0; ctx.font = 'bold 20px sans-serif'; const predD = Math.floor(predN / 50); const dText = `钻石 ${predD}`; const mText = `弹珠 ${predN}`; const dW = ctx.measureText ? ctx.measureText(dText).width : 70; const mW = ctx.measureText ? ctx.measureText(mText).width : 90; const gap = 18; const startX = Math.max(8, (width - (dW + gap + mW)) / 2); ctx.textAlign = 'left'; ctx.fillStyle = rdT ? '#ffffff' : '#6b7480'; ctx.fillText(mText, startX, topInfoY); ctx.fillStyle = rdT ? '#70e8ff' : '#6b7480'; ctx.fillText(dText, startX + mW + gap, topInfoY); ctx.textAlign = 'start';
  if (state.ball && state.ball.trail && state.ball.trail.length > 1 && state.trail > 0) { const tr = state.ball.trail; const n = tr.length; for (let k = 0; k < n; k += 1) { const tt = (k + 1) / n; const tf = state.ball.trailFade || 0; const fade = tf > 0 ? Math.max(0, 1 - tf / 32) : 1; const alpha = tt * tt * 0.55 * fade; let col; if (state.trail >= 3) { const hue = Math.round((k / n) * 300); col = `hsla(${hue},90%,62%,${alpha})`; } else { col = hexToRgba(skins[state.skin].color, alpha); } ctx.fillStyle = col; const r = 4.2 * (0.3 + 0.7 * tt); ctx.beginPath(); ctx.arc(tr[k].x, tr[k].y, r, 0, Math.PI * 2); ctx.fill(); } }
  if (state.ball) { if (state.ball.phase === 'settle') drawSettleFx(state.ball); if (state.halo > 0) { for (let ring = 1; ring <= state.halo; ring += 1) { const rr = 4.2 + ring * 3; const a = 0.4 - ring * 0.1; if (state.halo >= 3 && ring % 2 === 0) ctx.strokeStyle = `hsla(${(ring * 90) % 360},90%,62%,${a})`; else if (state.halo >= 3) ctx.strokeStyle = `hsla(${(ring * 90 + 180) % 360},90%,62%,${a})`; else ctx.strokeStyle = `rgba(255,232,170,${a})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(state.ball.x, state.ball.y, rr, 0, Math.PI * 2); ctx.stroke(); } } const isBH = state.skin === 6 && state.ball.phase === 'settle'; const br = isBH ? Math.max(0.6, 4.2 * (1 - Math.min(state.ball.settleFrames / 50, 1))) : 4.2; ctx.fillStyle = skins[state.skin].color; ctx.beginPath(); ctx.arc(state.ball.x, state.ball.y, br, 0, Math.PI * 2); ctx.fill(); if (state.ball.phase === 'rail' && state.ball.v < 0) { ctx.fillStyle = '#ffcc66'; ctx.font = 'bold 13px sans-serif'; ctx.fillText('力度不足，弹珠回落', left, bottom + 18); } }
  
  if (!state.running && !state.shop) { const bx = width / 2 - 92; const by = height - 126; ctx.fillStyle = state.phase === 'charge' ? '#d83f4b' : '#2498df'; ctx.fillRect(bx, by, 184, 42); ctx.strokeStyle = '#bcecff'; ctx.lineWidth = 1; ctx.strokeRect(bx, by, 184, 42); ctx.fillStyle = '#fff'; ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; const label = state.randomizing ? '倍率随机中...' : (state.phase === 'charge' ? '长按蓄力发射' : '确认倍率'); ctx.fillText(label, width / 2, by + 21); ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic'; const wcx = width / 2; const byy = height - 44; ctx.font = 'bold 15px sans-serif'; const rdy2 = state.multiplierReady; const rn2 = state.randomizing; const mtx2 = (!rdy2 && !rn2) ? '倍率 待确认' : `倍率 ×${state.multiplier}`; ctx.fillStyle = (rdy2 || rn2) ? '#ffd35a' : '#7d8791'; ctx.fillText(mtx2, 18, byy); const rateW2 = ctx.measureText ? ctx.measureText(mtx2).width : 90; const btnY = height - 60; const btnS = 24; const minusX = Math.max(wcx - 72, 18 + rateW2 + 14); ctx.fillStyle = '#2d3640'; ctx.fillRect(minusX, btnY, btnS, btnS); ctx.strokeStyle = '#4a5560'; ctx.lineWidth = 1; ctx.strokeRect(minusX, btnY, btnS, btnS); ctx.fillStyle = '#fff'; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('-', minusX + btnS / 2, byy); const numW2 = ctx.measureText ? ctx.measureText(`${state.wager}`).width : 30; const numX = minusX + btnS + 12 + numW2 / 2; ctx.fillStyle = '#ffd35a'; ctx.font = 'bold 20px sans-serif'; ctx.fillText(`${state.wager}`, numX, byy); ctx.fillStyle = '#dfe5ec'; ctx.font = 'bold 15px sans-serif'; const keW2 = ctx.measureText ? ctx.measureText('颗').width : 16; ctx.fillText('颗', numX + numW2 / 2 + 12, byy); const plusX = numX + numW2 / 2 + 12 + keW2 + 10; ctx.fillStyle = '#2d3640'; ctx.fillRect(plusX, btnY, btnS, btnS); ctx.strokeStyle = '#4a5560'; ctx.strokeRect(plusX, btnY, btnS, btnS); ctx.fillStyle = '#fff'; ctx.font = 'bold 14px sans-serif'; ctx.fillText('+', plusX + btnS / 2, byy); ctx.textAlign = 'start'; const sbx = Math.max(wcx + 52, plusX + 12); const sbw = 54; const sby = height - 62; const sbh = 30; ctx.fillStyle = '#3a2a12'; ctx.fillRect(sbx, sby, sbw, sbh); ctx.strokeStyle = '#ffd35a'; ctx.lineWidth = 1.5; ctx.strokeRect(sbx, sby, sbw, sbh); ctx.fillStyle = '#ffd35a'; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('商城', sbx + sbw / 2, sby + sbh / 2); ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic'; uiWager.mX = minusX; uiWager.pX = plusX; uiWager.y = btnY; uiWager.s = btnS; shopBtn.x = sbx; shopBtn.y = sby; shopBtn.w = sbw; shopBtn.h = sbh; }
  if (state.shop) drawShop();
}
function drawShop() {
  const px = 14, pw = width - 28, topY = 40;
  ctx.fillStyle = '#05080c';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(5,8,12,.97)';
  ctx.fillRect(12, topY, width - 24, height - 60);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 20px sans-serif';
  ctx.fillText('弹珠商城', px, topY + 30);
  ctx.font = '14px sans-serif';
  ctx.fillStyle = '#70e8ff';
  ctx.fillText(`钻石 ${state.diamonds}    弹珠 ${state.marbles}`, px, topY + 54);
  shopItems.length = 0;
  let y = topY + 68;
  const rowH = 22;
  function section(t) {
    y += 10;
    ctx.fillStyle = 'rgba(255,255,255,.08)';
    ctx.fillRect(px, y - 3, pw, 1);
    y += 5;
    ctx.font = 'bold 13px sans-serif';
    ctx.fillStyle = '#9aa4b0';
    ctx.fillText(t, px, y);
    y += 16;
  }
  function item(label, sub, active, action, arg) {
    const iy = y, ih = rowH - 4;
    ctx.fillStyle = active ? 'rgba(255,211,90,.16)' : 'rgba(255,255,255,.03)';
    ctx.fillRect(px, iy, pw, ih);
    ctx.fillStyle = active ? '#ffd35a' : '#e6ebf0';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(label, px + 10, iy + 17);
    ctx.textAlign = 'right';
    ctx.fillStyle = active ? '#ffd35a' : '#9aa4b0';
    ctx.font = '13px sans-serif';
    ctx.fillText(sub, px + pw - 12, iy + 17);
    ctx.textAlign = 'start';
    shopItems.push({ x: px, y: iy, w: pw, h: ih, action, arg });
    y += rowH;
  }
  section('弹珠皮肤（弹珠购买）');
  skins.forEach((s, i) => { const active = state.skin === i, has = state.owned.skins.indexOf(i) >= 0; const sub = active ? '使用中' : (has ? '点击装备' : (s.cost ? s.cost + ' 弹珠' : '免费')); item(s.name, sub, active, 'skin', i); });
  section('拖尾特效（钻石购买）');
  trails.forEach((t, i) => { const active = state.trail === i, has = state.owned.trails.indexOf(i) >= 0; const sub = active ? '使用中' : (has ? '点击装备' : (t.cost ? t.cost + ' 钻石' : '免费')); item(t.name, sub, active, 'trail', i); });
  section('光环（钻石购买）');
  halos.forEach((h, i) => { const active = state.halo === i, has = state.owned.halos.indexOf(i) >= 0; const sub = active ? '使用中' : (has ? '点击装备' : (h.cost ? h.cost + ' 钻石' : '免费')); item(h.name, sub, active, 'halo', i); });
  section('钻石兑换弹珠');
  item('50 钻石 → 1000 弹珠', state.diamonds >= 50 ? '点击兑换' : '钻石不足', false, 'exchange', 0);
  ctx.font = '12px sans-serif';
  ctx.fillStyle = '#6b7480';
  ctx.textAlign = 'center';
  ctx.fillText('点击空白处关闭', width / 2, height - 82);
  ctx.textAlign = 'start';
}
function handleShopTap(it) { if (it.action === 'skin') { const i = it.arg; if (state.skin === i) return; if (state.owned.skins.indexOf(i) >= 0) { state.skin = i; } else { const c = skins[i].cost; if (state.marbles >= c) { state.marbles -= c; state.owned.skins.push(i); state.skin = i; } else { wx.showToast({ title: '弹珠不足', icon: 'none' }); draw(); return; } } } else if (it.action === 'halo') { const i = it.arg; if (state.halo === i) return; if (state.owned.halos.indexOf(i) >= 0) { state.halo = i; } else { const c = halos[i].cost; if (state.diamonds >= c) { state.diamonds -= c; state.owned.halos.push(i); state.halo = i; } else { wx.showToast({ title: '钻石不足', icon: 'none' }); draw(); return; } } } else if (it.action === 'trail') { const i = it.arg; if (state.trail === i) return; if (state.owned.trails.indexOf(i) >= 0) { state.trail = i; } else { const c = trails[i].cost; if (state.diamonds >= c) { state.diamonds -= c; state.owned.trails.push(i); state.trail = i; } else { wx.showToast({ title: '钻石不足', icon: 'none' }); draw(); return; } } } else if (it.action === 'exchange') { if (state.diamonds >= 50) { state.diamonds -= 50; state.marbles += 1000; } else { wx.showToast({ title: '钻石不足', icon: 'none' }); draw(); return; } } save(); draw(); }
function randomize() { state.multiplierReady = false; state.randomizing = true; let n = 0; const timer = setInterval(() => { n += 1; const i = Math.floor(Math.random() * 4); state.multiplier = [2, 3, 5, 10][i]; const count = [5, 4, 2, 1][i]; const picks = []; while (picks.length < count) { const slot = Math.floor(Math.random() * slotCount); if (picks.indexOf(slot) < 0) picks.push(slot); } state.lit = new Set(picks); draw(); if (n >= 14) { clearInterval(timer); state.randomizing = false; state.multiplierReady = true; state.phase = 'charge'; draw(); } }, 70); }
function showFree() { if (state.marbles !== 0 || state.freeClaims >= 2 || state.modal) return; state.modal = true; wx.showModal({ title: '弹珠不足', content: `今日还剩 ${2 - state.freeClaims} 次免费领取\n每次补充 50 颗弹珠`, confirmText: '领取50颗', cancelText: '关闭', complete: (r) => { state.modal = false; if (r.confirm) { state.marbles += 50; state.freeClaims += 1; save(); draw(); } } }); }
function launch() { const launchPower = state.power; state.power = 0; state.powerShow = launchPower; state.powerKeep = 70; if (state.marbles <= 0) { showFree(); return; } const e = launchEnergy(launchPower); const tg = trackGeometry(e.startY); state.ball = { phase: 'rail', s: 0, v: e.v0, startY: e.startY, x: trackX, y: e.startY, launchPower, total: tg.total, vert: tg.verticalLength, arc: tg.arcLength, hinted: false }; state.running = true; state.phase = 'confirm'; }
let lastT = 0;
function loop() { const now = Date.now(); let dt = lastT ? now - lastT : 16.666; lastT = now; if (dt > 32) dt = 32; else if (dt < 1) dt = 16.666; const f = dt / (1000 / 60); if (state.charging) { state.power += state.powerDir * 2 * f; if (state.power >= 100) { state.power = 100; state.powerDir = -1; } if (state.power <= 0) { state.power = 0; state.powerDir = 1; } state.powerShow = state.power; } if (state.running && state.ball) { const b = state.ball; if (b.phase === 'rail') { let ce; if (b.s <= b.vert) ce = 1; else if (b.s <= b.vert + b.arc) ce = Math.cos((b.s - b.vert) / trackRadius); else ce = 0; const falling = b.v < 0; if (falling && !b.hinted) { b.hinted = true; wx.showToast({ title: '力度不足，弹珠回落', icon: 'none' }); } const kt = (falling ? RAIL_DOWN_T : RAIL_UP_T) * f; b.v -= ce * RAIL_G * (falling ? RAIL_RETURN_G : 1) * kt; b.s += b.v * kt; if (b.s <= 0) { state.ball = null; state.running = false; state.phase = 'charge'; } else if (!falling && b.s >= b.total) { const wager = Math.min(state.wager, state.marbles); state.marbles -= wager; save(); b.phase = 'board'; b.wager = wager; b.settled = false; b.ageFrames = 0; b.stillF = 0; b.nudges = 0; const exX = trackExitX + (Math.random() - 0.5) * 1.6; const body = Bodies.circle(exX, trackExitY, 4.2, { restitution: 0.3, friction: 0.03, frictionStatic: 0, frictionAir: AIR_DAMP }); World.add(engine.world, body); b.body = body; Body.setPosition(body, { x: exX, y: trackExitY }); Body.setVelocity(body, { x: (-b.v * RAIL_K + (Math.random() - 0.5) * 0.5) * RAIL_T, y: EXIT_VY + (Math.random() - 0.5) * 0.3 * RAIL_T }); Body.setAngularVelocity(body, 0); b.x = exX; b.y = trackExitY; b.lx = exX; b.ly = trackExitY; } else { const t = Math.max(0, Math.min(1, b.s / b.total)); const p = trackPoint(t, b.startY); b.x = p.x; b.y = p.y; } } else if (b.phase === 'board') { Engine.update(engine, dt); b.x = Math.max(left + 8, Math.min(right - 8, b.body.position.x)); b.y = b.body.position.y; Body.setPosition(b.body, { x: b.x, y: b.y }); b.ageFrames += 1; const moved = Math.hypot(b.x - b.lx, b.y - b.ly); b.lx = b.x; b.ly = b.y; if (moved < 0.15 && b.y < bottom - 40) b.stillF += 1; else b.stillF = 0; if (b.y > bottom + 14 && b.y < bottom + 34 && Math.abs(b.body.velocity.x) < 0.5 && Math.abs(b.body.velocity.y) < 0.6) { const cx = left + Math.round((b.x - left) / slotWidth) * slotWidth; const dir = b.x >= cx ? 1 : -1; Body.setVelocity(b.body, { x: dir * 1.0, y: b.body.velocity.y }); } if (b.stillF > 130) { b.stillF = 0; b.nudges += 1; if (b.nudges >= 8) { b.ageFrames = 1200; } else { Body.setVelocity(b.body, { x: Math.random() < 0.5 ? -0.9 : 0.9, y: 0.4 }); } } if ((b.y >= bottom + 35 || b.ageFrames > 1100) && !b.settled) { b.settled = true; b.phase = 'settle'; b.settleFrames = 0; b.stopVx = (b.trail && b.trail.length ? b.trail[b.trail.length - 1].vx : 0); b.stopVy = (b.trail && b.trail.length ? b.trail[b.trail.length - 1].vy : 0); b.trailFade = 0; b.slot = Math.max(0, Math.min(slotCount - 1, Math.floor((b.x - left) / slotWidth))); Body.setStatic(b.body, true); Body.setPosition(b.body, { x: left + b.slot * slotWidth + slotWidth / 2, y: bottom + 42 }); Body.setVelocity(b.body, { x: 0, y: 0 }); b.x = left + b.slot * slotWidth + slotWidth / 2; b.y = bottom + 42; } } else if (b.phase === 'settle') { b.settleFrames += 1; if (b.trail && b.trail.length > 0 && state.trail > 0) { b.trailFade = (b.trailFade || 0) + 1; const dec = Math.max(0.2, 1 - b.trailFade / 26); let _sp = Math.hypot(b.stopVx || 0, b.stopVy || 0); let _dx = (b.stopVx || 0), _dy = (b.stopVy || 0); if (_sp > 1.8) { _dx = _dx / _sp * 1.8; _dy = _dy / _sp * 1.8; } _dx *= dec; _dy *= dec; for (let i = 0; i < b.trail.length - 1; i++) { b.trail[i].x += _dx; b.trail[i].y += _dy; } const _h = b.trail[b.trail.length - 1]; _h.x = b.x; _h.y = b.y; if (b.trailFade > 30) b.trail = []; } if (b.settleFrames >= 55) { const win = state.lit.has(b.slot); const reward = win ? b.wager * state.multiplier : 0; state.marbles += reward; state.diamonds += Math.floor(reward / 50); World.remove(engine.world, b.body); state.ball = null; state.running = false; state.phase = 'confirm'; state.multiplierReady = false; state.multiplier = 0; state.lit = new Set(); save(); wx.showModal({ title: win ? '恭喜你' : '很遗憾', content: win ? `获得 ${reward} 颗弹珠\n钻石 +${Math.floor(reward / 50)} 颗` : '再试一次吧', showCancel: false }); } } } if (state.running && state.ball && state.ball.phase !== 'settle') { const b = state.ball; b.trail = b.trail || []; const vx = (b.phase === 'board' && b.body) ? b.body.velocity.x : 0; const vy = (b.phase === 'board' && b.body) ? b.body.velocity.y : 0; b.trail.push({ x: b.x, y: b.y, vx, vy }); const maxLen = [0, 9, 16, 26][state.trail]; while (b.trail.length > maxLen) b.trail.shift(); } if (!state.charging && state.powerShow > 0) { if (state.powerKeep > 0) state.powerKeep -= 1; else state.powerShow = Math.max(0, state.powerShow - 3); } draw(); frame(loop); }
wx.onTouchStart((e) => { const t = e.touches && e.touches[0]; if (!t) return; const x = t.clientX; const y = t.clientY; const sbx2 = shopBtn.x; const sby2 = shopBtn.y; if (sbx2 > 0 && x >= sbx2 && x <= sbx2 + shopBtn.w && y >= sby2 && y <= sby2 + shopBtn.h) { state.shop = !state.shop; state.charging = false; draw(); return; } if (state.shop) { for (let i = 0; i < shopItems.length; i += 1) { const it = shopItems[i]; if (x >= it.x && x <= it.x + it.w && y >= it.y && y <= it.y + it.h) { handleShopTap(it); return; } } state.shop = false; draw(); return; } if (state.running || state.randomizing || state.modal) return; if (uiWager.s > 0 && y > uiWager.y - 8 && y < uiWager.y + uiWager.s + 8) { if (x >= uiWager.mX - 10 && x < uiWager.mX + uiWager.s + 6) state.wager = Math.max(10, state.wager - 10); else if (x >= uiWager.pX - 6 && x < uiWager.pX + uiWager.s + 10) state.wager = Math.min(100, state.wager + 10); draw(); return; } if (y > height - 130 && y < height - 70 && x > width / 2 - 105 && x < width / 2 + 105) { if (state.phase === 'confirm') { randomize(); return; } if (state.phase === 'charge') { state.charging = true; state.power = 0; state.powerShow = 0; state.powerKeep = 0; state.powerDir = 1; } } });
wx.onTouchEnd(() => { if (!state.charging) return; state.charging = false; launch(); });
if (typeof wx.onTouchCancel === 'function') wx.onTouchCancel(() => { state.charging = false; state.power = 0; state.powerShow = 0; draw(); });
frame(loop); draw(); if (state.marbles === 0) setTimeout(showFree, 300);















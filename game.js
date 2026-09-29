const Matter = require('./matter.js');
const Snd = require('./audio.js');
const canvas = wx.createCanvas();
const ctx = canvas.getContext('2d');
const info = wx.getSystemInfoSync();
const dpr = Math.min(info.pixelRatio || 1, 2);
const width = info.windowWidth;
const height = info.windowHeight;
canvas.width = width * dpr;
canvas.height = height * dpr;
ctx.scale(dpr, dpr);
const frame = typeof wx.requestAnimationFrame === 'function' ? (fn) => wx.requestAnimationFrame(fn) : (fn) => setTimeout(fn, 16);
const { Engine, World, Bodies, Body } = Matter;
const engine = Engine.create({ enableSleeping: false });
engine.gravity.y = 1.0;
engine.positionIterations = 3;
engine.velocityIterations = 3;
engine.constraintIterations = 1;
// FIELD_PAD —— 板面两侧的有效区留白: 物理边界(墙 / 钳制位 / 槽位)全部以此向内收, 而不是顶到画出来的板边。
// 由来: 钉阵是奇偶交错阵列, 偶数排首列有钉、奇数排首列要往右挪半个间距, 于是板边到首列钉之间天生有
// 一条约半个间距(13px)宽的"单边通道" —— 球掉进去只会被偶数排的钉往墙的方向推、再被墙弹回来回往复,
// 看起来就是贴着边垂直下落, 最终必进边槽(实测边槽合计 45%, 而理论应约 20%)。
// 把边界收到钉阵外沿即可消除该通道: 400 球仿真 边槽 45.4%→18.5%, 最大单槽 26.2%→12.4%, 熵 0.923→0.995。
const FIELD_PAD = 13;
const boardWidth = Math.min(width * 0.72, 480) - FIELD_PAD * 2;
const left = Math.max(16, (width - boardWidth) / 2 - width * 0.018);
const right = left + boardWidth;
const top = Math.max(104, height * 0.17);
const bottom = Math.min(height - Math.max(205, height * 0.28), top + Math.max(330, height * 0.57));
const rows = 11;
const cols = 10;
// 钉阵必须以板面为基准居中: 此前按屏幕居中 ((width-pegWidth)/2), 与板面 left 差 width*0.018,
// 导致钉阵整体右移 —— 偶数排末列钉子埋进右墙内部(球永远碰不到), 奇数排末列钉子则压在
// 小球钳制位上(320 宽机型下重叠约 9.5px, 会被巨大冲量弹飞), 左侧反而空出一条无钉通道。
// PEG_SIDE_INSET: 首/末列钉心到同侧场边界的距离。它决定球贴边界时与外侧钉的关系 ——
// 记 Xmin = 球心可达最左位置(left+8, 由钳制位决定), p0 = 首列钉心, delta = Xmin - p0 = 8 - PEG_SIDE_INSET:
//   delta < 0(球心落在钉心左边) → 球被夹在墙与钉之间反复重叠, 旧版 17 即此列 —— 这是"贴边垂直下落"的元凶;
//   delta ≈ 0             → 球心压在钉心上, 求解器每帧把它挤出去, 超时局数暴增(实测 23 局);
//   delta > 0(球心在钉心右侧) → 重叠解算只需把球往场内推, 右侧是开阔空间, 顺畅脱离且自然回到中间。
// 400 球仿真的 delta 扫描: -9 → 边槽 45.4% / 熵 0.923;  -3/0 → 超时 17/23 局;  +4 → 边槽 18.5% / 熵 0.995 / 卡钉 3.0%;
//   +6 → 卡钉 2.4% 但边槽 17.5%;  +8 → 边界已盖到钉心, 两个边槽几乎打不到(合计 1.8%)。取 4 兼顾公平与稳定。
const PEG_SIDE_INSET = 4;
const pegWidth = boardWidth - PEG_SIDE_INSET * 2;
const pegLeft = left + PEG_SIDE_INSET;
const pegGapX = pegWidth / (cols - 1);
const pegTop = Math.min(bottom - 220, top + 66);
const pegBottom = bottom - 24;
const pegGapY = (pegBottom - pegTop) / (rows - 1);
const slotCount = 10;
const slotWidth = boardWidth / slotCount;
const trackX = width - Math.max(28, width * 0.085);
const trackRadius = Math.min(24, Math.max(17, width * 0.06));
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
const AIR_DAMP = 0.0018; // 弹珠空气阻力(轻微, 保留滚动余量)
// 三档钉子的弹性。pair.restitution = max(钉, 球), 小球自身是 0.48, 所以任何 ≤ 0.48 的档位都会被盖成 0.48。
// 取值必须明显拉开且高于 0.48, 否则"三种钉"物理上只有两档效果(0.55 时与普通手感几乎无差别)。
// 400 球仿真标定: 0.48 → 弹起 5.9 次/局、峰值上弹速度 4.19; 0.75 → 6.7 次 / 4.60; 1.08 → 9.0 次 / 6.47。
const PEG_REST_DAMP = 0.48;   // 蓝钉(阻尼): 与球持平 = 零弹性加成
const PEG_REST_NORMAL = 0.75; // 普通钉: 主手感的来源, 调大更弹更飘但也更容易堆到边槽
const PEG_REST_BOOST = 1.08;  // 绿钉(加速): 超过 1 会净增能量, 再高会导致长时间不肯落底
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
    if (x <= pegLeft + pegWidth) pegs.push({ x, y: pegTop + row * pegGapY, row, boost: row === 2 || row === rows - 3, damp: row === 0 || row === 1 });
  }
}
// 静态刚体参数三原则(实测 matter-js 0.20.0):
// 1) Body.create 会在最后一步调用 Body.setStatic, 把 isStatic 刚体强制设为 restitution=0 / friction=1,
//    写在 options 里的 friction/restitution 全部无效 —— 必须在创建之后回写。
// 2) pair.restitution = max(双方): 钉子弹性只有高于小球 0.48 才起作用, 低于它的档位会被完全盖掉。
//    所以蓝钉(阻尼钉)不能靠"低弹性"减速, 这里给到 0.48(与球持平 = 无弹性加成);
//    普通钉必须明显高于它才能真正分档 —— 原先取 0.55 时与普通手感差别仅 0.07, 观感上"三种钉只有两种"。
//    改 0.75 后三档为: 蓝 0.48 / 普通 0.75 / 绿 1.08, 梯度 0.27 / 0.33, 三档都拉得开。
// 3) pair.friction = min(双方): 小球 friction 只有 0.012, 比任何钉子都小, 所以钉子 friction 目前
//    实际不起作用(min 恒为 0.012)。这里的回写是为了把设计意图固化下来 —— 想让蓝钉真正阻尼,
//    必须同步把小球 friction 提到 0.4 以上; 但实测那样会把卡钉率从 2.5% 抬到 6.7%, 故暂不采用。
const pegBodies = pegs.map((p) => {
  const b = Bodies.circle(p.x, p.y, 4.5, { isStatic: true, frictionStatic: 0 });
  b.restitution = p.boost ? PEG_REST_BOOST : (p.damp ? PEG_REST_DAMP : PEG_REST_NORMAL);
  b.friction = p.damp ? 0.35 : 0.02;
  b.label = 'peg'; b.pegKind = p.boost ? 2 : (p.damp ? 1 : 0); b.pegRow = p.row;
  return b;
});
const walls = [Bodies.rectangle(left - 8, (top + bottom) / 2, 16, bottom - top + 60, { isStatic: true, frictionStatic: 0 }), Bodies.rectangle(right + 8, (top + bottom) / 2, 16, bottom - top + 60, { isStatic: true, frictionStatic: 0 }), Bodies.rectangle((left + right) / 2, bottom + 54, boardWidth + 32, 16, { isStatic: true, frictionStatic: 0 })]; walls[0].restitution = 0.5; walls[1].restitution = 0.5; walls[2].restitution = 0.25; walls.forEach((w) => { w.friction = 0.02; w.label = 'wall'; });
const dividerH = 30, dividers = [];
for (let i = 1; i < slotCount; i += 1) dividers.push(Bodies.rectangle(left + i * slotWidth, bottom + 31, 4, dividerH, { isStatic: true, frictionStatic: 0 }));
dividers.forEach((d) => { d.restitution = 0.3; d.friction = 0.02; d.label = 'wall'; });
World.add(engine.world, pegBodies.concat(walls, dividers));
// 碰撞音效: 相对速度必须从 collisionStart 的 pair 里取 —— 这是撞击瞬间的真实强度,
// 事后再用 body.velocity 推算会漏掉大部分轻碰, 也会把滚动中的持续接触误判成撞击。
Matter.Events.on(engine, 'collisionStart', (ev) => {
  for (let i = 0; i < ev.pairs.length; i += 1) {
    const pair = ev.pairs[i];
    const a = pair.bodyA;
    const b = pair.bodyB;
    if (a.label !== 'ball' && b.label !== 'ball') continue;
    const ball = a.label === 'ball' ? a : b;
    const other = a.label === 'ball' ? b : a;
    const v = Math.hypot(ball.velocity.x - other.velocity.x, ball.velocity.y - other.velocity.y);
    if (v < 0.8) continue;              // 贴着滚的擦碰不出声, 否则会一直滋滋响
    const intensity = Math.min(1, v / 11);
    // 把"第几排"一起传过去：每排钉子有各自的音高，自上而下是一条下行五声音阶。
    if (other.label === 'peg') Snd.sfxPeg(other.pegKind, intensity, other.pegRow);
    else if (other.label === 'wall') Snd.sfxWall(intensity);
  }
});
const skins = [{ name: '经典银', color: '#f4f6f8', cost: 0 }, { name: '深海蓝', color: '#49a8ff', cost: 1500 }, { name: '赤焰红', color: '#ff5064', cost: 1500 }, { name: '鎏金', color: '#ffd34d', cost: 3000 }, { name: '极光', color: '#52e9c0', cost: 3000 }, { name: '紫电', color: '#b26cff', cost: 3000 }, { name: '黑洞', color: '#2b2150', cost: 5000 }];
const backgrounds = [
  { name: '糖果霓虹', color: '#ffb632', board: '#ffd7e7', line: '#d95c8f', edge: '#ffe55a', cost: 0 },
  { name: '海盐霓虹', color: '#54bad0', board: '#ccecf0', line: '#277b9b', edge: '#f8f17a', cost: 0 },
  { name: '熔火乐园', color: '#e8753e', board: '#ffd0ad', line: '#b94e41', edge: '#ffe56a', cost: 0 }
];
const trails = [{ name: '无拖尾', cost: 0 }, { name: '流光拖尾', cost: 100 }, { name: '星尘拖尾', cost: 300 }, { name: '炫彩拖尾', cost: 600 }];
const halos = [{ name: '无光环', cost: 0 }, { name: '微光环', cost: 50 }, { name: '星光环', cost: 150 }, { name: '炫彩光环', cost: 300 }];
// 用本地日期而不是 toISOString()(那是 UTC 日期), 否则每日免费领取会在本地早上 8 点才刷新。
const nowDate = new Date();
const today = `${nowDate.getFullYear()}-${String(nowDate.getMonth() + 1).padStart(2, '0')}-${String(nowDate.getDate()).padStart(2, '0')}`;
const saved = wx.getStorageSync('galtonGame') || {};
// 存档里的装备索引可能是旧版本残留或越界值, 不夹紧会让 skins[i].cost / backgrounds[bg].color 取到 undefined 而白屏。
const clampIdx = (v, arr) => Math.min(arr.length - 1, Math.max(0, Number(v) || 0));
saved.skin = clampIdx(saved.skin, skins);
saved.bg = clampIdx(saved.bg, backgrounds);
saved.trail = clampIdx(saved.trail, trails);
saved.halo = clampIdx(saved.halo, halos);
const ownedDefault = { skins: [0, saved.skin || 0].filter((v, i, a) => a.indexOf(v) === i), bgs: [0, saved.bg || 0].filter((v, i, a) => a.indexOf(v) === i), trails: [0, saved.trail || 0].filter((v, i, a) => a.indexOf(v) === i), halos: [0, saved.halo || 0].filter((v, i, a) => a.indexOf(v) === i) };
const owned = saved.owned ? { ...ownedDefault, ...saved.owned } : ownedDefault;
['skins', 'bgs', 'trails', 'halos'].forEach((k) => { if (!Array.isArray(owned[k]) || owned[k].length === 0) owned[k] = [0]; });
const state = { marbles: Number.isFinite(saved.marbles) ? saved.marbles : 1000, diamonds: Number.isFinite(saved.diamonds) ? saved.diamonds : 0, wager: 0, freeClaims: saved.freeDate === today ? (saved.freeClaims || 0) : 0, power: 0, powerDir: 1, powerShow: 0, powerKeep: 0, charging: false, phase: 'confirm', randomizing: false, running: false, ball: null, multiplier: 0, multiplierReady: false, lit: new Set(), shop: false, modal: false, skin: saved.skin || 0, bg: saved.bg || 0, trail: saved.trail || 0, halo: saved.halo || 0, audioMode: Number.isFinite(saved.audioMode) ? saved.audioMode : 0, owned };
function save() { wx.setStorageSync('galtonGame', { marbles: state.marbles, diamonds: state.diamonds, freeClaims: state.freeClaims, freeDate: today, skin: state.skin, bg: state.bg, trail: state.trail, halo: state.halo, audioMode: state.audioMode, owned: state.owned }); }
// 声音三档: 0 音效+音乐 / 1 仅音效 / 2 全静音。
const AUDIO_MODES = [
  { sfx: true, bgm: true, label: '音效 + 音乐' },
  { sfx: true, bgm: false, label: '仅音效' },
  { sfx: false, bgm: false, label: '全部静音' },
];
// 这里只把偏好交给音频模块, **不创建 AudioContext** —— iOS 上过早创建会让之后
// resume 的失败率明显上升。真正的初始化推迟到玩家第一次触摸时的 Snd.unlock()。
Snd.setPrefs(AUDIO_MODES[clampIdx(state.audioMode, AUDIO_MODES)].sfx, AUDIO_MODES[clampIdx(state.audioMode, AUDIO_MODES)].bgm);
function applyAudioMode(notify) {
  const m = AUDIO_MODES[clampIdx(state.audioMode, AUDIO_MODES)];
  Snd.setSfxOn(m.sfx); Snd.setBgmOn(m.bgm);
  if (notify) wx.showToast({ title: '声音：' + m.label, icon: 'none' });
}
let audioUnlocked = false;
const audBtn = { x: 0, y: 0, w: 0, h: 0 };
function drawAudioToggle() {
  const size = 30;
  const x = width - 12 - size;
  const y = 23;
  audBtn.x = x; audBtn.y = y; audBtn.w = size; audBtn.h = size;
  const mode = AUDIO_MODES[clampIdx(state.audioMode, AUDIO_MODES)];
  const on = mode.sfx;
  ctx.save();
  roundedRectPath(x, y, size, size, 8);
  ctx.fillStyle = on ? 'rgba(70,40,95,.82)' : 'rgba(38,38,46,.75)';
  ctx.strokeStyle = on ? 'rgba(255,204,237,.62)' : 'rgba(150,150,160,.45)';
  ctx.lineWidth = 1.5;
  ctx.fill(); ctx.stroke();
  const cx = x + 12;
  const cy = y + size / 2;
  ctx.fillStyle = on ? '#ffd3f0' : '#8d939d';
  ctx.beginPath();
  ctx.moveTo(cx - 5, cy - 3); ctx.lineTo(cx - 1, cy - 3); ctx.lineTo(cx + 3, cy - 7);
  ctx.lineTo(cx + 3, cy + 7); ctx.lineTo(cx - 1, cy + 3); ctx.lineTo(cx - 5, cy + 3);
  ctx.closePath(); ctx.fill();
  if (on) {
    ctx.strokeStyle = 'rgba(255,211,240,.85)'; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.arc(cx + 4, cy, 6, -0.9, 0.9); ctx.stroke();
    if (mode.bgm) { ctx.beginPath(); ctx.arc(cx + 4, cy, 9.5, -0.85, 0.85); ctx.stroke(); }
  } else {
    ctx.strokeStyle = '#e05a63'; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + 19, y + 10); ctx.lineTo(x + 26, y + 19);
    ctx.moveTo(x + 26, y + 10); ctx.lineTo(x + 19, y + 19);
    ctx.stroke();
  }
  ctx.restore();
}
const uiWager = { mX: 0, pX: 0, y: 0, s: 0, addX: 0, addY: 0, addR: 0, startX: 0, startY: 0, startR: 0 }; let wagerTimer = null; let wagerRepeat = null; const shopBtn = { x: 0, y: 0, w: 54, h: 30 }; const shopItems = [];
function hexToRgba(hex, a) { const h = hex.replace('#', ''); const r = parseInt(h.substring(0, 2), 16), g = parseInt(h.substring(2, 4), 16), b = parseInt(h.substring(4, 6), 16);   return `rgba(${r},${g},${b},${a})`; }
function drawRedDigits(value, x, y, size) { const text = String(Math.max(0, Math.floor(value))); const segs = { '0': 'abcdef', '1': 'bc', '2': 'abdeg', '3': 'abcdg', '4': 'bcfg', '5': 'acdfg', '6': 'acdefg', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg' }; const w = size * 0.58, h = size, thick = Math.max(1, size * 0.13), gap = Math.max(2, size * 0.2); for (let i = 0; i < text.length; i += 1) { const ch = segs[text[i]] || ''; const ox = x - (text.length - i) * (w + gap) + gap; const oy = y; ctx.fillStyle = 'rgba(104,18,16,.35)'; ctx.fillRect(ox + thick, oy, w - thick * 2, thick); ctx.fillRect(ox + w - thick, oy + thick, thick, h * 0.42 - thick); ctx.fillRect(ox + w - thick, oy + h * 0.58, thick, h * 0.42 - thick); ctx.fillRect(ox + thick, oy + h - thick, w - thick * 2, thick); ctx.fillRect(ox, oy + h * 0.58, thick, h * 0.42 - thick); ctx.fillRect(ox, oy + thick, thick, h * 0.42 - thick); ctx.fillRect(ox + thick, oy + h * 0.5 - thick * 0.5, w - thick * 2, thick); ctx.fillStyle = '#e33b32'; for (let j = 0; j < 7; j += 1) { const key = 'abcdefg'[j]; if (ch.indexOf(key) < 0) continue; if (key === 'a' || key === 'd' || key === 'g') ctx.fillRect(ox + thick, oy + (key === 'a' ? 0 : (key === 'g' ? h * 0.5 - thick * 0.5 : h - thick)), w - thick * 2, thick); else ctx.fillRect(ox + (key === 'b' || key === 'c' ? w - thick : 0), oy + (key === 'b' || key === 'f' ? thick : h * 0.5 + thick * 0.5), thick, h * 0.42 - thick); } } return text.length * (w + gap) - gap; }
function drawSettleFx(b) {
  const sx = left + b.slot * slotWidth + slotWidth / 2;
  const cy = bottom + 42;
  const t = b.settleFrames;
  const p = Math.min(t / 45, 1);
  if (state.skin === 3) { ctx.save(); ctx.translate(sx, cy); const goldSize = Math.max(3.5, Math.min(6, slotWidth * 0.18)); for (let q = 0; q < 3; q += 1) { const fall = Math.max(0, Math.min(1, (t - q * 4) / 34)); const x = q === 0 ? 0 : (q === 1 ? -goldSize * 2.1 : goldSize * 2.1); const y = -slotWidth * 0.25 + fall * slotWidth * 0.3; const alpha = fall > 0.9 ? Math.max(0, 1 - (fall - 0.9) * 8) : 1; ctx.save(); ctx.translate(x, y); ctx.rotate((q - 1) * 0.18 + fall * (q === 1 ? -0.22 : 0.22)); ctx.globalAlpha = alpha; ctx.fillStyle = '#ffd044'; ctx.fillRect(-goldSize, -goldSize * 0.72, goldSize * 2, goldSize * 1.44); ctx.fillStyle = '#fff2a1'; ctx.fillRect(-goldSize + 0.8, -goldSize * 0.72 + 0.8, goldSize * 0.72, 1); ctx.restore(); } ctx.globalAlpha = Math.max(0, 1 - p); ctx.fillStyle = 'rgba(255,210,55,.3)'; ctx.beginPath(); ctx.arc(0, slotWidth * 0.02, 7 + p * 10, 0, Math.PI * 2); ctx.fill(); ctx.restore(); } else if (state.skin === 4) { ctx.save(); for (let q = 0; q < 10; q += 1) { const seed = q * 1.91; const phase = (t * (0.0068 + (q % 3) * 0.001) + q * 0.11) % 1.05; const mx = sx - slotWidth * 0.28 + Math.sin(seed) * slotWidth * 0.12 + phase * slotWidth * 0.5; const my = cy - slotWidth * 0.3 - phase * slotWidth * 0.42 + Math.cos(seed) * 3; const len = 7 + (q % 4) * 2; const alpha = Math.max(0, Math.min(1, 1 - Math.max(0, phase - 0.92) * 2.8)); ctx.globalAlpha = alpha * 0.85; ctx.strokeStyle = q % 2 ? '#63f5b4' : '#b8ffd6'; ctx.lineWidth = 2 + (q % 3) * 0.7; ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(mx - len * 0.72, my + len); ctx.stroke(); ctx.globalAlpha = Math.max(0.35, alpha); ctx.fillStyle = '#eafff2'; ctx.beginPath(); ctx.arc(mx, my, 2.2 + (q % 2), 0, Math.PI * 2); ctx.fill(); } ctx.globalAlpha = Math.max(0, 1 - p) * 0.8; ctx.strokeStyle = '#43e89a'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(sx, cy, 10 + p * 26, 0, Math.PI * 2); ctx.stroke(); ctx.restore(); } else if (state.skin === 5) {
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
function roundedRectPath(x, y, w, h, r) {
  const q = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath(); ctx.moveTo(x + q, y); ctx.arcTo(x + w, y, x + w, y + h, q); ctx.arcTo(x + w, y + h, x, y + h, q); ctx.arcTo(x, y + h, x, y, q); ctx.arcTo(x, y, x + w, y, q); ctx.closePath();
}
function drawCabinetBg() {
  const theme = backgrounds[state.bg] || backgrounds[0];
  const outer = { x: 6, y: 5, w: width - 12, h: height - 10 };
  const header = { x: 20, y: 13, w: width - 40, h: Math.max(62, Math.min(76, height * .105)) };
  const field = { x: 14, y: header.y + header.h + 8, w: width - 28, h: Math.max(170, bottom - header.y - header.h + 92) };
  const warm = state.bg === 1 ? '#42aec0' : (state.bg === 2 ? '#df6a3d' : '#f39c20');
  const dark = state.bg === 1 ? '#17657a' : (state.bg === 2 ? '#9f3e32' : '#c95228');
  ctx.save(); ctx.lineJoin = 'round';
  const base = ctx.createLinearGradient(0, 0, width, height); base.addColorStop(0, warm); base.addColorStop(.42, '#ffe35a'); base.addColorStop(.78, '#ffb52c'); base.addColorStop(1, dark); ctx.fillStyle = base; ctx.fillRect(0, 0, width, height);
  roundedRectPath(outer.x, outer.y, outer.w, outer.h, 28); ctx.shadowColor = 'rgba(91,35,13,.5)'; ctx.shadowBlur = 20; ctx.fillStyle = '#ffbf31'; ctx.fill(); ctx.shadowBlur = 0;
  roundedRectPath(outer.x + 4, outer.y + 4, outer.w - 8, outer.h - 8, 24); const frame = ctx.createLinearGradient(0, outer.y, 0, outer.y + outer.h); frame.addColorStop(0, '#fff47c'); frame.addColorStop(.22, '#ffd337'); frame.addColorStop(.55, '#f59c20'); frame.addColorStop(.84, '#ffc83a'); frame.addColorStop(1, '#fff079'); ctx.fillStyle = frame; ctx.fill();
  roundedRectPath(outer.x + 7, outer.y + 7, outer.w - 14, outer.h - 14, 21); ctx.strokeStyle = 'rgba(255,255,217,.9)'; ctx.lineWidth = 2; ctx.stroke(); roundedRectPath(outer.x + 12, outer.y + 12, outer.w - 24, outer.h - 24, 18); ctx.strokeStyle = 'rgba(180,79,23,.58)'; ctx.lineWidth = 3; ctx.stroke();
  roundedRectPath(field.x, field.y, field.w, field.h, 23); const board = ctx.createLinearGradient(0, field.y, 0, field.y + field.h); board.addColorStop(0, theme.board || '#ffd7e7'); board.addColorStop(.5, state.bg === 1 ? '#d8f1f1' : '#ffe1eb'); board.addColorStop(1, state.bg === 2 ? '#ffd4b9' : '#fff0e5'); ctx.fillStyle = board; ctx.fill();
  ctx.save(); roundedRectPath(field.x + 4, field.y + 4, field.w - 8, field.h - 8, 19); ctx.clip(); const glow = ctx.createRadialGradient(width * .4, field.y + field.h * .46, 8, width * .4, field.y + field.h * .46, width * .75); glow.addColorStop(0, 'rgba(255,255,255,.52)'); glow.addColorStop(.48, state.bg === 1 ? 'rgba(107,214,225,.14)' : 'rgba(255,132,190,.17)'); glow.addColorStop(1, 'rgba(255,255,255,0)'); ctx.fillStyle = glow; ctx.fillRect(field.x, field.y, field.w, field.h);
  [[.1,.24,26,'rgba(255,255,255,.18)'],[.78,.2,30,'rgba(255,139,186,.15)'],[.2,.73,23,'rgba(255,181,74,.15)'],[.65,.78,30,'rgba(131,202,255,.13)'],[.9,.58,22,'rgba(255,198,89,.15)']].forEach((s) => { const x = field.x + field.w * s[0], y = field.y + field.h * s[1], g = ctx.createRadialGradient(x, y, 1, x, y, s[2]); g.addColorStop(0, s[3]); g.addColorStop(1, 'rgba(255,255,255,0)'); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, s[2], 0, Math.PI * 2); ctx.fill(); }); ctx.restore();
  roundedRectPath(field.x, field.y, field.w, field.h, 23); ctx.strokeStyle = 'rgba(189,75,73,.76)'; ctx.lineWidth = 4; ctx.stroke(); roundedRectPath(field.x + 7, field.y + 7, field.w - 14, field.h - 14, 18); ctx.strokeStyle = 'rgba(255,247,206,.82)'; ctx.lineWidth = 2; ctx.stroke();
  roundedRectPath(header.x, header.y, header.w, header.h, 24); const marquee = ctx.createLinearGradient(0, header.y, 0, header.y + header.h); marquee.addColorStop(0, '#4b205c'); marquee.addColorStop(.55, '#28153f'); marquee.addColorStop(1, '#150d29'); ctx.fillStyle = marquee; ctx.fill(); ctx.shadowColor = 'rgba(255,63,193,.8)'; ctx.shadowBlur = 12; ctx.strokeStyle = 'rgba(255,167,222,.82)'; ctx.lineWidth = 2; ctx.stroke(); ctx.shadowBlur = 0;
  const cardW = Math.min(108, width * .28); roundedRectPath(header.x + 8, header.y + 8, cardW, header.h - 16, 17); ctx.fillStyle = 'rgba(42,22,55,.55)'; ctx.strokeStyle = 'rgba(255,204,237,.48)'; ctx.lineWidth = 1.5; ctx.fill(); ctx.stroke(); ctx.textAlign = 'left'; ctx.fillStyle = '#fff5fb'; ctx.font = 'bold ' + Math.max(12, Math.min(16, width * .043)) + 'px sans-serif'; ctx.fillText('弹珠', header.x + 17, header.y + 24); ctx.font = 'bold ' + Math.max(16, Math.min(21, width * .055)) + 'px sans-serif'; ctx.fillStyle = '#fffdf8'; ctx.font = 'bold ' + Math.max(13, Math.min(17, width * .044)) + 'px sans-serif'; ctx.fillText(String(state.marbles), header.x + 17, header.y + 42); ctx.font = 'bold ' + Math.max(12, Math.min(16, width * .043)) + 'px sans-serif'; ctx.fillStyle = '#5de8ff'; ctx.fillText('钻石', header.x + 17, header.y + 60); ctx.fillStyle = '#fffdf8'; ctx.fillText(String(state.diamonds), header.x + 53, header.y + 60); ctx.textAlign = 'center'; ctx.shadowColor = 'rgba(255,49,207,.95)'; ctx.shadowBlur = 18; ctx.fillStyle = '#211525'; ctx.font = 'bold ' + Math.max(26, Math.min(39, width * .105)) + 'px sans-serif'; ctx.fillText('\u5f39\u73e0\u723d', width / 2, header.y + header.h * .67); ctx.shadowBlur = 0; ctx.strokeStyle = 'rgba(255,132,228,.92)'; ctx.lineWidth = 1; ctx.strokeText('\u5f39\u73e0\u723d', width / 2, header.y + header.h * .67);
  
  const lampY = header.y + header.h - 8, count = 20, tick = Date.now() / 260; for (let i = 0; i < count; i += 1) { const x = header.x + 128 + i * ((header.w - 164) / Math.max(1, count - 1)), a = .3 + .7 * (.5 + .5 * Math.sin(tick + i * .56)); ctx.fillStyle = i % 3 === 0 ? 'rgba(255,41,152,' + a + ')' : (i % 3 === 1 ? 'rgba(55,203,238,' + a + ')' : 'rgba(174,123,255,' + a + ')'); ctx.beginPath(); ctx.arc(x, lampY, 2.7, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
}
function draw() {
  ctx.fillStyle = backgrounds[state.bg].color; ctx.fillRect(0, 0, width, height); drawCabinetBg();

  pegs.forEach((p) => {
    const blue = p.damp;
    const green = p.boost;
    const ring = blue ? '#2c62bd' : (green ? '#2e8b4b' : '#9da0aa');
    const core = blue ? '#a8cfff' : (green ? '#8ee6a0' : '#777b86');
    const halo = blue ? 'rgba(42,100,196,.22)' : (green ? 'rgba(40,147,75,.2)' : 'rgba(118,116,130,.13)');
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(p.x, p.y, 10.5, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
    ctx.strokeStyle = ring; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p.x, p.y, 8.2, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = core; ctx.beginPath(); ctx.arc(p.x, p.y, 5.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.82)'; ctx.beginPath(); ctx.arc(p.x - 1.4, p.y - 1.7, 2.1, 0, Math.PI * 2); ctx.fill();
  });
  const slotTop = bottom + 22, slotBot = bottom + 52;
  ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.fillRect(left - 4, slotTop - 9, boardWidth + 8, 2);
  for (let i = 0; i < slotCount; i += 1) {
    const x = left + i * slotWidth, lit = state.lit.has(i);
    const slotGlow = ctx.createLinearGradient(0, slotTop - 5, 0, slotTop + 8);
    slotGlow.addColorStop(0, lit ? '#fff18a' : '#a0a5ad'); slotGlow.addColorStop(1, lit ? '#e2a82b' : '#656b75');
    ctx.fillStyle = slotGlow; ctx.fillRect(x + 2, slotTop - 4, slotWidth - 4, 7);
  }
  ctx.fillStyle = '#1d2029'; ctx.fillRect(left - 4, slotBot - 2, boardWidth + 8, 14);
  ctx.fillStyle = '#4c515c'; ctx.fillRect(left - 4, slotBot - 2, boardWidth + 8, 3);
  ctx.strokeStyle = '#747985'; ctx.lineWidth = 1.5;
  for (let i = 0; i <= slotCount; i += 1) { const x = left + i * slotWidth; ctx.beginPath(); ctx.moveTo(x, slotTop - 11); ctx.lineTo(x, slotBot + 1); ctx.stroke(); }
  ctx.fillStyle = '#252a33'; ctx.strokeStyle = '#a7aab1'; ctx.lineWidth = 1;
  for (let i = 1; i < slotCount; i += 1) { const x = left + i * slotWidth; ctx.beginPath(); ctx.moveTo(x - 3, slotTop - 11); ctx.lineTo(x, slotTop - 22); ctx.lineTo(x + 3, slotTop - 11); ctx.closePath(); ctx.fill(); ctx.stroke(); }
const trackStartY = state.ball && state.ball.phase === 'rail' ? state.ball.startY : bottom - 10 - (state.charging ? state.power * 0.22 : 0);
  ctx.strokeStyle = '#59616e'; ctx.lineWidth = 12; ctx.shadowColor = 'rgba(28,31,39,.35)'; ctx.shadowBlur = 5; ctx.lineCap = 'round'; ctx.beginPath(); drawTrackPath(trackStartY); ctx.stroke();
  ctx.shadowBlur = 0; ctx.strokeStyle = '#eef2f4'; ctx.lineWidth = 2.5; ctx.beginPath(); drawTrackPath(trackStartY); ctx.stroke();
  const rodY = bottom - 10 - (state.charging ? state.power * 0.22 : 0);
  ctx.strokeStyle = '#c52f3b'; ctx.lineWidth = 8; ctx.beginPath(); ctx.moveTo(trackX, rodY); ctx.lineTo(trackX, bottom + 3); ctx.stroke(); ctx.fillStyle = '#ef3f4b'; ctx.fillRect(trackX - 13, rodY - 5, 26, 9);
  ctx.strokeStyle = '#f3c84b'; ctx.lineWidth = 2; ctx.beginPath(); for (let i = 0; i < 10; i += 1) { const sx = trackX + (i % 2 ? 6 : -6); const sy = rodY - i * 3; if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy); } ctx.stroke(); const pbTop = bottom + 14; const pbBottom = bottom + 80; const pbW = 12; const pbh = pbBottom - pbTop; ctx.fillStyle = '#262833'; ctx.fillRect(trackX - pbW / 2 - 2, pbTop - 2, pbW + 4, pbh + 4); ctx.fillStyle = '#484a53'; ctx.fillRect(trackX - pbW / 2, pbTop, pbW, pbh); const pfill = Math.max(0, Math.min(100, state.powerShow)) / 100; const pfh = Math.round(pbh * pfill); ctx.fillStyle = state.charging ? '#ff5b66' : '#f3c84b'; ctx.fillRect(trackX - pbW / 2, pbBottom - pfh, pbW, pfh); ctx.strokeStyle = '#8b7e73'; ctx.lineWidth = 1.2; ctx.strokeRect(trackX - pbW / 2 - 0.5, pbTop - 0.5, pbW + 1, pbh + 1); ctx.fillStyle = '#f3c84b'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(`${Math.round(state.powerShow)}%`, trackX, pbBottom + 13); ctx.textAlign = 'start'; const topInfoY = trackExitY - 12; const rdT = state.multiplierReady; const predN = rdT ? state.multiplier * state.wager : 0; const predD = Math.floor(predN / 50); const labelY = topInfoY - 20; const boxY = topInfoY - 16; const boxW = Math.max(46, width * 0.17); const boxH = 26; const boxGap = 7; const totalW = boxW * 3 + boxGap * 2; const boxX = Math.max(5, (width - totalW) / 2); ctx.textAlign = 'center'; ctx.font = 'bold 10px sans-serif'; ctx.fillStyle = '#211525'; ctx.fillText('倍率', boxX + boxW / 2, labelY); ctx.fillText('预计获得弹珠数', boxX + boxW + boxGap + boxW / 2, labelY); ctx.fillText('预计获得钻石数', boxX + (boxW + boxGap) * 2 + boxW / 2, labelY); ctx.fillStyle = 'rgba(10,10,14,.92)'; ctx.fillRect(boxX, boxY, boxW, boxH); ctx.fillRect(boxX + boxW + boxGap, boxY, boxW, boxH); ctx.fillRect(boxX + (boxW + boxGap) * 2, boxY, boxW, boxH); const dSize = Math.max(15, Math.min(20, width * .052)); const multiplierW = String(Math.max(0, Math.floor(state.multiplier || 0))).length * (dSize * .78); const nTextW = String(Math.max(0, Math.floor(predN))).length * (dSize * .78); const dTextW = String(Math.max(0, Math.floor(predD))).length * (dSize * .78); drawRedDigits(state.multiplier || 0, boxX + boxW / 2 + multiplierW / 2, boxY + 3, dSize); drawRedDigits(predN, boxX + boxW + boxGap + boxW / 2 + nTextW / 2, boxY + 3, dSize); drawRedDigits(predD, boxX + (boxW + boxGap) * 2 + boxW / 2 + dTextW / 2, boxY + 3, dSize); ctx.textAlign = 'start';
  if (state.ball && state.ball.phase !== 'settle' && state.ball.trail && state.ball.trail.length > 1 && state.trail > 0) { const tr = state.ball.trail; const n = tr.length; const color = skins[state.skin].color; const trailBoost = state.trail; ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; if (trailBoost >= 3) { const tail = tr[0], head = tr[n - 1]; const dx = head.x - tail.x, dy = head.y - tail.y, len = Math.max(1, Math.hypot(dx, dy)); const nx = -dy / len, ny = dx / len; const hues = [190, 285, 48, 125]; for (let q = 0; q < 3; q += 1) { const w = 5.5 - q * 1.1; const off = (q - 1) * 2.1; const tx = tail.x + nx * off, ty = tail.y + ny * off; const hx = head.x + nx * off, hy = head.y + ny * off; const trailColors = ['rgba(45,220,255,.52)', 'rgba(190,70,255,.86)', 'rgba(255,210,55,.58)']; ctx.fillStyle = trailColors[q];; ctx.beginPath(); ctx.moveTo(tx, ty); for (let k = 1; k < n; k += 1) { const t = k / (n - 1); const px = tr[k].x + nx * off, py = tr[k].y + ny * off; ctx.lineTo(px + nx * w * t, py + ny * w * t); } for (let k = n - 1; k >= 1; k -= 1) { const t = k / (n - 1); const px = tr[k].x + nx * off, py = tr[k].y + ny * off; ctx.lineTo(px - nx * w * t, py - ny * w * t); } ctx.closePath(); ctx.globalAlpha = 1; ctx.fill(); } ctx.globalAlpha = 0.24; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(tail.x, tail.y); for (let k = 1; k < n; k += 1) ctx.lineTo(tr[k].x, tr[k].y); ctx.stroke(); } else { for (let k = 1; k < n; k += 1) { const a = tr[k - 1], b2 = tr[k]; const t = k / n; const alpha = t * t * (trailBoost === 2 ? 0.7 : 0.58); const widthTrail = (trailBoost === 2 ? 3 : 2) + t * (trailBoost === 2 ? 10 : 6); ctx.strokeStyle = hexToRgba(color, alpha); ctx.lineWidth = widthTrail; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b2.x, b2.y); ctx.stroke(); } } ctx.restore(); }if (state.ball) { if (state.ball.phase === 'settle') drawSettleFx(state.ball); if (state.halo > 0 && state.ball.phase !== 'settle') { for (let ring = 1; ring <= state.halo; ring += 1) { const pulse = 1 + Math.sin(Date.now() / 120) * 0.16; const rr = (8 + ring * 4) * pulse; const a = 0.62 - ring * 0.1; if (state.halo >= 3 && ring % 2 === 0) ctx.strokeStyle = `hsla(${(ring * 90) % 360},90%,62%,${a})`; else if (state.halo >= 3) ctx.strokeStyle = `hsla(${(ring * 90 + 180) % 360},90%,62%,${a})`; else ctx.strokeStyle = `rgba(255,232,170,${a})`; ctx.lineWidth = 3.2 - ring * 0.3; ctx.beginPath(); ctx.arc(state.ball.x, state.ball.y, rr, 0, Math.PI * 2); ctx.stroke(); } } if (state.ball.phase !== 'settle' || state.skin <= 2) { const settlePulse = state.ball.phase === 'settle' ? (1 + Math.sin(state.ball.settleFrames * 0.3) * 0.12) : 1; const br = 6 * settlePulse; const ballGradient = ctx.createRadialGradient(state.ball.x - br * 0.35, state.ball.y - br * 0.4, br * 0.2, state.ball.x, state.ball.y, br * 1.2); ballGradient.addColorStop(0, '#ffffff'); ballGradient.addColorStop(0.18, skins[state.skin].color); ballGradient.addColorStop(0.72, skins[state.skin].color); ballGradient.addColorStop(1, 'rgba(20,24,32,.8)'); ctx.fillStyle = ballGradient; ctx.shadowColor = 'rgba(0,0,0,.38)'; ctx.shadowBlur = 4; ctx.beginPath(); ctx.arc(state.ball.x, state.ball.y, br, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0; if (state.ball.phase === 'settle') { ctx.globalAlpha = 0.45; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(state.ball.x, state.ball.y, br + 3, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1; } } if (state.ball.phase === 'rail' && state.ball.v < 0) { ctx.fillStyle = '#ffcc66'; ctx.font = 'bold 13px sans-serif'; ctx.fillText('力度不足，弹珠回落', left, bottom + 18); } }
  
  if (!state.running && !state.shop) { const rowY = height - 66; const infoW = 68, addR = 27, actionW = 88, actionH = 44, shopW = 54, shopH = 34, gap = 7; const totalW = infoW + addR * 2 + actionW + shopW + gap * 3; const startX = Math.max(8, (width - totalW) / 2); const infoX = startX; const addX = infoX + infoW + gap + addR; const actionX = addX + addR + gap + actionW / 2; const shopX = actionX + actionW / 2 + gap; ctx.textAlign = 'center'; ctx.fillStyle = '#211525'; ctx.font = 'bold 10px sans-serif'; ctx.fillText('已投弹珠数', infoX + infoW / 2, rowY - 22); ctx.fillStyle = 'rgba(10,10,14,.92)'; roundedRectPath(infoX, rowY - 17, infoW, 29, 4); ctx.fill(); const wagerTextW = String(state.wager).length * 14; drawRedDigits(state.wager, infoX + infoW / 2 + wagerTextW / 2, rowY - 14, 20); const addGrad = ctx.createLinearGradient(addX, rowY - addR, addX, rowY + addR); addGrad.addColorStop(0, '#64d4fb'); addGrad.addColorStop(1, '#126497'); ctx.fillStyle = addGrad; ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 7; ctx.beginPath(); ctx.arc(addX, rowY, addR, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0; ctx.strokeStyle = 'rgba(229,250,255,.9)'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.fillStyle = '#fff'; ctx.font = 'bold 13px sans-serif'; ctx.fillText('投珠', addX, rowY + 5); const actionGrad = ctx.createLinearGradient(actionX, rowY - actionH / 2, actionX, rowY + actionH / 2); actionGrad.addColorStop(0, state.phase === 'confirm' ? '#54c9ed' : '#67e778'); actionGrad.addColorStop(1, state.phase === 'confirm' ? '#176fa8' : '#148c42'); ctx.fillStyle = actionGrad; ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 7; roundedRectPath(actionX - actionW / 2, rowY - actionH / 2, actionW, actionH, 12); ctx.fill(); ctx.shadowBlur = 0; ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.fillStyle = '#fff'; ctx.font = 'bold 12px sans-serif'; ctx.fillText(state.phase === 'confirm' ? '确认倍率' : '长按发射', actionX, rowY + 4); const shopY = rowY - shopH / 2; ctx.fillStyle = '#3a2a12'; ctx.fillRect(shopX, shopY, shopW, shopH); ctx.strokeStyle = '#ffd35a'; ctx.lineWidth = 1.5; ctx.strokeRect(shopX, shopY, shopW, shopH); ctx.fillStyle = '#ffd35a'; ctx.font = 'bold 14px sans-serif'; ctx.textBaseline = 'middle'; ctx.fillText('商城', shopX + shopW / 2, rowY); ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'start'; uiWager.addX = addX; uiWager.addY = rowY; uiWager.addR = addR; uiWager.startX = actionX; uiWager.startY = rowY; uiWager.startR = actionW / 2; shopBtn.x = shopX; shopBtn.y = shopY; shopBtn.w = shopW; shopBtn.h = shopH; } drawAudioToggle();
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
function handleShopTap(it) { if (it.action === 'skin') { const i = it.arg; if (state.skin === i) return; if (state.owned.skins.indexOf(i) >= 0) { state.skin = i; } else { const c = skins[i].cost; if (state.marbles >= c) { state.marbles -= c; state.owned.skins.push(i); state.skin = i; } else { Snd.sfxDeny(); wx.showToast({ title: '弹珠不足', icon: 'none' }); draw(); return; } } } else if (it.action === 'halo') { const i = it.arg; if (state.halo === i) return; if (state.owned.halos.indexOf(i) >= 0) { state.halo = i; } else { const c = halos[i].cost; if (state.diamonds >= c) { state.diamonds -= c; state.owned.halos.push(i); state.halo = i; } else { Snd.sfxDeny(); wx.showToast({ title: '钻石不足', icon: 'none' }); draw(); return; } } } else if (it.action === 'trail') { const i = it.arg; if (state.trail === i) return; if (state.owned.trails.indexOf(i) >= 0) { state.trail = i; } else { const c = trails[i].cost; if (state.diamonds >= c) { state.diamonds -= c; state.owned.trails.push(i); state.trail = i; } else { Snd.sfxDeny(); wx.showToast({ title: '钻石不足', icon: 'none' }); draw(); return; } } } else if (it.action === 'exchange') { if (state.diamonds >= 50) { state.diamonds -= 50; state.marbles += 1000; } else { Snd.sfxDeny(); wx.showToast({ title: '钻石不足', icon: 'none' }); draw(); return; } } save(); draw(); Snd.sfxBuy(); }
function randomize() { state.multiplierReady = false; state.randomizing = true; let n = 0; const timer = setInterval(() => { n += 1; const i = Math.floor(Math.random() * 4); state.multiplier = [2, 3, 5, 10][i]; const count = [5, 4, 2, 1][i]; const picks = []; while (picks.length < count) { const slot = Math.floor(Math.random() * slotCount); if (picks.indexOf(slot) < 0) picks.push(slot); } state.lit = new Set(picks); draw(); Snd.sfxTick(); if (n >= 14) { clearInterval(timer); state.randomizing = false; state.multiplierReady = true; state.phase = 'charge'; draw(); } }, 70); }
function showFree() { if (state.marbles !== 0 || state.freeClaims >= 2 || state.modal) return; state.modal = true; wx.showModal({ title: '弹珠不足', content: `今日还剩 ${2 - state.freeClaims} 次免费领取
每次补充 50 颗弹珠`, confirmText: '领取50颗', cancelText: '关闭', complete: (r) => { state.modal = false; if (r.confirm) { state.marbles += 50; state.freeClaims += 1; Snd.sfxReward(); save(); draw(); } } }); }
function launch() { const launchPower = state.power; state.power = 0; state.powerShow = launchPower; state.powerKeep = 70; if (state.marbles <= 0) { showFree(); return; } const e = launchEnergy(launchPower); const tg = trackGeometry(e.startY); state.ball = { phase: 'rail', s: 0, v: e.v0, startY: e.startY, x: trackX, y: e.startY, launchPower, total: tg.total, vert: tg.verticalLength, arc: tg.arcLength, hinted: false }; state.running = true; state.phase = 'confirm'; Snd.sfxLaunch(); }
let lastT = 0; let physicsAccumulator = 0;
function loop() { const now = Date.now(); let dt = lastT ? now - lastT : 16.666; lastT = now; if (dt > 66) dt = 66; else if (dt < 1) dt = 16.666; const f = dt / (1000 / 60); if (state.charging) { state.power += state.powerDir * 2 * f; if (state.power >= 100) { state.power = 100; state.powerDir = -1; } if (state.power <= 0) { state.power = 0; state.powerDir = 1; } state.powerShow = state.power; } if (state.running && state.ball) { const b = state.ball; if (b.phase === 'rail') { let ce; if (b.s <= b.vert) ce = 1; else if (b.s <= b.vert + b.arc) ce = Math.cos((b.s - b.vert) / trackRadius); else ce = 0; const falling = b.v < 0; if (falling && !b.hinted) { b.hinted = true; wx.showToast({ title: '力度不足，弹珠回落', icon: 'none' }); } const kt = (falling ? RAIL_DOWN_T : RAIL_UP_T) * f; b.v -= ce * RAIL_G * (falling ? RAIL_RETURN_G : 1) * kt; b.s += b.v * kt; if (b.s <= 0) { state.ball = null; state.running = false; state.phase = 'charge'; } else if (!falling && b.s >= b.total) { const wager = Math.min(state.wager, state.marbles); state.marbles -= wager; save(); b.phase = 'board'; b.wager = wager; b.settled = false; b.ageFrames = 0; b.stillF = 0; b.nudges = 0; const exX = trackExitX + (Math.random() - 0.5) * 1.6; const body = Bodies.circle(exX, trackExitY, 6, { restitution: 0.48, friction: 0.012, frictionStatic: 0, frictionAir: AIR_DAMP }); World.add(engine.world, body); body.label = 'ball'; b.body = body; Body.setPosition(body, { x: exX, y: trackExitY }); Body.setVelocity(body, { x: (-b.v * RAIL_K + (Math.random() - 0.5) * 0.5) * RAIL_T, y: EXIT_VY + (Math.random() - 0.5) * 0.3 * RAIL_T }); Body.setAngularVelocity(body, 0); b.x = exX; b.y = trackExitY; b.lx = exX; b.ly = trackExitY; } else { const t = Math.max(0, Math.min(1, b.s / b.total)); const p = trackPoint(t, b.startY); b.x = p.x; b.y = p.y; } } else if (b.phase === 'board') { physicsAccumulator = Math.min(33.332, physicsAccumulator + dt); const physicsStep = 16.666; let physicsSteps = Math.min(2, Math.floor(physicsAccumulator / physicsStep)); if (physicsSteps < 1) { physicsSteps = 1; physicsAccumulator = 0; } else { physicsAccumulator = Math.max(0, physicsAccumulator - physicsSteps * physicsStep); } for (let step = 0; step < physicsSteps; step += 1) Engine.update(engine, physicsStep); const clampedX = Math.max(left + 8, Math.min(right - 8, b.body.position.x)); if (clampedX !== b.body.position.x) Body.setPosition(b.body, { x: clampedX, y: b.body.position.y }); b.x = clampedX; b.y = b.body.position.y; b.ageFrames += f; const moved = Math.hypot(b.x - b.lx, b.y - b.ly); b.lx = b.x; b.ly = b.y; const speed = Math.hypot(b.body.velocity.x, b.body.velocity.y); if (moved < 0.24 && speed < 0.7 && b.y < bottom - 34) b.stillF += f; else b.stillF = Math.max(0, b.stillF - f * 0.5); if (b.y > bottom + 14 && b.y < bottom + 34 && Math.abs(b.body.velocity.x) < 0.5 && Math.abs(b.body.velocity.y) < 0.6) { const cx = left + Math.round((b.x - left) / slotWidth) * slotWidth; const dir = b.x >= cx ? 1 : -1; Body.setVelocity(b.body, { x: dir * 1.0, y: b.body.velocity.y }); } if (b.stillF > 12) { b.stillF = 0; b.nudges += 1; if (b.nudges >= 6) { b.ageFrames = 1200; } else { const kickX = Math.random() < 0.5 ? -1.25 : 1.25; Body.setVelocity(b.body, { x: kickX, y: 3.4 }); Body.setAngularVelocity(b.body, kickX * 0.18); Body.translate(b.body, { x: kickX * 0.35, y: 0.8 }); } } if ((b.y >= bottom + 35 || b.ageFrames > 1100) && !b.settled) { b.settled = true; Snd.sfxDrop(); b.phase = 'settle'; b.settleFrames = 0; b.stopVx = (b.trail && b.trail.length ? b.trail[b.trail.length - 1].vx : 0); b.stopVy = (b.trail && b.trail.length ? b.trail[b.trail.length - 1].vy : 0); b.trailFade = 0; b.slot = Math.max(0, Math.min(slotCount - 1, Math.floor((b.x - left) / slotWidth))); Body.setStatic(b.body, true); Body.setPosition(b.body, { x: left + b.slot * slotWidth + slotWidth / 2, y: bottom + 42 }); Body.setVelocity(b.body, { x: 0, y: 0 }); b.x = left + b.slot * slotWidth + slotWidth / 2; b.y = bottom + 42; } } else if (b.phase === 'settle') { b.settleFrames += f; if (b.trail && b.trail.length > 0 && state.trail > 0) { b.trailFade = (b.trailFade || 0) + 1; const dec = Math.max(0.2, 1 - b.trailFade / 26); let _sp = Math.hypot(b.stopVx || 0, b.stopVy || 0); let _dx = (b.stopVx || 0), _dy = (b.stopVy || 0); if (_sp > 1.8) { _dx = _dx / _sp * 1.8; _dy = _dy / _sp * 1.8; } _dx *= dec; _dy *= dec; for (let i = 0; i < b.trail.length - 1; i++) { b.trail[i].x += _dx; b.trail[i].y += _dy; } const _h = b.trail[b.trail.length - 1]; _h.x = b.x; _h.y = b.y; if (b.trailFade > 16) b.trail = []; } if (b.settleFrames >= 55) { const win = state.lit.has(b.slot); Snd.sfxResult(win, state.multiplier); const reward = win ? b.wager * state.multiplier : 0; state.marbles += reward; state.diamonds += Math.floor(reward / 50); World.remove(engine.world, b.body); state.ball = null; state.running = false; state.phase = 'confirm'; state.multiplierReady = false; state.multiplier = 0; state.wager = 0; state.lit = new Set(); save(); wx.showModal({ title: win ? '恭喜你' : '很遗憾', content: win ? `获得 ${reward} 颗弹珠
钻石 +${Math.floor(reward / 50)} 颗` : '再试一次吧', showCancel: false }); } } } if (state.running && state.ball && state.ball.phase !== 'settle') { const b = state.ball; b.trail = b.trail || []; const vx = (b.phase === 'board' && b.body) ? b.body.velocity.x : 0; const vy = (b.phase === 'board' && b.body) ? b.body.velocity.y : 0; b.trail.push({ x: b.x, y: b.y, vx, vy }); const maxLen = [0, 5, 8, 8][state.trail]; while (b.trail.length > maxLen) b.trail.shift(); } if (!state.charging && state.powerShow > 0) { if (state.powerKeep > 0) state.powerKeep -= f; else state.powerShow = Math.max(0, state.powerShow - 3 * f); } draw(); frame(loop); }
wx.onTouchStart((e) => { const t = e.touches && e.touches[0]; if (!t) return; const x = t.clientX; const y = t.clientY;
  // 音频解锁必须在触摸回调里做: iOS 上 WebAudioContext 初始是 suspended,
  // 不 resume 的话整局都不会出声, 而且不报任何错 —— 很难查。代价是这第一次点击本身听不到声音。
  if (!audioUnlocked) { audioUnlocked = true; Snd.unlock(); applyAudioMode(false); }
  // 喇叭按钮排在最前: 商城打开 / 弹珠运行时也要能切声音
  if (audBtn.w > 0 && x >= audBtn.x && x <= audBtn.x + audBtn.w && y >= audBtn.y && y <= audBtn.y + audBtn.h) {
    state.audioMode = (state.audioMode + 1) % AUDIO_MODES.length;
    applyAudioMode(true); save(); draw(); return;
  }
  const sbx2 = shopBtn.x; const sby2 = shopBtn.y; // 必须挡在商城按钮之前: 否则弹珠运行时点这里会打开商城, 而物理照常跑完, 结算 showModal 会盖在商城上。
if (!state.running && !state.randomizing && !state.modal && sbx2 > 0 && x >= sbx2 && x <= sbx2 + shopBtn.w && y >= sby2 && y <= sby2 + shopBtn.h) { state.shop = !state.shop; state.charging = false; Snd.sfxTap(); draw(); return; } if (state.shop) { for (let i = 0; i < shopItems.length; i += 1) { const it = shopItems[i]; if (x >= it.x && x <= it.x + it.w && y >= it.y && y <= it.y + it.h) { handleShopTap(it); return; } } state.shop = false; Snd.sfxTap(); draw(); return; } if (state.running || state.randomizing || state.modal) return; if (uiWager.addR > 0 && Math.hypot(x - uiWager.addX, y - uiWager.addY) <= uiWager.addR + 8) { state.wager = Math.min(100, state.wager + 1); Snd.sfxTap(); draw(); if (wagerTimer) clearTimeout(wagerTimer); if (wagerRepeat) clearInterval(wagerRepeat); wagerTimer = setTimeout(() => { wagerRepeat = setInterval(() => { if (state.wager >= 100) { clearInterval(wagerRepeat); wagerRepeat = null; return; } state.wager += 1; draw(); }, 70); }, 350); return; } if (uiWager.startR > 0 && Math.hypot(x - uiWager.startX, y - uiWager.startY) <= uiWager.startR + 8) { if (state.wager < 5) { wx.showToast({ title: '至少投5个珠子后才能开始', icon: 'none' }); return; } if (state.phase === 'confirm') { Snd.sfxTap(); randomize(); return; } if (state.phase === 'charge') { Snd.sfxTap(); state.charging = true; state.power = 0; state.powerShow = 0; state.powerKeep = 0; state.powerDir = 1; } return; }  });
wx.onShow(() => { if (audioUnlocked && Snd.getBgmOn()) Snd.startBgm(); });
wx.onHide(() => { Snd.stopBgm(); });
wx.onTouchEnd(() => { if (wagerTimer) { clearTimeout(wagerTimer); wagerTimer = null; } if (wagerRepeat) { clearInterval(wagerRepeat); wagerRepeat = null; } if (!state.charging) return; state.charging = false; launch(); });
if (typeof wx.onTouchCancel === 'function') wx.onTouchCancel(() => { if (wagerTimer) { clearTimeout(wagerTimer); wagerTimer = null; } if (wagerRepeat) { clearInterval(wagerRepeat); wagerRepeat = null; } state.charging = false; state.power = 0; state.powerShow = 0; draw(); });
frame(loop); draw(); if (state.marbles === 0) setTimeout(showFree, 300);















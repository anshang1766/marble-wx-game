'use strict';
/**
 * audio.js —— 运行时合成音频引擎（零素材）
 *
 * 所有声音由振荡器 / 噪声实时合成，因此：
 *   · 不占任何包体（主包只有 4MB，一段 mp3 BGM 要吃掉一半）
 *   · 无版权风险
 *   · 音色 / 音高 / 节奏全是常量，可以像 PEG_REST_NORMAL 那样直接调
 *
 * 平台要求：微信基础库 >= 2.19.0 才有 wx.createWebAudioContext。
 * 低版本或不支持时全部 API 自动降级为空操作，游戏逻辑不受影响。
 *
 * 三条必须知道的平台规则（踩过才知道）：
 *   1) WebAudioContext 初始 state 是 'suspended'，必须在**触摸回调里** resume 才能出声（iOS 强制）。
 *   2) resume 之后仍建议播一个静音 buffer 真正激活硬件通道，否则第一次发声会被吞掉。
 *   3) 不能用 setInterval 直接控制发声时刻（抖动巨大），必须用 lookahead 提前把节点排在
 *      ctx.currentTime 之后的精确时间点上。
 */

// ========================= 手感旋钮（改音色只动这里） =========================
const VOL_MASTER = 0.9;
const VOL_SFX = 0.62;
const VOL_MUSIC = 0.3;

const BPM = 76;                       // Lo-fi 典型速度，慢但每口 Tape 走得稳
const SPB = 60 / BPM;                 // 每拍秒数
const STEP = SPB / 2;                 // 一个八分音符
const SWING = 0.28;                   // 反拍延后比例 —— Lo-fi "摇摆感"的来源
const TONE_CUTOFF = 2600;             // 全局低通：Lo-fi 的闷，也是防止刺耳的保险

const MAX_VOICES = 24;                // 同时发声上限，超了直接丢弃新音（保帧率）

// —— 碰钉音高：自上而下每排一个音，连起来是一条下行五声音阶 ——
const PEG_ROW_BASE = 523.25;          // C5
const PEG_ROW_SEMI = [12, 9, 7, 4, 2, 0, -3, -5, -8, -10, -12];
//   半音偏移 → C6 A5 G5 E5 D5 C5 A4 G4 E4 D4 C4（每排一个，共 11 排）。
//   取 C 大调五声音阶，与 BGM 的 Cmaj7–Am7–Dm7–G7 同调，钉声叠在音乐上不会打架。
//   方向为「顶排高 → 底排低」：球越往下速度越快、撞得越狠，低音听着更厚实；
//   顶排慢而轻，高音更清脆。想反过来（越掉越高、制造爬升感）把数组 reverse() 即可。
//   排数比数组长时夹紧到最后一档，不循环 —— 循环会让底部突然跳回高音。

// ========================= 上下文与总线 =========================
let ac = null;                        // WebAudioContext
let masterGain = null;
let sfxGain = null;
let musicGain = null;
let supported = true;                 // 平台是否支持 WebAudio
let noiseBuf = null;                  // 复用的白噪声，避免每次申请内存

function ensureCtx() {
  if (ac || !supported) return ac;
  if (typeof wx === 'undefined' || typeof wx.createWebAudioContext !== 'function') {
    supported = false;
    return null;
  }
  try {
    ac = wx.createWebAudioContext();
  } catch (e) {
    supported = false;
    return null;
  }
  try {
    // 全局低通染色：让合成音不那么"电子"，接近磁带味
    const tone = ac.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = TONE_CUTOFF;
    tone.Q.value = 0.7;

    masterGain = ac.createGain();
    masterGain.gain.value = VOL_MASTER;
    masterGain.connect(tone);
    tone.connect(ac.destination);

    sfxGain = ac.createGain();
    // 尊重 unlock 之前已设好的偏好：否则"关掉音效"后首次触摸创建上下文时，
    // 音量会被刷回默认值，等于用户的设置失效。
    sfxGain.gain.value = wantSfx ? VOL_SFX : 0;
    sfxGain.connect(masterGain);

    musicGain = ac.createGain();
    musicGain.gain.value = 0;           // 由 startBgm 淡入
    musicGain.connect(masterGain);
  } catch (e) {
    supported = false;
    ac = null;
    return null;
  }
  return ac;
}

function ctxTime() { return ac ? ac.currentTime : 0; }

// 发声槽位回收：**绝不能用 setTimeout 计时**。小游戏切后台时 timer 会被冻结，
// 计数只增不减，回到前台后 voice 数永久超限 → 音频彻底静默且无任何报错。
// 改为按音频时钟自行过期，ctx.currentTime 一直在走，天然自愈。
const voiceEnds = [];

function endVoiceAt(t) { voiceEnds.push(t); }

// 关键音豁免：结算琶音要 14 个槽，BGM 稳态又占着十几个，撞上 MAX_VOICES 就会被丢掉几个音，
// 听起来就是"琶音断了一截"。BGM 少一两个音没人察觉，结算少一个就很明显，故给结算一个短暂豁免窗口。
// 用音频时钟判断而不是 timer —— 切后台时 timer 会冻结，那样豁免窗口会一直开着。
let graceUntil = -1;
const GRACE_EXTRA = 16;   // 结算最多要 14 个槽，留 2 个余量

function canVoice() {
  if (!ac) return false;
  const t = ctxTime();
  for (let i = voiceEnds.length - 1; i >= 0; i -= 1) if (voiceEnds[i] <= t) voiceEnds.splice(i, 1);
  if (voiceEnds.length < MAX_VOICES) return true;
  return t < graceUntil && voiceEnds.length < MAX_VOICES + GRACE_EXTRA;
}

function liveVoiceCount() { return voiceEnds.length; }

function getNoise() {
  if (noiseBuf) return noiseBuf;
  const len = Math.max(1, Math.floor(ac.sampleRate * 0.6));
  noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i += 1) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

// ========================= 通用节点工厂 =========================
/** 一个带 ADSR 包络的振荡器 */
function osc(opt) {
  if (!ac || !canVoice()) return;
  const t = opt.t;
  const dur = opt.dur;
  try {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = opt.type || 'sine';
    o.frequency.setValueAtTime(Math.max(20, opt.f0), t);
    if (opt.f1 && opt.f1 !== opt.f0) {
      o.frequency.exponentialRampToValueAtTime(Math.max(20, opt.f1), t + dur);
    }
    if (opt.detune) o.detune.value = opt.detune;

    const atk = opt.attack === undefined ? 0.005 : opt.attack;
    const peak = opt.peak;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + Math.min(atk, dur * 0.5));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    let tail = g;
    if (opt.filter) {
      const bq = ac.createBiquadFilter();
      bq.type = opt.filter.type || 'lowpass';
      bq.frequency.value = opt.filter.freq;
      if (opt.filter.q !== undefined) bq.Q.value = opt.filter.q;
      g.connect(bq);
      tail = bq;
    }
    o.connect(g);
    tail.connect(opt.dest || sfxGain);
    o.start(t);
    o.stop(t + dur + 0.03);
    endVoiceAt(t + dur);
  } catch (e) { /* 单个音失败不影响游戏 */ }
}

/** 一段带包络的噪声（鼓、沙锤、whoosh 都靠它） */
function noise(opt) {
  if (!ac || !canVoice()) return;
  const t = opt.t;
  try {
    const src = ac.createBufferSource();
    src.buffer = getNoise();
    src.loop = true;
    if (opt.rate) src.playbackRate.value = opt.rate;
    const g = ac.createGain();
    let dur = opt.dur;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(opt.peak, t + (opt.attack === undefined ? 0.004 : opt.attack));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    let tail = g;
    if (opt.filter) {
      const bq = ac.createBiquadFilter();
      bq.type = opt.filter.type || 'bandpass';
      bq.frequency.setValueAtTime(opt.filter.freq, t);
      if (opt.filter.freq1) bq.frequency.exponentialRampToValueAtTime(opt.filter.freq1, t + dur);
      if (opt.filter.q !== undefined) bq.Q.value = opt.filter.q;
      g.connect(bq);
      tail = bq;
    }
    src.connect(g);
    tail.connect(opt.dest || sfxGain);
    src.start(t);
    src.stop(t + dur + 0.03);
    endVoiceAt(t + dur);
  } catch (e) { /* ignore */ }
}

// ========================= 音效 =========================
// intensity 约定：0~1 的归一化碰撞强度，由调用方按速度算出

let pegBudget = 0;
let budgetAt = -1;

/** 碰钉 —— 最高频的音效，必须节流 + 按强度变音量/音高，否则会糊成噪音 */
/** 取第 row 排的基频（Hz）。row 越界时夹紧到首/末档，不循环。 */
function pegRowFreq(row) {
  const n = PEG_ROW_SEMI.length;
  const i = Math.min(n - 1, Math.max(0, row | 0));
  return PEG_ROW_BASE * Math.pow(2, PEG_ROW_SEMI[i] / 12);
}

function sfxPeg(kind, intensity, row) {
  if (!canVoice()) return;
  const now = ctxTime();
  // 每 50ms 给 3 个名额：密集团簇只保留前几个，避免"沙沙"一片
  if (now - budgetAt > 0.05) { budgetAt = now; pegBudget = 3; }
  if (pegBudget <= 0) return;
  pegBudget -= 1;

  const v = Math.max(0, Math.min(1, intensity));
  const jitter = 1 + (Math.random() - 0.5) * 0.06;   // 微失谐，去掉机械感
  // 音高由"第几排"决定，撞击强度只做 ±5% 微调：
  // 调幅再大一点，排与排的音高差就被淹没，等于白做。力度差异交给音量表达。
  const base = pegRowFreq(row === undefined ? Math.floor(PEG_ROW_SEMI.length / 2) : row);
  const f = base * (0.95 + 0.1 * v) * jitter;
  // 等响度补偿：手机外放对 400Hz 以下几乎没响应，底下几排会变成"闷响"听不清。
  // 低频按缺少的量补增益（最多 +45%），否则最低三排在真机上等于没有声音。
  const boost = base < 420 ? 1 + Math.min(0.45, (420 - base) / 420) : 1;
  if (kind === 2) {
    // 绿钉（加速）：上滑，听感上"被踢了一脚"。
    // 底部排基频只有 330Hz，直接 ×1.5 也不够亮，故给 620 的下限保住"加速"的辨识度。
    const g = Math.max(f * 1.5, 620);
    osc({ type: 'triangle', f0: f, f1: g, t: now, dur: 0.12, peak: (0.16 + 0.26 * v) * boost, attack: 0.003 });
    osc({ type: 'sine', f0: g * 1.3, t: now, dur: 0.08, peak: (0.05 + 0.08 * v) * boost, attack: 0.002 });
  } else if (kind === 1) {
    // 蓝钉（阻尼）：低八度 + 低通，闷、带一点"噗"的失落感
    osc({ type: 'sine', f0: f * 0.5, t: now, dur: 0.14, peak: (0.14 + 0.2 * v) * boost, attack: 0.005, filter: { type: 'lowpass', freq: 900, q: 0.8 } });
  } else {
    // 普通钉：清脆木琴感，配合行音高就是"叮—叮—叮"往下走的一条音阶
    osc({ type: 'triangle', f0: f, t: now, dur: 0.08, peak: (0.13 + 0.3 * v) * boost, attack: 0.002 });
    osc({ type: 'sine', f0: f * 2, t: now, dur: 0.05, peak: (0.04 + 0.09 * v) * boost, attack: 0.001 });
  }
}

/** 撞左右墙 / 撞分隔板 —— 低频 "咚" */
function sfxWall(intensity) {
  if (!canVoice()) return;
  const now = ctxTime();
  const v = Math.max(0, Math.min(1, intensity));
  osc({ type: 'sine', f0: 165, f1: 88, t: now, dur: 0.13, peak: 0.14 + 0.22 * v, attack: 0.003, filter: { type: 'lowpass', freq: 700, q: 0.9 } });
  noise({ t: now, dur: 0.05, peak: 0.05 + 0.06 * v, filter: { type: 'bandpass', freq: 420, q: 1.1 } });
}

/** 发射 —— 上行 sweep + 气动 whoosh */
function sfxLaunch() {
  if (!canVoice()) return;
  const now = ctxTime();
  osc({ type: 'sine', f0: 190, f1: 640, t: now, dur: 0.3, peak: 0.2, attack: 0.02 });
  noise({ t: now, dur: 0.34, peak: 0.12, attack: 0.05, filter: { type: 'bandpass', freq: 500, freq1: 2600, q: 1.4 } });
}

/** 抽奖滚动的每一格 tick —— 短促、极轻，只是给手指一个"在动"的反馈 */
function sfxTick() {
  if (!canVoice()) return;
  osc({ type: 'square', f0: 1480 + Math.random() * 160, t: ctxTime(), dur: 0.022, peak: 0.075, attack: 0.001, filter: { type: 'lowpass', freq: 3400, q: 0.7 } });
}

// UI 点击：长按「投珠」会以 70ms 的间隔连发，不节流会变成机关枪
let lastTap = -1;
function sfxTap() {
  if (!canVoice()) return;
  const now = ctxTime();
  if (now - lastTap < 0.06) return;
  lastTap = now;
  osc({ type: 'triangle', f0: 1150, f1: 900, t: ctxTime(), dur: 0.035, peak: 0.12, attack: 0.001 });
}

/** 不足 / 拒绝 —— 下行小二度，不刺耳但明确"不行" */
function sfxDeny() {
  if (!canVoice()) return;
  const now = ctxTime();
  osc({ type: 'square', f0: 200, t: now, dur: 0.09, peak: 0.1, attack: 0.004, filter: { type: 'lowpass', freq: 1000, q: 0.8 } });
  osc({ type: 'square', f0: 188, t: now + 0.1, dur: 0.11, peak: 0.1, attack: 0.004, filter: { type: 'lowpass', freq: 1000, q: 0.8 } });
}

/** 购买 / 装备成功 —— 上行三音 */
function sfxBuy() {
  if (!canVoice()) return;
  const now = ctxTime();
  [523.25, 659.25, 783.99].forEach((f, i) => {
    osc({ type: 'triangle', f0: f, t: now + i * 0.06, dur: 0.16, peak: 0.16, attack: 0.006 });
  });
}

/** 免费领取 —— 铃音三连 */
function sfxReward() {
  if (!canVoice()) return;
  const now = ctxTime();
  [1046.5, 1318.5, 1568].forEach((f, i) => {
    osc({ type: 'sine', f0: f, t: now + i * 0.07, dur: 0.3, peak: 0.14, attack: 0.004 });
    osc({ type: 'triangle', f0: f * 2, t: now + i * 0.07, dur: 0.16, peak: 0.04, attack: 0.004 });
  });
}

/** 落槽：一声软 "咚"，告诉玩家这局结束了 */
function sfxDrop() {
  if (!canVoice()) return;
  osc({ type: 'sine', f0: 240, f1: 130, t: ctxTime(), dur: 0.16, peak: 0.18, attack: 0.004, filter: { type: 'lowpass', freq: 800, q: 0.9 } });
}

/**
 * BGM 闪避：结算是全局情绪最重的一下，但 BGM 音量 0.3 而结算音只有 0.26×0.62≈0.16，
 * 直接叠上去会被音乐糊住 —— 这正是之前"中奖没感觉"的主因。
 * 短暂把音乐压到 DUCK_LEVEL，让结算音从背景里浮出来，再平滑恢复。
 * 只有 BGM 正在放（bgmTimer 存在）才做，否则没有可压的东西。
 */
const DUCK_LEVEL = 0.4;
function duckMusic(holdSec) {
  if (!ac || !musicGain || !bgmTimer) return;
  const now = ctxTime();
  try {
    const g = musicGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(Math.max(0.0001, g.value), now);
    g.linearRampToValueAtTime(VOL_MUSIC * DUCK_LEVEL, now + 0.1);
    g.setValueAtTime(VOL_MUSIC * DUCK_LEVEL, now + holdSec);
    g.linearRampToValueAtTime(VOL_MUSIC, now + holdSec + 0.6);
  } catch (e) { /* ignore */ }
}

/**
 * 结算：两端用完全相反的音乐语言，让情绪不需要看弹窗就能听出来。
 *
 *   中奖   —— 上行大三和弦琶音（明亮、跳跃、往上走）：倍率越高音越多（3→6 个），
 *             起调也越高（2/3/5/10 倍相差 0/2/4/7 个半音），5 倍以上再叠一层高频亮片。
 *   未中奖 —— 下行小调音程 G4→Eb4→Bb3，音量逐层递减、后两音带微微下滑，
 *             整体过一层 1200Hz 低通变暗。听起来就是一声叹气。
 *
 * peak 上限 0.26 而不是更高：琶音有 4~6 个音会重叠，叠满约 1.0，再乘总线仍在安全区，
 * 再高就会削波失真。
 */
function sfxResult(win, multiplier) {
  if (!ac) return;
  const now = ctxTime();
  // 豁免必须先开再做槽位检查：写在 canVoice() 之后的话，槽位一满函数就在第一行把自己挡掉了，
  // 窗口永远轮不到设置 —— 等于豁免形同虚设（这个顺序 bug 是被离线测试抓出来的）。
  graceUntil = now + 0.12;      // 所有节点都在这一次同步调用里创建完，窗口给 120ms 足够
  if (!canVoice()) return;
  if (!win) {
    duckMusic(1.3);
    // 一句"叹气"：三个下行音，越往后越轻、越低、越暗
    const sigh = [
      { f0: 392, f1: 392, dur: 0.30, peak: 0.22, at: 0 },
      { f0: 311, f1: 294, dur: 0.44, peak: 0.17, at: 0.17 },
      { f0: 233, f1: 216, dur: 0.78, peak: 0.12, at: 0.38 }
    ];
    sigh.forEach((n) => {
      osc({ type: 'triangle', f0: n.f0, f1: n.f1, t: now + n.at, dur: n.dur, peak: n.peak, attack: 0.012, filter: { type: 'lowpass', freq: 1200, q: 0.7 } });
    });
    return;
  }
  duckMusic(1.1);
  const semis = { 2: 0, 3: 2, 5: 4, 10: 7 }[multiplier] || 0;
  const root = 523.25 * Math.pow(2, semis / 12);      // C5 起算
  const steps = multiplier >= 10 ? [0, 4, 7, 12, 16, 19]
    : multiplier >= 5 ? [0, 4, 7, 12, 16]
      : multiplier >= 3 ? [0, 4, 7, 12]
        : [0, 4, 7];
  const gap = 0.068;
  steps.forEach((s, i) => {
    const f = root * Math.pow(2, s / 12);
    const t = now + i * gap;
    const last = i === steps.length - 1;
    osc({ type: 'triangle', f0: f, t, dur: last ? 0.62 : 0.3, peak: 0.26, attack: 0.006 });
    osc({ type: 'sine', f0: f * 2, t, dur: last ? 0.4 : 0.18, peak: 0.07, attack: 0.004 });
  });
  // 亮片：只有高倍率才有。短促的高频"叮"再往上窜一截，是"开心"的点睛之笔，
  // 也是 10 倍和 2 倍拉开档次的地方。
  if (multiplier >= 5) {
    const tEnd = now + steps.length * gap;
    osc({ type: 'sine', f0: root * 4, f1: root * 6, t: tEnd, dur: 0.5, peak: 0.09, attack: 0.01 });
    osc({ type: 'sine', f0: root * 6, t: tEnd + 0.09, dur: 0.45, peak: 0.06, attack: 0.008 });
  }
}

// ========================= Lo-fi BGM 音序器 =========================
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// I - vi - ii - V（Cmaj7 - Am7 - Dm7 - G7）：轻快休闲的万金油进行
const CHORDS = [
  { pad: [60, 64, 67, 71], bass: 48 },
  { pad: [57, 60, 64, 67], bass: 45 },
  { pad: [62, 65, 69, 72], bass: 50 },
  { pad: [59, 62, 65, 67], bass: 43 },
];

// 三组旋律变体，每轮循环随机挑一组 —— 固定旋律几分钟就腻，这是最便宜的"耐听"手段
const MELODIES = [
  [[64, null, 67, null, 69, null, null, null],
   [69, null, 67, null, 64, null, null, null],
   [null, 62, null, 65, 69, null, null, null],
   [67, null, 65, null, 62, null, null, null]],
  [[null, 67, null, 71, null, 69, null, null],
   [null, 64, null, 60, null, null, 64, null],
   [65, null, 69, null, 72, null, 69, null],
   [null, 67, null, 62, null, 59, null, null]],
  [[72, null, null, 67, null, 64, null, null],
   [null, null, 69, null, null, 67, null, 64],
   [null, 69, null, null, 65, null, 62, null],
   [67, null, null, 62, null, null, null, null]],
];

const KICK = [0, 6];
const SNARE = [4];

let bgmTimer = null;
let nextStepTime = 0;
let stepIdx = 0;
let melodyIdx = 0;
let vinylSrc = null;
const LOOKAHEAD = 0.14;      // 提前排程的时间窗
const TICK_MS = 26;          // 调度器轮询间隔

function playPad(notes, t) {
  const dur = STEP * 7.4;
  notes.forEach((n, i) => {
    // 每个音轻微失谐 + 音量递减，做出"三个音源一起拨弦"的厚度
    osc({ type: 'triangle', f0: mtof(n), t, dur, peak: 0.052 - i * 0.006, attack: 0.16, detune: -6 + i * 3, dest: musicGain });
    osc({ type: 'sine', f0: mtof(n - 12), t, dur, peak: 0.03, attack: 0.2, dest: musicGain });
  });
}

function playBass(note, t, dur) {
  osc({ type: 'sine', f0: mtof(note), t, dur, peak: 0.13, attack: 0.02, detune: -4, dest: musicGain, filter: { type: 'lowpass', freq: 420, q: 1.1 } });
  osc({ type: 'triangle', f0: mtof(note), t, dur: dur * 0.5, peak: 0.035, attack: 0.02, dest: musicGain, filter: { type: 'lowpass', freq: 600, q: 1 } });
}

function playLead(note, t) {
  osc({ type: 'triangle', f0: mtof(note), t, dur: STEP * 1.7, peak: 0.062, attack: 0.03, dest: musicGain });
}

function playKick(t) {
  osc({ type: 'sine', f0: 125, f1: 46, t, dur: 0.18, peak: 0.36, attack: 0.004, dest: musicGain });
}

function playSnare(t) {
  noise({ t, dur: 0.14, peak: 0.13, filter: { type: 'bandpass', freq: 1850, q: 1.2 }, dest: musicGain });
  osc({ type: 'triangle', f0: 195, f1: 150, t, dur: 0.08, peak: 0.07, attack: 0.003, dest: musicGain });
}

function playHat(t, peak) {
  noise({ t, dur: 0.035, peak, filter: { type: 'highpass', freq: 7600, q: 0.8 }, dest: musicGain });
}

/** 黑胶底噪 —— 音量极低，但没了它整个 Lo-fi 就"不脏"了 */
function startVinyl() {
  if (!ac || vinylSrc) return;
  try {
    const src = ac.createBufferSource();
    src.buffer = getNoise();
    src.loop = true;
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1200;
    const g = ac.createGain();
    g.gain.value = 0.012;
    src.connect(hp); hp.connect(g); g.connect(musicGain);
    src.start();
    vinylSrc = src;
  } catch (e) { /* ignore */ }
}

function scheduleStep(i, t) {
  const bar = Math.floor(i / 8) % 4;
  const s = i % 8;
  const ch = CHORDS[bar];
  const mel = MELODIES[melodyIdx][bar];

  if (s === 0) {
    playPad(ch.pad, t);
    playBass(ch.bass, t, STEP * 3.1);
  }
  if (s === 4) playBass(ch.bass + 7, t, STEP * 1.7);   // 五度经过音，低音才不呆

  const n = mel[s];
  if (n !== null && n !== undefined) playLead(n, t);

  if (KICK.indexOf(s) >= 0) playKick(t);
  if (SNARE.indexOf(s) >= 0) playSnare(t);
  playHat(t, s % 2 === 0 ? 0.032 : 0.019);
}

function scheduler() {
  if (!ac) return;
  const t = ac.currentTime;
  // 切后台再回来的必须保护：期间音频时钟照走，而本调度器的 timer 被冻结，
  // 于是 nextStepTime 会落后几十秒。不重置的话，下面的 while 会把积压的音符
  // 全部排在"已经过去"的时刻上，Web Audio 对过去时刻一律立即播放 ——
  // 回前台的瞬间会炸成一团噪声。
  if (nextStepTime < t - 0.25) nextStepTime = t + 0.05;
  const horizon = t + LOOKAHEAD;
  let guard = 0;
  while (nextStepTime < horizon && guard < 64) {
    // swing：反拍往后再推，这是 Lo-fi / Boom-bap 的呼吸
    const swung = (stepIdx % 2 === 1) ? nextStepTime + STEP * SWING : nextStepTime;
    scheduleStep(stepIdx, swung);
    stepIdx = (stepIdx + 1) % 32;
    if (stepIdx === 0) melodyIdx = (melodyIdx + 1) % MELODIES.length;
    nextStepTime += STEP;
    guard += 1;
  }
}

function startBgm() {
  if (!ensureCtx() || bgmTimer) return;
  if (isEffectivelyMuted()) return;
  startVinyl();
  nextStepTime = ac.currentTime + 0.1;
  stepIdx = 0;
  bgmTimer = setInterval(scheduler, TICK_MS);
  try {
    musicGain.gain.cancelScheduledValues(ac.currentTime);
    musicGain.gain.setValueAtTime(Math.max(0.0001, musicGain.gain.value), ac.currentTime);
    musicGain.gain.linearRampToValueAtTime(VOL_MUSIC, ac.currentTime + 1.4);
  } catch (e) { musicGain.gain.value = VOL_MUSIC; }
}

function stopBgm() {
  if (bgmTimer) { clearInterval(bgmTimer); bgmTimer = null; }
  if (!ac || !musicGain) return;
  try {
    musicGain.gain.cancelScheduledValues(ac.currentTime);
    musicGain.gain.setValueAtTime(Math.max(0.0001, musicGain.gain.value), ac.currentTime);
    musicGain.gain.linearRampToValueAtTime(0.0001, ac.currentTime + 0.45);
  } catch (e) { /* ignore */ }
}

// ========================= 对外 API =========================
let wantSfx = true;
let wantBgm = true;

function isEffectivelyMuted() { return !wantSfx && !wantBgm; }

/**
 * 解锁音频 —— **必须在触摸回调里调用**（通常在 wx.onTouchStart 的第一行）。
 * 没有这一步，iOS 上整局游戏都不会出声，而且不会报任何错。
 */
function unlock() {
  ensureCtx();
  if (!ac) return;
  try {
    if (ac.state === 'suspended' && typeof ac.resume === 'function') ac.resume();
  } catch (e) { /* ignore */ }
  try {
    // iOS 惯例：resume 之后还要真的推一个帧进输出才算解锁
    const s = ac.createBufferSource();
    s.buffer = ac.createBuffer(1, 1, ac.sampleRate);
    s.connect(ac.destination);
    s.start();
  } catch (e) { /* ignore */ }
  if (wantBgm) startBgm();
}

function setSfxOn(on) {
  wantSfx = !!on;
  if (sfxGain && ac) {
    try { sfxGain.gain.value = wantSfx ? VOL_SFX : 0; } catch (e) { /* ignore */ }
  }
}

function setBgmOn(on) {
  wantBgm = !!on;
  if (wantBgm) startBgm(); else stopBgm();
}

/**
 * 只记录偏好，**不创建音频上下文**。
 * 过早创建 AudioContext 会让 iOS 上后续 resume 的失败率明显上升，也会白白占用资源，
 * 所以真正的初始化必须推迟到玩家第一次触摸（unlock）时。
 */
function setPrefs(sfx, bgm) { wantSfx = !!sfx; wantBgm = !!bgm; }

module.exports = {
  unlock,
  isSupported: () => supported && !!ac,
  setPrefs,
  setSfxOn,
  setBgmOn,
  getBgmOn: () => wantBgm,
  getSfxOn: () => wantSfx,
  startBgm,
  stopBgm,
  sfxPeg,
  sfxWall,
  sfxLaunch,
  sfxTick,
  sfxTap,
  sfxDeny,
  sfxBuy,
  sfxReward,
  sfxDrop,
  sfxResult,
};

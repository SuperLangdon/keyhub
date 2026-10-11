// 灯效模拟引擎：按 ui 槽位（原驱动框架的固定效果槽）实现全部动画。
// 固件 fw 编号仅用于下发协议，模拟按效果槽语义渲染。

const TAU = Math.PI * 2;

export class LightSim {
  constructor() {
    this.model = null;
    this.cfg = null;
    this.pressed = new Map(); // i -> t0 按键反应
    this.geo = null;
    this.animUnits = null;  // 展开后的动画单元
    this.animKind = null;
  }

  setModel(model) {
    this.model = model;
    const keys = model.keys.filter((k) => k.r[2] > k.r[0] && k.r[3] > k.r[1]);
    const xs = keys.map((k) => (k.r[0] + k.r[2]) / 2 / model.img.w);
    const ys = keys.map((k) => (k.r[1] + k.r[3]) / 2 / model.img.h);
    let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
    for (const x of xs) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
    for (const y of ys) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const n = keys.length;
    this.geo = {
      n, keys,
      byId: new Map(keys.map((k, i) => [k.i, i])),
      cx: xs.map((x) => (x - x0) / Math.max(1e-6, x1 - x0)),
      cy: ys.map((y) => (y - y0) / Math.max(1e-6, y1 - y0)),
      col: xs.map((x) => Math.round((x - x0) / Math.max(1e-6, x1 - x0) * 15)),
      row: ys.map((y) => Math.round((y - y0) / Math.max(1e-6, y1 - y0) * 5)),
      rnd: xs.map((_, i) => fract(Math.sin((i + 1) * 12.9898) * 43758.5453)),
      index: keys.map((k) => k.i),
    };
  }

  setConfig(cfg) {
    this.cfg = cfg;
    this.animUnits = null;
    // 原版驱动的自定义模式无动画（只有调色盘+涂色）——不再消费 cfg.anim
  }

  press(i) { if (i != null) this.pressed.set(i, performance.now()); }

  // 输出 Float32Array(3n)
  render(tMs) {
    const { n } = this.geo;
    const out = this._out && this._out.length === n * 3 ? this._out : (this._out = new Float32Array(n * 3));
    out.fill(0);
    if (!this.cfg) return out;

    const ui = this.cfg.effectUi;
    const bright = [0, 0.25, 0.5, 0.75, 1][this.cfg.brightness ?? 4] ?? 1;
    const speed = [0.45, 0.68, 1, 1.5, 2.2][this.cfg.speed ?? 2] ?? 1;
    const t = (tMs / 1000) * speed;
    const color = this.cfg.colorful ? null : this.cfg.color;
    const perKey = this.cfg.perKey;

    // 涂色模式：直接显示已涂颜色
    if (this.paintMode && Object.keys(perKey).length) {
      for (let i = 0; i < n; i++) {
        const c = perKey[this.geo.index[i]];
        if (c) set(out, i, c);
      }
      return out;
    }

    switch (ui) {
      case 1: fixedFn(this.geo, out, color, perKey, bright); break;
      case 2: respire(this.geo, out, t, color, bright); break;
      case 3: rainbow(this.geo, out, t, bright); break;
      case 4: flashAway(this.geo, out, t, color, bright); break;
      case 5: raindrops(this.geo, out, t, color, bright, 0); break;
      case 6: rainbowWheel(this.geo, out, t, bright); break;
      case 7: ripples(this.geo, out, t, color, bright, this.pressed); break;
      case 8: raindrops(this.geo, out, t, color, bright, 1); break;  // 繁星点点
      case 9: shadowFade(this.geo, out, t, color, bright); break;
      case 10: retroSnake(this.geo, out, t, color, bright); break;
      case 11: neonStream(this.geo, out, t, color, bright); break;
      case 12: reactionFn(this.geo, out, t, color, bright, this.pressed); break;
      case 13: sineWave(this.geo, out, t, color, bright); break;
      case 14: retinueScan(this.geo, out, t, color, bright); break;
      case 15: windmill(this.geo, out, t, bright); break;
      case 16: waterfall(this.geo, out, t, bright); break;
      case 17: blossoming(this.geo, out, t, bright); break;
      case 18: storm(this.geo, out, t, bright); break;
      case 19: selfDefine(this.geo, out, t, this.animUnits, this.animKind, perKey, bright); break;
      default: break; // 关闭
    }
    // 按键点击闪亮（所有效果的即时反馈）
    if (this.pressed.size) {
      const now = performance.now();
      for (const [i, t0] of this.pressed) {
        const age = (now - t0) / 450;
        if (age >= 1) { this.pressed.delete(i); continue; }
        const idx = this.geo.byId.get(i);
        if (idx != null) add(out, idx, 255 * (1 - age) * 0.8, 255 * (1 - age) * 0.8, 255 * (1 - age) * 0.8);
      }
    }
    return out;
  }
}

// ---------- 效果实现 ----------
function fixedFn(g, out, color, perKey, bright) {
  const anyPaint = Object.keys(perKey).length > 0;
  for (let i = 0; i < g.n; i++) {
    const c = anyPaint ? (perKey[g.index[i]] || [0, 0, 0]) : (color || hsv(g.col[i] / 16, 1, 1));
    set(out, i, c, bright);
  }
}

function respire(g, out, t, color, bright) {
  const k = 0.5 + 0.5 * Math.sin(t * TAU / 2.2);
  for (let i = 0; i < g.n; i++) {
    const c = color || hsv(g.col[i] / 16 + t / 6, 1, 1);
    set(out, i, c, bright * k);
  }
}

function rainbow(g, out, t, bright) {
  for (let i = 0; i < g.n; i++) set(out, i, hsv(g.cx[i] - t / 3, 1, 1), bright);
}

function flashAway(g, out, t, color, bright) {
  const period = 2.4, ncols = 16;
  const phase = (t % period) / period * (ncols + 4);
  for (let i = 0; i < g.n; i++) {
    const d = phase - g.col[i];
    const k = d >= 0 ? Math.max(0, 1 - d * 0.45) : 0;
    const c = color || hsv(g.col[i] / 16, 1, 1);
    set(out, i, c, bright * k);
  }
}

function raindrops(g, out, t, color, bright, mode) {
  for (let i = 0; i < g.n; i++) {
    const r = g.rnd[i];
    const period = 1.4 + r * 2.2;
    const ph = ((t / period) + r) % 1;
    let k = mode === 1
      ? (ph < 0.12 ? ph / 0.12 : Math.max(0, 1 - (ph - 0.12) / 0.5))   // 繁星：快闪
      : Math.max(0, 1 - ph * 1.4);                                     // 雨滴：落下衰减
    k *= 0.4 + 0.6 * r;
    const c = color || hsv(r, 1, 1);
    set(out, i, c, bright * k);
  }
}

function rainbowWheel(g, out, t, bright) {
  for (let i = 0; i < g.n; i++) {
    const ang = Math.atan2(g.cy[i] - 0.5, g.cx[i] - 0.5) / TAU;
    set(out, i, hsv(ang + t / 2.4, 1, 1), bright);
  }
}

function ripples(g, out, t, color, bright, pressed) {
  for (let i = 0; i < g.n; i++) {
    let k = 0;
    const period = 2.2;
    const ph = ((t % period) / period);
    const d = Math.hypot(g.cx[i] - 0.5, g.cy[i] - 0.5) * 1.6;
    const ring = ph * 1.8;
    k = Math.max(0, 1 - Math.abs(d - ring) * 2.6);
    const c = color || hsv((g.cx[i] + t / 5) % 1, 1, 1);
    set(out, i, c, bright * k);
  }
  void pressed;
}

function shadowFade(g, out, t, color, bright) {
  const ncols = 16, period = 3.2;
  const pos = ((t % period) / period) * (ncols + 6) - 3;
  for (let i = 0; i < g.n; i++) {
    const d = pos - g.col[i];
    const k = d > 0 ? Math.max(0, 1 - d * 0.28) : Math.max(0, 1 + d * 6) * 0.25;
    const c = color || hsv(0.6, 1, 1);
    set(out, i, c, bright * k);
  }
}

function retroSnake(g, out, t, color, bright) {
  // 蛇形遍历列
  const ncols = 16, rows = 6;
  const total = ncols * 2;
  const head = (t % (total / 6)) * 6;
  for (let i = 0; i < g.n; i++) {
    let d = head - snakePos(g.col[i], g.row[i], ncols, rows);
    d = ((d % total) + total) % total;
    const k = Math.max(0, 1 - d * 0.16);
    const c = color || hsv(((g.col[i] / 16) + t / 4) % 1, 1, 1);
    set(out, i, c, bright * k);
  }
}
function snakePos(c, r, ncols) {
  return r % 2 ? ncols - 1 - c + r * ncols : c + r * ncols;
}

function neonStream(g, out, t, color, bright) {
  const ncols = 16;
  const pos = (t * 4) % (ncols + 8) - 4;
  for (let i = 0; i < g.n; i++) {
    const d = Math.abs(g.cx[i] * (ncols + 8) - 4 - pos);
    const k = Math.max(0, 1 - d * 0.5);
    const c = color || hsv((t / 2 + g.row[i] / 8) % 1, 1, 1);
    set(out, i, c, bright * k);
  }
}

function reactionFn(g, out, t, color, bright, pressed) {
  for (let i = 0; i < g.n; i++) set(out, i, color || [40, 40, 40], bright * 0.12);
  const now = performance.now();
  for (const [i, t0] of pressed) {
    const age = (now - t0) / 600;
    if (age >= 1) continue;
    const idx = g.byId.get(i);
    if (idx == null) continue;
    for (let j = 0; j < g.n; j++) {
      const dist = Math.abs(g.col[j] - g.col[idx]) + Math.abs(g.row[j] - g.row[idx]);
      const k = Math.max(0, 1 - (dist * 0.28 + age)) ** 2;
      const c = color || hsv((g.cx[j] + t / 4) % 1, 1, 1);
      add(out, j, c[0] * k * bright, c[1] * k * bright, c[2] * k * bright);
    }
  }
}

function sineWave(g, out, t, color, bright) {
  for (let i = 0; i < g.n; i++) {
    const k = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(g.cx[i] * TAU * 1.5 - t * TAU / 1.4));
    const c = color || hsv((g.cx[i] - t / 3) % 1, 1, 1);
    set(out, i, c, bright * k);
  }
}

function retinueScan(g, out, t, color, bright) {
  const ncols = 16;
  const c0 = Math.floor((t % 3) / 3 * ncols);
  for (let i = 0; i < g.n; i++) {
    const d = Math.abs(g.col[i] - c0);
    const k = Math.max(0, 1 - d * 0.5);
    const c = color || hsv(c0 / ncols, 1, 1);
    set(out, i, c, bright * (0.15 + 0.85 * k));
  }
}

function windmill(g, out, t, bright) {
  for (let i = 0; i < g.n; i++) {
    const ang = (Math.atan2(g.cy[i] - 0.45, (g.cx[i] - 0.5) * 1.9) / TAU + 1.5) % 1;
    const spin = (ang + t / 2.6) % 1;
    const arm = Math.floor(spin * 4) % 2; // 双色风车叶
    set(out, i, hsv((arm * 0.45 + t / 8) % 1, 1, 1), bright * (0.35 + 0.65 * spin));
  }
}

function waterfall(g, out, t, bright) {
  for (let i = 0; i < g.n; i++) {
    const ph = ((t * 0.5 + g.col[i] * 0.06) % 1);
    const k = Math.max(0, 1 - Math.abs(ph - g.cy[i]) * 2.4);
    set(out, i, hsv((g.col[i] / 16 + t / 6) % 1, 1, 1), bright * (0.2 + k));
  }
}

function blossoming(g, out, t, bright) {
  // 花开富贵：从中键区向外逐圈绽放
  const period = 2.6;
  const ph = ((t % period) / period) * 1.6;
  for (let i = 0; i < g.n; i++) {
    const d = Math.hypot(g.cx[i] - 0.5, (g.cy[i] - 0.5) * 1.6) * 2;
    const k = Math.max(0, 1 - Math.abs(d - ph) * 1.8) * (1 - ph * 0.45);
    set(out, i, hsv((0.9 + g.rnd[i] * 0.15 + t / 9) % 1, 0.85, 1), bright * (0.15 + k));
  }
}

function storm(g, out, t, bright) {
  for (let i = 0; i < g.n; i++) {
    const ang = (Math.atan2(g.cy[i] - 0.45, (g.cx[i] - 0.5) * 1.9) / TAU + 1) % 1;
    const swirl = (ang * 2 + t / 1.1 + g.rnd[i] * 0.12) % 1;
    set(out, i, hsv(swirl, 1, 1), bright * (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(swirl * TAU * 2))));
  }
}

function selfDefine(g, out, t, units, kind, perKey, bright) {
  const painted = Object.keys(perKey).length > 0;
  if (painted) {
    for (let i = 0; i < g.n; i++) {
      const c = perKey[g.index[i]];
      if (c) set(out, i, c, bright);
    }
    return;
  }
  // 无涂色：自定义模式为黑（原版语义——只显示涂上去的颜色）
  if (kind === 'fixon') {
    for (const u of units) for (const idx of u.keys) set(out, idx, u.color || [255, 255, 255], bright);
    return;
  }
  if (kind === 'wheel') {
    const nU = units.length;
    for (let n = 0; n < nU; n++) {
      const c = units[n].color || hsv(n / nU);
      for (const idx of units[n].keys) set(out, idx, c, bright);
    }
    return;
  }
  // 顺序扫过动画（breath / happy / flower / stream / rotate）
  const nU = units.length;
  const per = 0.55;
  const head = (t / per) % (nU + 3);
  for (let n = 0; n < nU; n++) {
    const d = head - n;
    const k = d >= 0 ? Math.max(0, 1 - d * 0.8) : 0;
    if (k <= 0) continue;
    const c = units[n].color || [255, 255, 255];
    for (const idx of units[n].keys) set(out, idx, c, bright * (kind === 'breath' ? Math.max(k, 0.5 + 0.5 * Math.sin(t * TAU)) : k));
  }
}

// ---------- 动画数据展开 ----------
function flattenAnim(lines, byId) {
  const rid = (i) => byId.get(i);
  const conv = (l) => l.groups.map((g) => g.map(rid).filter((x) => x != null));
  const units = [];
  for (const line of lines) {
    for (const gr of conv(line)) {
      if (gr.length) units.push({ keys: gr, color: line.color });
    }
  }
  const colors = interpolateColors(units.map((u) => u.color));
  units.forEach((u, i) => { u.color = colors[i]; });
  return units;
}

function interpolateColors(anchors) {
  const n = anchors.length;
  const out = new Array(n);
  const idxs = anchors.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
  if (!idxs.length) return anchors.map((_, i) => hsv(i / Math.max(1, n)));
  for (let i = 0; i < n; i++) {
    if (anchors[i]) { out[i] = anchors[i]; continue; }
    const prev = [...idxs].reverse().find((x) => x < i) ?? idxs[idxs.length - 1];
    const next = idxs.find((x) => x > i) ?? idxs[0];
    const span = ((next - prev + n) % n) || n;
    const f = ((i - prev + n) % n) / span;
    const a = anchors[prev], b = anchors[next];
    out[i] = [0, 1, 2].map((k) => a[k] + (b[k] - a[k]) * f);
  }
  return out;
}

// ---------- 工具 ----------
function set(out, i, c, k = 1) {
  out[i * 3] = c[0] * k; out[i * 3 + 1] = c[1] * k; out[i * 3 + 2] = c[2] * k;
}
function add(out, i, r, g2, b) {
  out[i * 3] += r; out[i * 3 + 1] += g2; out[i * 3 + 2] += b;
}
function hsv(h, s = 1, v = 1) {
  h = ((h % 1) + 1) % 1;
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), tt = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = tt; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = tt; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = tt; g = p; b = v; break;
    default: r = v; g = p; b = q;
  }
  return [r * 255, g * 255, b * 255];
}
function fract(x) { return x - Math.floor(x); }

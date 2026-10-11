// 键盘渲染：keyimg.png 底图 + KB.ini 矩形按键层 + 灯光 Canvas 叠加（screen 混色）
export class KeyboardView {
  constructor(container) {
    this.container = container;
    this.model = null;
    this.keys = [];            // 可渲染按键（有矩形）
    this.onKeyClick = null;    // (i) => {}
    this.onKeyPaint = null;    // (i) => {}   涂色模式拖动
    this.paintMode = false;
    this._painting = false;
    this._selected = null;

    this.el = document.createElement('div');
    this.el.className = 'kb-view';
    this.img = document.createElement('img');
    this.img.className = 'kb-img';
    this.canvas = document.createElement('canvas');
    this.layer = document.createElement('div');
    this.layer.className = 'klayer';
    this.el.append(this.canvas, this.layer, this.img);
    // img 在最上层会挡住 hover —— 顺序调整：img 最底，canvas 居中，交互层最上
    this.el.innerHTML = '';
    this.el.append(this.img, this.canvas, this.layer);
    container.appendChild(this.el);
    // 拖涂结束：全程只挂一次（once 会在首次松开后自毁，导致 _painting 卡 true → 悬停即涂）
    window.addEventListener('mouseup', () => { this._painting = false; });

    this._resize = this._resize.bind(this);
    this._ro = new ResizeObserver(this._resize);
  }

  async setModel(model) {
    this.model = model;
    this.img.src = `assets/models/${model.slug}/keyimg.png`;
    await this.img.decode().catch(() => {});
    const { w, h } = model.img;
    this.el.style.aspectRatio = `${w} / ${h}`;
    this.canvas.width = w; this.canvas.height = h;
    this.layer.innerHTML = '';
    this.keyEls = new Map();
    this.keys = model.keys.filter((k) => k.r[2] > k.r[0] && k.r[3] > k.r[1]);
    for (const k of this.keys) {
      const d = document.createElement('div');
      d.className = 'kkey';
      const [l, t, r, b] = k.r;
      d.style.left = l + 'px'; d.style.top = t + 'px';
      d.style.width = (r - l) + 'px'; d.style.height = (b - t) + 'px';
      d.addEventListener('mousedown', (e) => {
        if (!this.paintMode || e.button !== 0) return; // 仅左键按住涂色
        e.preventDefault();
        this._painting = true;
        this.onKeyPaint?.(k.i);
      });
      d.addEventListener('mouseenter', () => { if (this.paintMode && this._painting) this.onKeyPaint?.(k.i); });
      d.addEventListener('click', () => { if (!this.paintMode) this.onKeyClick?.(k.i); });
      this.layer.appendChild(d);
      this.keyEls.set(k.i, d);
    }
    const stage = this.el.closest('.kb-stage');
    if (stage && this._ro) { this._ro.disconnect(); this._ro.observe(stage); }
    this._resize();
    this.clear();
  }

  _resize() {
    const stage = this.el.closest('.kb-stage');
    if (!stage || !this.model) return;
    const pad = 28;
    const aw = stage.clientWidth - pad, ah = stage.clientHeight - pad;
    const { w, h } = this.model.img;
    const s = Math.max(0.05, Math.min(aw / w, ah / h, 1.6)); // 上限 1.6：keyimg 位图再放大就明显模糊
    const cw = Math.max(120, Math.floor(w * s)), ch = Math.floor(h * s);
    this.el.style.width = cw + 'px';
    this.el.style.height = ch + 'px';
    // 热区层保持底图原始像素坐标系，整体 transform 缩放——键位/角标/点击热区与底图始终对齐
    this.layer.style.width = w + 'px';
    this.layer.style.height = h + 'px';
    this.layer.style.transform = `scale(${s})`;
  }

  setSelected(i) {
    if (this._selected != null) this.keyEls.get(this._selected)?.classList.remove('sel');
    this._selected = i;
    if (i != null) this.keyEls.get(i)?.classList.add('sel');
  }

  setPaintMode(on) {
    this.paintMode = on;
    for (const el of this.keyEls?.values() || []) el.classList.toggle('paint', on);
  }

  // 按键页：fn 层功能角标
  setFnMarks(map) {
    for (const [i, el] of this.keyEls || []) {
      const label = map.get(i);
      if (label) { el.dataset.fn = label; el.classList.add('fnmark'); }
      else { delete el.dataset.fn; el.classList.remove('fnmark'); }
    }
  }

  // colors: Float32Array(3*N)，按 this.keys 顺序；null 全灭
  draw(colors) {
    const ctx = this.canvas.getContext('2d');
    const { width: W, height: H } = this.canvas;
    ctx.clearRect(0, 0, W, H);
    if (!colors) return;
    ctx.globalCompositeOperation = 'screen';
    const s = W / this.model.img.w;
    for (let n = 0; n < this.keys.length; n++) {
      const r = colors[n * 3], g = colors[n * 3 + 1], b = colors[n * 3 + 2];
      if (!r && !g && !b) continue;
      const [l, t, rgt, btm] = this.keys[n].r;
      const x = l * s, y = t * s, w = (rgt - l) * s, h = (btm - t) * s;
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      ctx.shadowColor = ctx.fillStyle;
      ctx.shadowBlur = Math.max(4, 7 * s);
      roundRect(ctx, x + 1, y + 1, Math.max(1, w - 2), Math.max(1, h - 2), 3 * s);
      ctx.globalAlpha = 0.55;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = 'source-over';
  }

  clear() { this.draw(null); }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h);
}

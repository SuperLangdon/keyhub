// 灯光页
import { h, toast } from '../ui.js';
import { t, L, fxName, fxOffName, FX_CUSTOM_UI } from '../i18n.js';
import { state, updateCfg } from '../store.js';
import { device, isOffUi, hasCustomUi, selfDefineFw } from '../device/index.js';
import { iconEl } from '../ui-icons.js';



const SWATCHES = [
  '#ff0000', '#ff7f00', '#ffff00', '#00ff00', '#00ffff', '#0066ff', '#8b00ff', '#ff00ff',
  '#ffffff', '#c0c0c0', '#ff6699', '#3366cc', '#33cc99', '#99cc33', '#cc9933', '#cc3333',
];

export function renderLightPage(root, ctx) {
  const { model } = state;
  const cfg = state.cfg;

  // ---- 灯效列表 ----
  const fxList = h('div', { class: 'fx-list' });
  const rebuildList = () => {
    fxList.innerHTML = '';
    // LedMask 过滤：第 ui-1 位=1 的效果固件未实现（原驱动 UI 同样隐藏，如踏雪无痕），不展示
    const masked = (ui) => ui >= 1 && ui <= 18 && (model.ledMask & (1 << (ui - 1))) !== 0;
    const rows = [...model.ledopts].filter((o) => !masked(o.ui));
    if (!hasCustomUi(model)) rows.splice(rows.findIndex((r) => r.fw === 0), 0, { ui: FX_CUSTOM_UI, fw: selfDefineFw(model), pseudo: true });
    for (const o of rows) {
      const isOff = o.fw === 0 && o.ui !== FX_CUSTOM_UI;
      const name = isOff ? fxOffName() : fxName(o.ui);
      const isSelf = o.ui === FX_CUSTOM_UI;
      // 自定义档位用 ✨ 图标标识；fw 调试编号不再展示（协议细节见调试台）
      const item = h('div', {
        class: 'fx-item' + (cfg.effectUi === o.ui ? ' on' : ''),
        onclick: () => {
          cfg.effectUi = o.ui;
          updateCfg({});
          rebuildList();
          refreshVis();
        },
      }, name, isSelf ? h('span', { class: 'fxfw' }, iconEl('sparkles', 10)) : null);
      fxList.appendChild(item);
    }
  };
  rebuildList();

  // ---- 颜色 ----
  const colorInp = h('input', { type: 'color', value: rgbHex(cfg.color), class: 'color-well' });
  colorInp.addEventListener('input', () => {
    cfg.color = hexRgb(colorInp.value);
    updateCfg({});
    syncSwatches();
  });
  const swBox = h('div', { class: 'swatches' });
  const syncSwatches = () => [...swBox.children].forEach((el) => el.classList.toggle('on', el.dataset.c === rgbHex(cfg.color)));
  for (const c of SWATCHES) {
    swBox.appendChild(h('div', {
      class: 'sw', 'data-c': c, style: `background:${c}`,
      onclick: () => { cfg.color = hexRgb(c); colorInp.value = c; updateCfg({}); syncSwatches(); },
    }));
  }
  // 炫彩 = 颜色区的过滤器：开启后颜色由炫彩随机接管，调色盘（取色器 + 色板）禁用；关闭恢复
  const colorfulChk = h('input', { type: 'checkbox', class: 'switch' });
  colorfulChk.checked = cfg.colorful;
  colorfulChk.addEventListener('change', () => { cfg.colorful = colorfulChk.checked; updateCfg({}); refreshVis(); });

  // ---- 亮度 / 速度 ----
  const mkSlider = (label, key, max = 4) => {
    const val = h('span', { class: 'val', text: String(cfg[key]) });
    const inp = h('input', { type: 'range', min: 0, max, value: cfg[key] });
    inp.addEventListener('input', () => { val.textContent = inp.value; cfg[key] = +inp.value; updateCfg({}); refreshVis(); });
    return h('div', { class: 'slider-row' }, h('label', { text: label }), inp, val);
  };
  const brightRow = mkSlider(L('亮度', 'Brightness'), 'brightness');
  const speedRow = mkSlider(L('速度', 'Speed'), 'speed');

  // ---- 自定义动画 ----

  // ---- 每键 RGB（仅自定义档存在） ----
  const setPaint = (on) => {
    ctx.paintMode = on;
    paintBtn.classList.toggle('primary', on);
    ctx.onPaintMode(on);
  };
  const paintBtn = h('button', { class: 'btn' }, iconEl('paintbrush', 14), L('涂色模式', 'Paint'));
  paintBtn.addEventListener('click', () => setPaint(!ctx.paintMode));
  const clearBtn = h('button', { class: 'btn danger' }, iconEl('eraser', 14), L('清除涂色', 'Clear'));
  clearBtn.addEventListener('click', () => {
    if (!Object.keys(cfg.perKey).length) { toast(L('还没有涂色', 'Nothing painted yet')); return; }
    cfg.perKey = {};
    updateCfg({});
    ctx.onPaintMode(ctx.paintMode); // 刷新
  });

  // ---- 下发 ----
  const applyBtn = h('button', { class: 'btn primary' }, iconEl('send', 14), `${t('tc_apply', L('保存', 'Save'))} & ${L('下发至设备', 'Apply to device')}`);
  applyBtn.addEventListener('click', async () => {
    await device.applyLight(cfg, model);
    toast(isOffUi(model, cfg.effectUi) ? L('已下发（灯光关闭）', 'Sent (lights off)') : L('灯光配置已下发', 'Light config sent to device'));
  });
  const applyPerKeyBtn = h('button', { class: 'btn' }, iconEl('upload', 14), L('下发每键颜色', 'Send per-key'));
  applyPerKeyBtn.addEventListener('click', async () => {
    if (!Object.keys(cfg.perKey).length) { toast(L('请先在涂色模式下给按键上色', 'Paint some keys in paint mode first'), true); return; }
    await device.applyPerKey(cfg.perKey, model, cfg);
    toast(L('每键颜色已下发', 'Per-key colors sent to device'));
  });

  // ---- 布局 ----
  // 三列骨架：灯效列表 ｜ 颜色（炫彩+调色盘，按能力显隐）｜ 调节（滑条+下发，固定宽度防拉长）
  // 自定义档追加第四列「每键 RGB」（颜色列此时无内容随能力隐藏）
  const colorLine = h('div', { class: 'color-line' }, colorInp, swBox);
  const colorfulRow = h('label', { class: 'toggle', style: 'margin-bottom:8px' }, colorfulChk, L('炫彩', 'Colorful'));
  const refreshVis = () => {
    const isSelf = cfg.effectUi === 19;
    const o = model.ledopts.find((x) => x.ui === cfg.effectUi);
    const hasColor = isSelf || !!(o && o.color); // 自定义模式始终给调色盘（涂色取色用它）
    const hasRand = !!(o && o.rand), hasSpeed = !!(o && o.speed);
    colorfulRow.style.display = hasRand ? '' : 'none';
    if (!hasRand && cfg.colorful) { cfg.colorful = false; colorfulChk.checked = false; }
    colorLine.style.display = hasColor ? '' : 'none';
    // 炫彩开启 → 调色盘被接管禁用；关闭 → 恢复（双向联动）
    const taken = hasColor && hasRand && cfg.colorful;
    colorLine.classList.toggle('disabled', taken);
    colorLine.title = taken ? L('炫彩已开启，颜色随机分配；关闭炫彩后可自选颜色', 'Colorful is on — colors are random; turn it off to pick your own') : '';
    speedRow.style.display = hasSpeed ? '' : 'none';
    // 颜色列只在该效果确有颜色/炫彩能力时出现（自定义/关闭档整列隐藏）
    colorCol.classList.toggle('hidden', !(hasColor || hasRand));
    // 每键 RGB 仅自定义档存在；离开自定义档时退出涂色态
    perKeyCol.classList.toggle('hidden', !isSelf);
    if (!isSelf && ctx.paintMode) setPaint(false);
  };

  const perKeyRow = h('div', { style: 'display:flex;gap:8px;margin-top:6px;flex-wrap:wrap' }, paintBtn, clearBtn, applyPerKeyBtn);
  const applyRow = h('div', { class: 'btn-row', style: 'margin-top:12px' }, applyBtn);

  const colorCol = h('div', { class: 'col col-color' },
    h('h3', { text: L('颜色', 'Color') }),
    colorfulRow,
    colorLine,
  );
  const adjustCol = h('div', { class: 'col col-adjust' },
    h('h3', { text: L('调节', 'Adjust') }),
    brightRow,
    speedRow,
    applyRow,
  );
  const perKeyCol = h('div', { class: 'col wide' },
    h('h3', { text: L('每键 RGB · 自定义', 'Per-key RGB · Custom') }),
    perKeyRow,
    h('p', { class: 'dim', style: 'margin-top:10px;line-height:1.8' },
      L('涂色模式下按住左键拖过按键即可连续上色；自定义模式下键盘实时预览涂色效果。',
        'In paint mode, hold the left button and drag across keys to paint continuously; in custom mode the keyboard previews the painting live.'),
      h('br'), L('连接真机后点「下发每键颜色」写入键盘（固件自定义模式）。',
        'With a real device connected, click "Send per-key" to write them to the keyboard (firmware custom mode).'),
    ),
  );

  root.append(h('div', { class: 'page-inner' },
    h('div', { class: 'cols light-cols' },
      h('div', { class: 'col' },
        h('h3', { text: L('灯效', 'Light effect') }),
        fxList,
      ),
      colorCol,
      adjustCol,
      perKeyCol,
    ),
  ));
  syncSwatches();
  refreshVis();

  // 涂色回调
  ctx.setPaintHandler((i) => {
    cfg.perKey[i] = [...cfg.color];
    updateCfg({});
  });
}

export function rgbHex([r, g, b]) {
  return '#' + [r, g, b].map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0')).join('');
}
export function hexRgb(s) {
  return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
}

// 页面卸载时清理涂色回调
export function cleanupLightPage(ctx) {
  ctx.setPaintHandler(null);
  if (ctx.paintMode) { ctx.paintMode = false; ctx.onPaintMode(false); }
}
export { cleanupLightPage as cleanup };

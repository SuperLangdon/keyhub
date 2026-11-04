// 灯光页
import { h } from '../ui.js';
import { t, fxName, FX_CUSTOM_UI } from '../i18n.js';
import { state, updateCfg, ledUiByIndex } from '../store.js';
import { device, isOffUi, hasCustomUi, selfDefineFw } from '../device/index.js';
import { iconEl } from '../ui-icons.js';



const SWATCHES = [
  '#ff0000', '#ff7f00', '#ffff00', '#00ff00', '#00ffff', '#0066ff', '#8b00ff', '#ff00ff',
  '#ffffff', '#c0c0c0', '#ff6699', '#3366cc', '#33cc99', '#99cc33', '#cc9933', '#cc3333',
];

export function renderLightPage(root, ctx) {
  const { model } = state;
  const cfg = state.cfg;

  // ---- 总开关：灯光必须先开启，下方特效设置才可用 ----
  // 「关闭」不再是效果档（原驱动把关闭灯放在效果列表里，升级为总开关），
  // 切换即时写入键盘；效果列表只保留真实特效。
  // 开关卡片固定在特效列顶部（列表上方），紧凑化不与列表抢视觉
  const lightChk = h('input', { type: 'checkbox', class: 'switch lm-switch' });
  const lmSub = h('div', { class: 'lm-sub' });
  // 整张卡片是包裹复选框的 label：点任意处都能拨开关
  const lightBanner = h('label', { class: 'light-master' },
    h('span', { class: 'lm-icon' }, iconEl('lightbulb', 14)),
    h('div', { class: 'lm-text' },
      h('div', { class: 'lm-title', text: t('app.light.keyboardLights') }),
      lmSub,
    ),
    lightChk,
  );
  const syncMaster = () => {
    lightChk.checked = cfg.lightOn !== false;
    lightBanner.classList.toggle('on', lightChk.checked);
    lmSub.textContent = lightChk.checked
      ? t('app.common.on')
      : t('app.light.offState');
  };
  lightChk.addEventListener('change', async () => {
    cfg.lightOn = lightChk.checked;
    // 从旧配置遗留的「关闭档」唤醒：换回默认效果（列表里已无关闭档可选）
    if (cfg.lightOn && isOffUi(model, cfg.effectUi)) cfg.effectUi = ledUiByIndex(model, model.defLedIndex) ?? 1;
    updateCfg({});
    syncMaster();
    refreshVis();
    await device.applyLight(cfg, model); // 开关即时生效：关灯=SW0，开灯=当前特效
    // 不 toast：横幅开关态 + 设置区锁定/解锁 + 键盘灯本体即反馈
  });

  // ---- 灯效列表 ----
  const fxList = h('div', { class: 'fx-list' });
  const rebuildList = () => {
    fxList.innerHTML = '';
    // LedMask 过滤：第 ui-1 位=1 的效果固件未实现（原驱动 UI 同样隐藏，如踏雪无痕），不展示
    const masked = (ui) => ui >= 1 && ui <= 18 && (model.ledMask & (1 << (ui - 1))) !== 0;
    let rows = [...model.ledopts].filter((o) => !masked(o.ui));
    if (!hasCustomUi(model)) rows.splice(rows.findIndex((r) => r.fw === 0), 0, { ui: FX_CUSTOM_UI, fw: selfDefineFw(model), pseudo: true });
    rows = rows.filter((o) => o.fw !== 0); // 关闭已由顶部总开关接管，列表不再提供关闭档
    for (const o of rows) {
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
      }, fxName(o.ui), isSelf ? h('span', { class: 'fxfw' }, iconEl('sparkles', 10)) : null);
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
  const brightRow = mkSlider(t('app.light.brightness'), 'brightness');
  const speedRow = mkSlider(t('app.light.speed'), 'speed');

  // ---- 自定义动画 ----

  // ---- 每键 RGB（仅自定义档存在） ----
  const setPaint = (on) => {
    ctx.paintMode = on;
    paintBtn.classList.toggle('primary', on);
    ctx.onPaintMode(on);
  };
  const paintBtn = h('button', { class: 'btn' }, iconEl('paintbrush', 14), t('app.light.paintMode'));
  paintBtn.addEventListener('click', () => setPaint(!ctx.paintMode));
  const clearBtn = h('button', { class: 'btn danger' }, iconEl('eraser', 14), t('app.light.clearPaint'));
  const applyPerKeyBtn = h('button', { class: 'btn' }, iconEl('upload', 14), t('app.light.writePerKey'));
  // 无涂色时「清除/写入」直接禁用（空态由按钮本身传达，不再 toast 拦截）
  const syncPerKeyBtns = () => {
    const has = Object.keys(cfg.perKey).length > 0;
    clearBtn.disabled = !has;
    applyPerKeyBtn.disabled = !has;
  };
  clearBtn.addEventListener('click', () => {
    cfg.perKey = {};
    updateCfg({});
    ctx.onPaintMode(ctx.paintMode); // 刷新
    syncPerKeyBtns();
  });

  // ---- 下发 ----
  // 术语与宏页/屏幕页统一：凡是把配置发到键盘固件的动作都叫「写入键盘」
  const applyBtn = h('button', { class: 'btn primary' }, iconEl('send', 14), t('app.keys.writeKeyboard'));
  applyBtn.addEventListener('click', async () => {
    // 不 toast 成功：键盘灯本体与预览即时变化即反馈（失败路径见 HID 调试台日志）
    await device.applyLight(cfg, model);
  });
  applyPerKeyBtn.addEventListener('click', async () => {
    await device.applyPerKey(cfg.perKey, model, cfg);
  });

  // ---- 布局 ----
  // 左列：总开关置顶 + 灯效列表（列高随面板固定，列表内部滚动）；
  // 右侧：特效设置面板（颜色/调节按能力显隐，自定义档追加每键 RGB），固定在列表右邻
  const colorLine = h('div', { class: 'color-line' }, colorInp, swBox);
  const colorfulRow = h('label', { class: 'toggle', style: 'margin-bottom:8px' }, colorfulChk, t('app.light.colorful'));
  const refreshVis = () => {
    // 灯光关闭：整页设置区锁定，顺手退出涂色态（涂色控件不可达）
    if (cfg.lightOn === false && ctx.paintMode) setPaint(false);
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
    colorLine.title = taken ? t('app.light.colorfulTip') : '';
    speedRow.style.display = hasSpeed ? '' : 'none';
    // 灯光总开关关闭 → 特效/颜色/调节/每键 RGB 整体锁定（提示在横幅副文案里）
    colsEl.classList.toggle('gated', cfg.lightOn === false);
    // 颜色列只在该效果确有颜色/炫彩能力时出现（自定义/关闭档整列隐藏）
    colorCol.classList.toggle('hidden', !(hasColor || hasRand));
    // 每键 RGB 仅自定义档存在；离开自定义档时退出涂色态
    perKeyCol.classList.toggle('hidden', !isSelf);
    if (!isSelf && ctx.paintMode) setPaint(false);
  };

  const perKeyRow = h('div', { style: 'display:flex;gap:8px;margin-top:6px;flex-wrap:wrap' }, paintBtn, clearBtn, applyPerKeyBtn);
  const applyRow = h('div', { class: 'btn-row', style: 'margin-top:12px' }, applyBtn);

  // 列内不加标题：效果名/色板/滑条自带语义，列间距即分组（「每键 RGB」列同理）
  const colorCol = h('div', { class: 'col col-color' },
    colorfulRow,
    colorLine,
  );
  const adjustCol = h('div', { class: 'col col-adjust' },
    brightRow,
    speedRow,
    applyRow,
  );
  const perKeyCol = h('div', { class: 'col wide' },
    perKeyRow,
    h('p', { class: 'dim', style: 'margin-top:8px' },
      t('app.light.perKeyNote')),
  );

  // 特效设置面板：颜色/调节/每键 RGB 的组合容器，整体固定在灯效列右侧
  const settingsEl = h('div', { class: 'light-settings' },
    colorCol,
    adjustCol,
    perKeyCol,
  );
  const colsEl = h('div', { class: 'cols light-cols' },
    h('div', { class: 'col fx-col' },
      lightBanner,
      fxList,
    ),
    settingsEl,
  );

  // 特效列与设置面板吃面板剩余高度（舞台全页统一）；列表在列内滚动
  root.append(h('div', { class: 'page-inner' }, colsEl));
  syncSwatches();
  syncMaster();
  refreshVis();
  syncPerKeyBtns();

  // 涂色回调
  ctx.setPaintHandler((i) => {
    cfg.perKey[i] = [...cfg.color];
    updateCfg({});
    syncPerKeyBtns();
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

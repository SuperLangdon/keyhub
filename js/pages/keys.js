// 按键页：层切换 + 功能指派
import { h, toast, confirmBox } from '../ui.js';
import { t } from '../i18n.js';
import { state, updateCfg, save } from '../store.js';
import { iconEl } from '../ui-icons.js';
import { device } from '../device/index.js';
import {
  keyboardKeyList, vkName, funcLabel, sameFunc,
  makeKeyFunc, makeConsumerFunc, makeMouseFunc, makeDisabledFunc, makeLedFxFunc, makeLedCtlFunc,
  makeCommonCmdFunc, COMMON_CMDS,
} from '../vk.js';

const MULTIMEDIA = () => [
  [t('tc_PL'), 0xCD], [t('tc_stop'), 0xB7], [t('tc_pre_media'), 0xB6],
  [t('tc_next_media'), 0xB5], [t('tc_vol_up'), 0xE9], [t('tc_vol_dw'), 0xEA],
  [t('tc_mute'), 0xE2], [t('tc_kbmedia_main'), 0x225], [t('tc_kbmedia_explore'), 0x23C],
  [t('tc_kbmedia_cal'), 0x192], [t('tc_kbmedia_favor'), 0x227], [t('tc_kbmedia_mail'), 0x18C],
];
const MOUSE = () => [
  [0x01, t('tc_click')], [0x02, t('tc_menu')], [0x04, t('tc_middle')],
  [0x07, t('tc_forward')], [0x08, t('tc_back')],
  [0x05, t('tc_scrollup')], [0x06, t('tc_scrolldown')],
  [0x09, t('app.keys.doubleClick')],
];
const LEDCTL = () => [
  [t('app.keys.lightToggle'), 'power', 'toggle'], [t('app.keys.brighter'), 'light', 'up'],
  [t('app.keys.darker'), 'light', 'down'], [t('app.keys.faster'), 'speed', 'up'],
  [t('app.keys.slower'), 'speed', 'down'], [t('app.keys.direction'), 'direction', 'toggle'],
];
const MODS = [['Ctrl', 0x01], ['Shift', 0x02], ['Alt', 0x04], ['Win', 0x08]];

export function renderKeysPage(root, ctx) {
  const { model } = state;
  const cfg = state.cfg;
  let layer = 0;
  let selKey = null;
  let tab = 'kb';

  // ---- 层标签 ----（前 4 层沿用原驱动命名：默认按键层/FN1/FN2/Tap，Tap 为轻触层）
  const layerTabs = h('div', { class: 'tabs' });
  const LAYER_TAGS = ['tc_kb5', 'tc_kb6', 'tc_kb7', 'tc_kb8'];
  const layerNames = () => {
    const names = [t('tc_kb5')];
    for (let l = 1; l < model.layerNum; l++) {
      names.push(l < LAYER_TAGS.length ? t(LAYER_TAGS[l]) : 'FN' + l);
    }
    return names;
  };
  const rebuildLayers = () => {
    layerTabs.innerHTML = '';
    layerNames().forEach((nm, i) => {
      layerTabs.appendChild(h('button', {
        class: 'tab' + (layer === i ? ' on' : ''),
        type: 'button',
        text: nm,
        onclick: () => { layer = i; rebuildLayers(); refreshAll(); },
      }));
    });
  };

  // ---- 功能网格 ----
  const grid = h('div', { class: 'assign-grid' });
  const rebuildGrid = () => {
    grid.innerHTML = '';
    const cur = cfg.layers[layer]?.[selKey];
    const add = (label, fn, isOn = null) => {
      grid.appendChild(h('div', {
        class: 'assign-key' + ((isOn ?? (cur && sameFunc(cur, fn))) ? ' on' : ''),
        text: label,
        onclick: () => assign(fn),
      }));
    };
    if (tab === 'kb') {
      for (const vk of keyboardKeyList()) add(vkName(vk), makeKeyFunc(vk));
    } else if (tab === 'ms') {
      for (const [b, nm] of MOUSE()) add(nm, makeMouseFunc(b));
      grid.appendChild(h('div', {
        class: 'dim', style: 'grid-column:1/-1;line-height:1.6',
        title: t('app.keys.mouseFullNote'),
        text: t('app.keys.mouseShortNote'),
      }));
    } else if (tab === 'cmd') {
      // 常用命令（原驱动同款 9 项 + 设置组 3 项；code↔标签映射逆向自驱动网格构建序列）
      for (const c of COMMON_CMDS) add(t(c.tag), makeCommonCmdFunc(c.code));
      grid.appendChild(h('div', { class: 'dim', style: 'grid-column:1/-1;line-height:1.6',
        text: t('app.keys.cmdNote') }));
    } else if (tab === 'mm') {
      for (const [nm, u] of MULTIMEDIA()) add(nm, makeConsumerFunc(u));
    } else if (tab === 'led') {
      for (const [nm, w, d] of LEDCTL()) add(nm, makeLedCtlFunc(w, d));
      for (const o of model.ledopts) {
        if (o.fw === 0) continue;
        add(t('app.keys.fxFmt', { name: shortFx(o.ui) }), makeLedFxFunc(o.fw));
      }
    } else if (tab === 'macro') {
      if (!state.macros.length) grid.appendChild(h('div', { class: 'dim', text: t('app.keys.noMacroYet') }));
      // 循环模式/重复次数随指派写入键位 dword（逆向自原驱动：byte1=循环码 byte2=重复数）
      const loopSel = h('select', { class: 'sel' });
      for (const [nm, code] of [[t('tc_macro_msg17'), 1], [t('tc_macro_msg18'), 2], [t('tc_macro_msg19'), 4]])
        loopSel.append(h('option', { value: code, text: nm }));
      loopSel.value = '1';
      const repInp = h('input', { class: 'inp', type: 'number', min: 1, max: 255, value: 1, style: 'width:48px' });
      grid.appendChild(h('div', { style: 'display:flex;gap:6px;align-items:center;margin-bottom:6px;grid-column:1/-1' },
        h('span', { class: 'dim', text: t('app.common.loop') }), loopSel,
        h('span', { class: 'dim', text: t('app.common.repeat') }), repInp));
      state.macros.forEach((m, i) => {
        grid.appendChild(h('div', {
          class: 'assign-key' + ((cur && cur.type === 0x0A && cur.param === (m.id ?? i)) ? ' on' : ''),
          text: t('app.keys.macroAssign', { name: m.name }),
          // 点击时读取当前循环/重复设置（而非建格时的快照）
          onclick: () => assign({
            type: 0x0A, code: 0x01, param: m.id ?? i,
            loopCode: +loopSel.value, rep: Math.max(1, Math.min(255, +repInp.value || 1)),
          }),
        }));
      });
    } else if (tab === 'combo') {
      buildComboTab();
    }
    add(t('tc_key_off'), makeDisabledFunc());
  };

  // 组合键构造器
  let comboMods = 0, comboVk = null;
  function buildComboTab() {
    const cur = cfg.layers[layer]?.[selKey];
    // grid-column:1/-1 —— 否则整行被塞进 74px 网格单元里溢出错位
    const mkRow = h('div', { style: 'display:flex;gap:8px;align-items:center;margin-bottom:8px;grid-column:1/-1' });
    comboMods = 0; comboVk = cur && cur.type === 0x02 && cur.param ? cur.code : null;
    for (const [nm, bit] of MODS) {
      const cb = h('input', { type: 'checkbox' });
      if (cur && cur.type === 0x02 && (cur.param >> 8) & bit) { cb.checked = true; comboMods |= bit; }
      cb.addEventListener('change', () => { cb.checked ? (comboMods |= bit) : (comboMods &= ~bit); });
      mkRow.append(h('label', { class: 'toggle' }, cb, nm));
    }
    const sel = h('select', { class: 'sel' });
    sel.append(h('option', { value: '', text: t('app.keys.pickKey') }));
    for (const vk of keyboardKeyList()) sel.append(h('option', { value: vk, text: vkName(vk) }));
    if (comboVk != null) sel.value = comboVk;
    const comboBtn = h('button', {
      class: 'btn primary', text: t('app.keys.assignCombo'),
      disabled: comboVk == null, // 空态由按钮本身传达，不再 toast 拦截
      onclick: () => assign({ type: 0x02, code: comboVk, param: comboMods << 8 }),
    });
    sel.addEventListener('change', () => { comboVk = sel.value === '' ? null : +sel.value; comboBtn.disabled = comboVk == null; });
    mkRow.append(sel, comboBtn);
    grid.appendChild(mkRow);
  }

  function assign(fn) {
    if (selKey == null) { toast(t('tc_kb2'), true); return; }
    if (!cfg.layers[layer]) cfg.layers[layer] = {};
    cfg.layers[layer][selKey] = fn;
    updateCfg({});
    rebuildGrid();
    refreshMarks();
    refreshInfo(); // 信息行/网格高亮/键盘角标同步更新，即反馈
  }

  // ---- 选中键信息 + 操作 ----
  const info = h('div', { class: 'dim' });
  const resetKeyBtn = h('button', { class: 'btn', onclick: () => {
    if (selKey == null) return;
    delete cfg.layers[layer][selKey];
    if (layer === 0) for (const k of model.keys) if (k.i === selKey && k.fn) cfg.layers[0][selKey] = { ...k.fn };
    if (layer === 1 && model.fn1?.[selKey]) cfg.layers[1][selKey] = { ...model.fn1[selKey] };
    updateCfg({});
    rebuildGrid(); refreshMarks();
  } }, iconEl('rotate-ccw', 13), t('app.keys.resetKey'));

  const resetAllBtn = h('button', { class: 'btn danger', onclick: async () => {
    if (!(await confirmBox(t('app.keys.resetDefaults'), t('app.keys.resetLayerConfirm')))) return;
    const def = {};
    if (layer === 0) for (const k of model.keys) if (k.fn) def[k.i] = { ...k.fn };
    if (layer === 1) for (const [i, f] of Object.entries(model.fn1 ?? {})) def[i] = { ...f };
    cfg.layers[layer] = def;
    updateCfg({});
    rebuildGrid(); refreshMarks();
  } }, iconEl('rotate-ccw', 13), t('tc_restore'));

  // ---- Tap 灵敏度已移至「设置」页（与休眠/去抖同组）----
  // ---- 功能分类标签 ----（顺序：键盘 鼠标 多媒体 宏 常用命令 组合键；灯光指派不在清单内，暂留末位）
  const tabs = h('div', { class: 'tabs' });
  const TABS = [
    ['kb', t('tc_msg29')], ['ms', t('tc_msg30')], ['mm', t('tc_msg31')],
    ['macro', t('tc_mac_def')], ['cmd', t('tc_msg28')], ['combo', t('tc_msg32')],
    ['led', t('app.nav.lighting')],
  ];
  const rebuildTabs = () => {
    tabs.innerHTML = '';
    for (const [id, nm] of TABS) {
      tabs.appendChild(h('button', { class: 'tab' + (tab === id ? ' on' : ''), type: 'button', text: nm, onclick: () => { tab = id; rebuildTabs(); rebuildGrid(); } }));
    }
  };

  function shortFx(ui) {
    return t('tc_kb_led' + ui);
  }
  function keyCaption(i) {
    return 'K' + i;
  }

  // ---- 键盘交互 & 角标 ----
  // 写入按钮空态：全部层均无指派（含出厂默认）时禁用——no-channel/失败 toast 仍保留，
  // nothing 分支不再 toast（型号带出厂 fn 时 layers 恒非空，实际不可达；空型号由禁用态表达）
  const hasAssignments = () => Object.values(cfg.layers ?? {}).some((l) => l && Object.keys(l).length);
  function refreshMarks() {
    writeBtn.disabled = !hasAssignments(); // 随指派增删/恢复默认同步
    const map = new Map();
    const cur = cfg.layers[layer] || {};
    for (const [id, fn] of Object.entries(cur)) {
      const lbl = funcLabel(fn);
      if (lbl) map.set(+id, lbl);
    }
    ctx.view.setFnMarks(map);
  }
  function refreshAll() {
    refreshMarks();
    rebuildGrid();
    refreshInfo();
  }
  function refreshInfo() {
    if (selKey == null) { info.textContent = t('app.keys.clickKeyHint'); return; }
    const fn = cfg.layers[layer]?.[selKey];
    info.textContent = `K${selKey} · ${layerNames()[layer]}: ${fn ? funcLabel(fn) : (layer === 0 ? t('app.keys.default') : t('app.keys.inherit'))}`;
  }

  ctx.onKeyClick = (i) => {
    selKey = i;
    ctx.view.setSelected(i);
    refreshInfo();
    rebuildGrid();
  };

  // 导出改键（JSON 下载）
  const exportBtn = h('button', { class: 'btn', onclick: () => {
    const blob = JSON.stringify(cfg.layers, null, 1);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([blob], { type: 'application/json' }));
    a.download = `${model.short}-keys.json`;
    a.click();
    save();
  } }, iconEl('download', 13), t('app.keys.exportKeys'));

  // 写入键盘：只写键位指派、不重发宏内容（device.applyMacros keysOnly）——与「宏」页
  // 的写入是同一份配置的不同子集，两条通道的键位读改写与宏内容相互独立
  const writeBtn = h('button', { class: 'btn primary', disabled: !hasAssignments(), onclick: async () => {
    writeBtn.disabled = true;
    try {
      const r = await device.applyMacros({ keysOnly: true });
      // 写入结果在键盘上不可见，保留成功/失败 toast（同宏页）
      if (r?.sent) toast(t('app.keys.writeOk', { n: r.assigned ?? 0 }));
      else if (r?.error === 'no-channel') toast(t('app.keys.writeNoChannel'), true);
      else if (!r?.sim) toast(t('app.keys.writeFailed'), true);
    } finally { writeBtn.disabled = !hasAssignments(); }
  } }, iconEl('send', 13), t('app.keys.writeKeyboard'));

  // 单列流：层标签（导航已表明页义，不再重复标题）+ 操作 → 分类标签行（右侧当前选择）→ 全宽网格 → 合并说明
  root.append(h('div', { class: 'page-inner' },
    h('div', { class: 'keys-head' },
      layerTabs,
      h('span', { style: 'flex:1' }),
      resetKeyBtn, resetAllBtn, exportBtn, writeBtn,
    ),
    h('div', { class: 'keys-sub' },
      tabs,
      info,
    ),
    grid,
    h('p', { class: 'dim keys-note',
      title: t('app.keys.badgeTip'),
      text: t('app.keys.pageNote') }),
  ));
  rebuildLayers();
  rebuildTabs();
  rebuildGrid();
  refreshInfo();
}

export function cleanupKeysPage(ctx) {
  ctx.onKeyClick = null;
  ctx.view.setFnMarks(new Map());
}
export { cleanupKeysPage as cleanup };

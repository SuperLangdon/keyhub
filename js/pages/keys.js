// 按键页：层切换 + 功能指派
import { h, toast, confirmBox } from '../ui.js';
import { t, L } from '../i18n.js';
import { state, updateCfg, save } from '../store.js';
import { iconEl } from '../ui-icons.js';
import {
  keyboardKeyList, vkName, funcLabel, sameFunc,
  makeKeyFunc, makeConsumerFunc, makeMouseFunc, makeDisabledFunc, makeLedFxFunc, makeLedCtlFunc,
  makeCommonCmdFunc, COMMON_CMDS,
} from '../vk.js';

const MULTIMEDIA = () => [
  [t('tc_PL', '播放/暂停'), 0xCD], [t('tc_stop', '停止'), 0xB7], [t('tc_pre_media', '上一曲'), 0xB6],
  [t('tc_next_media', '下一曲'), 0xB5], [t('tc_vol_up', '音量+'), 0xE9], [t('tc_vol_dw', '音量-'), 0xEA],
  [t('tc_mute', '静音'), 0xE2], [t('tc_kbmedia_main', '主页'), 0x225], [t('tc_kbmedia_explore', '我的电脑'), 0x23C],
  [t('tc_kbmedia_cal', '计算器'), 0x192], [t('tc_kbmedia_favor', '收藏'), 0x227], [t('tc_kbmedia_mail', '邮件'), 0x18C],
];
const MOUSE = () => [
  [0x01, t('tc_click', '左键')], [0x02, t('tc_menu', '右键')], [0x04, t('tc_middle', '中键')],
  [0x07, t('tc_forward', '前进')], [0x08, t('tc_back', '后退')],
  [0x05, t('tc_scrollup', '上滚')], [0x06, t('tc_scrolldown', '下滚')],
  [0x09, L('双击', 'Double click')],
];
const LEDCTL = () => [
  [L('灯光开/关', 'Light on/off'), 'power', 'toggle'], [L('亮度+', 'Brighter'), 'light', 'up'],
  [L('亮度-', 'Darker'), 'light', 'down'], [L('速度+', 'Faster'), 'speed', 'up'],
  [L('速度-', 'Slower'), 'speed', 'down'], [L('方向切换', 'Direction'), 'direction', 'toggle'],
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
    const names = [t('tc_kb5', '默认')];
    for (let l = 1; l < model.layerNum; l++) {
      names.push(l < LAYER_TAGS.length ? t(LAYER_TAGS[l], 'FN' + l) : 'FN' + l);
    }
    return names;
  };
  const rebuildLayers = () => {
    layerTabs.innerHTML = '';
    layerNames().forEach((nm, i) => {
      layerTabs.appendChild(h('div', {
        class: 'tab' + (layer === i ? ' on' : ''),
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
    } else if (tab === 'cmd') {
      // 常用命令（原驱动同款 9 项 + 设置组 3 项；code↔标签映射逆向自驱动网格构建序列）
      for (const c of COMMON_CMDS) add(t(c.tag, L('命令 ', 'Cmd ') + c.code.toString(16)), makeCommonCmdFunc(c.code));
      grid.appendChild(h('div', { class: 'dim', style: 'grid-column:1/-1;line-height:1.6' },
        L('锁Win键/锁键盘可随「宏」页写入真机（固件键位编码）；复位键盘在原驱动是全局操作（无固件键位编码），仅保存于浏览器配置。',
          'Win-lock/KB-lock are writable to the device (firmware keycodes); Reset is a host-side action in the original driver (no firmware keycode) and stays local.')));
    } else if (tab === 'mm') {
      for (const [nm, u] of MULTIMEDIA()) add(nm, makeConsumerFunc(u));
    } else if (tab === 'led') {
      for (const [nm, w, d] of LEDCTL()) add(nm, makeLedCtlFunc(w, d));
      for (const o of model.ledopts) {
        if (o.fw === 0) continue;
        add(L('灯效 ', 'FX ') + shortFx(o.ui), makeLedFxFunc(o.fw));
      }
    } else if (tab === 'macro') {
      if (!state.macros.length) grid.appendChild(h('div', { class: 'dim', text: L('还没有宏，请先到「宏」页创建', 'No macros yet — create one on the Macros page') }));
      // 循环模式/重复次数随指派写入键位 dword（逆向自原驱动：byte1=循环码 byte2=重复数）
      const loopSel = h('select', { class: 'sel' });
      for (const [nm, code] of [[t('tc_macro_msg17', '执行次数'), 1], [t('tc_macro_msg18', '循环直到按键松开'), 2], [t('tc_macro_msg19', '循环直到任意键按下'), 4]])
        loopSel.append(h('option', { value: code, text: nm }));
      loopSel.value = '1';
      const repInp = h('input', { class: 'inp', type: 'number', min: 1, max: 255, value: 1, style: 'width:48px' });
      grid.appendChild(h('div', { style: 'display:flex;gap:6px;align-items:center;margin-bottom:6px;grid-column:1/-1' },
        h('span', { class: 'dim', text: L('循环', 'Loop') }), loopSel,
        h('span', { class: 'dim', text: L('次数', 'Repeat') }), repInp));
      state.macros.forEach((m, i) => {
        grid.appendChild(h('div', {
          class: 'assign-key' + ((cur && cur.type === 0x0A && cur.param === (m.id ?? i)) ? ' on' : ''),
          text: L('宏: ', 'Macro: ') + m.name,
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
    add(t('tc_key_off', L('无功能', 'Disable')), makeDisabledFunc());
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
    sel.append(h('option', { value: '', text: L('选择按键…', 'Pick a key…') }));
    for (const vk of keyboardKeyList()) sel.append(h('option', { value: vk, text: vkName(vk) }));
    if (comboVk != null) sel.value = comboVk;
    sel.addEventListener('change', () => { comboVk = sel.value === '' ? null : +sel.value; });
    mkRow.append(sel, h('button', {
      class: 'btn primary', text: L('指派组合键', 'Assign combo'),
      onclick: () => {
        if (comboVk == null) { toast(L('请先选择一个按键', 'Please select a key'), true); return; }
        assign({ type: 0x02, code: comboVk, param: comboMods << 8 });
      },
    }));
    grid.appendChild(mkRow);
  }

  function assign(fn) {
    if (selKey == null) { toast(t('tc_kb2', L('请先选择按键', 'Select a key first')), true); return; }
    if (!cfg.layers[layer]) cfg.layers[layer] = {};
    cfg.layers[layer][selKey] = fn;
    updateCfg({});
    rebuildGrid();
    refreshMarks();
    toast(L(`已指派 ${keyCaption(selKey)} → ${funcLabel(fn, t)}`, `Assigned ${keyCaption(selKey)} → ${funcLabel(fn, t)}`));
  }

  // ---- 选中键信息 + 操作 ----
  const info = h('div', { class: 'dim' });
  const resetKeyBtn = h('button', { class: 'btn', onclick: () => {
    if (selKey == null) return;
    delete cfg.layers[layer][selKey];
    if (layer === 0) for (const k of model.keys) if (k.i === selKey && k.fn) cfg.layers[0][selKey] = { ...k.fn };
    if (layer === 1 && model.fn1[selKey]) cfg.layers[1][selKey] = { ...model.fn1[selKey] };
    updateCfg({});
    rebuildGrid(); refreshMarks();
  } }, iconEl('rotate-ccw', 13), L('恢复此键', 'Reset this key'));

  const resetAllBtn = h('button', { class: 'btn danger', onclick: async () => {
    if (!(await confirmBox(L('恢复默认', 'Reset to defaults'), L('将当前层所有按键恢复为驱动默认值？', 'Restore every key on this layer to the driver defaults?')))) return;
    const def = {};
    if (layer === 0) for (const k of model.keys) if (k.fn) def[k.i] = { ...k.fn };
    if (layer === 1) for (const [i, f] of Object.entries(model.fn1)) def[i] = { ...f };
    cfg.layers[layer] = def;
    updateCfg({});
    rebuildGrid(); refreshMarks();
  } }, iconEl('rotate-ccw', 13), t('tc_restore', '恢复默认'));

  // ---- Tap 灵敏度已移至「设置」页（与休眠/去抖同组）----
  // ---- 功能分类标签 ----（顺序：键盘 鼠标 多媒体 宏 常用命令 组合键；灯光指派不在清单内，暂留末位）
  const tabs = h('div', { class: 'tabs' });
  const TABS = [
    ['kb', t('tc_msg29', '键盘')], ['ms', t('tc_msg30', '鼠标')], ['mm', t('tc_msg31', '多媒体')],
    ['macro', t('tc_mac_def', '宏')], ['cmd', t('tc_msg28', '常用命令')], ['combo', t('tc_msg32', '组合键')],
    ['led', L('灯光', 'Lighting')],
  ];
  const rebuildTabs = () => {
    tabs.innerHTML = '';
    for (const [id, nm] of TABS) {
      tabs.appendChild(h('div', { class: 'tab' + (tab === id ? ' on' : ''), text: nm, onclick: () => { tab = id; rebuildTabs(); rebuildGrid(); } }));
    }
  };

  function shortFx(ui) {
    return t('tc_kb_led' + ui, String(ui));
  }
  function keyCaption(i) {
    const k = model.keys.find((x) => x.i === i);
    return k ? `K${i}` : `K${i}`;
  }

  // ---- 键盘交互 & 角标 ----
  function refreshMarks() {
    const map = new Map();
    const cur = cfg.layers[layer] || {};
    for (const [id, fn] of Object.entries(cur)) {
      const lbl = funcLabel(fn, t);
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
    if (selKey == null) { info.textContent = L('点击键盘上的按键查看/修改功能（当前层：', 'Click a key to view/edit its function (layer: ') + layerNames()[layer] + L('）', ')'); return; }
    const fn = cfg.layers[layer]?.[selKey];
    info.textContent = `K${selKey} · ${layerNames()[layer]}: ${fn ? funcLabel(fn, t) : (layer === 0 ? L('默认', 'Default') : L('继承默认', 'Inherit'))}`;
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
  } }, iconEl('download', 13), L('导出改键', 'Export keys'));

  // 单列流：标题行（层标签 + 操作）→ 分类标签行（右侧当前选择）→ 全宽网格 → 合并说明
  root.append(h('div', { class: 'page-inner' },
    h('div', { class: 'keys-head' },
      h('h3', { text: L('按键指派', 'Key assignment') }),
      layerTabs,
      h('span', { style: 'flex:1' }),
      resetKeyBtn, resetAllBtn, exportBtn,
    ),
    h('div', { class: 'keys-sub' },
      tabs,
      info,
    ),
    grid,
    h('p', { class: 'dim keys-note',
      text: L('FN 层功能在键盘上以蓝色角标显示；宏与常用命令指派随「宏」页的「写入键盘」一并下发（读改写当前层键位表）。',
        'FN-layer functions show as blue badges; macro & common-command assignments are written via the Macro page\'s "Write to keyboard" (read-modify-write).') }),
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

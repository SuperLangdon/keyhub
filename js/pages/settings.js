// 设置页：设备信息 / 语言 / 睡眠 / 按键去抖 / 配置档 / 恢复
import { h, toast, confirmBox, download } from '../ui.js';
import { iconEl } from '../ui-icons.js';
import { t, L } from '../i18n.js';
import { state, updateCfg, save, exportAll, importAll } from '../store.js';
import { device } from '../device/index.js';
import { SLEEP_LEVELS, sleepIndexOf } from '../device/protocol.js';

export function renderSettingsPage(root, ctx) {
  const { model, cfg } = state;

  const connLabel = () => (device.mode === 'hid' ? L('已连接（WebHID）', 'Connected (WebHID)') : L('演示模式', 'Demo mode'));

  // 连接通道：按主接口 VID/PID 判别（device.channelOf）
  const ch = device.channelOf(device.dev);
  const chLabel = ch === 'wireless' ? L('2.4G 无线', '2.4G wireless')
    : ch === 'wired' ? L('有线（USB）', 'Wired (USB)') : '—';

  // 固件版本（USB bcdDevice，经 WebUSB 读取；首次需在 WebUSB 弹窗授权，之后进页静默回填）
  const fwVal = h('span', { class: 'v-mono', text: L('未查询', 'Not queried') });
  const fwBtn = h('button', { class: 'btn', onclick: async () => {
    fwBtn.disabled = true;
    fwVal.textContent = L('查询中…', 'Querying…');
    const text = await device.readFwVersion();
    fwBtn.disabled = false;
    fwVal.textContent = text ?? L('查询失败（详见调试台）', 'Failed (see debug panel)');
    if (!text) toast(L('固件版本查询失败', 'Firmware version query failed'), true);
  } }, iconEl('search', 12), L('查询', 'Query'));
  device.readFwVersion(false).then((text) => { if (text) fwVal.textContent = text; }).catch(() => { /* 静默 */ });

  // 设备信息
  const info = h('div', { class: 'set-card' },
    cardHead('keyboard', L('设备信息', 'Device info')),
    kv(L('设备型号', 'Model'), model.name),
    h('div', { class: 'kv' },
      h('span', { class: 'k', text: L('固件版本', 'Firmware version') }),
      h('span', { style: 'display:inline-flex;align-items:center;gap:6px' }, fwVal, fwBtn)),
    kv('VID:PID', `${hx(model.vid)}:${hx(model.pid)}` + (model.vidW ? ` / ${hx(model.vidW)}:${hx(model.pidW)} (2.4G)` : ''), true),
    kv('Keys / Layers', `${model.keys.length} / ${model.layerNum}`, true),
    kvConn(L('连接', 'Connection'), connLabel(), device.mode === 'hid'),
    kvConn(L('通道', 'Channel'), chLabel, !!ch),
  );

  // 设备参数：离散挡位一律用滑块（拖动即时显示挡位值，「下发」按钮触发写入）
  const mkLevel = (label, levels, idx0, fmt, apply) => {
    const idx = Math.max(0, Math.min(levels.length - 1, idx0));
    const val = h('span', { class: 'val', text: fmt(levels[idx]) });
    const inp = h('input', { type: 'range', min: 0, max: levels.length - 1, step: 1, value: idx,
      oninput: () => { val.textContent = fmt(levels[+inp.value]); } });
    const btn = h('button', { class: 'btn', onclick: () => apply(levels[+inp.value]) },
      L('下发', 'Apply'), iconEl('send', 12));
    return h('div', { class: 'slider-row' }, h('label', { text: label }), inp, val, btn);
  };
  const sleepText = (m) => (m === 0 ? L('关闭', 'Off') : m + ' ' + t('tc_msg37', '分钟'));

  const sleepRow = mkLevel(t('tc_msg49', '休眠'), SLEEP_LEVELS,
    sleepIndexOf(cfg.sleep ?? model.sleepTime ?? 0), sleepText,
    (v) => { cfg.sleep = v; updateCfg({}); device.applySleep(v); toast(t('tc_msg49', '休眠') + L('时间已下发', ' time applied')); });
  const dbRow = mkLevel(t('tc_msg54', '按键去抖'), [1, 2, 3, 4, 5], (cfg.debounce ?? 2) - 1,
    (l) => l + ' ' + t('tc_msg55', '档'),
    (v) => { cfg.debounce = v; updateCfg({}); device.applyDebounce(v); toast(t('tc_msg54', '按键去抖') + L('已下发', ' applied')); });
  const tsRow = mkLevel('Tap ' + t('tc_kb12', '灵敏度'), [1, 2, 3, 4, 5, 6, 7, 8], (cfg.tapSens ?? 4) - 1,
    (l) => l + ' ' + t('tc_msg55', '档'),
    (v) => { cfg.tapSens = v; updateCfg({}); device.applyTapSens(v); toast('Tap ' + t('tc_kb12', '灵敏度') + L('已下发', ' applied')); });

  const devSet = h('div', { class: 'set-card' },
    cardHead('settings', L('设备设置', 'Device settings')),
    sleepRow, dbRow, tsRow,
    h('p', { class: 'dim', style: 'margin-top:8px', text: t('tc_msg34', '在无线模式下，设备空闲指定的时间后会自动进入休眠状态') }),
  );

  // 配置档
  const exportBtn = h('button', { class: 'btn', onclick: () => {
    download(`leobog-web-config-${new Date().toISOString().slice(0, 10)}.json`, exportAll());
  } }, iconEl('download', 13), L('导出', 'Export'));
  const importInp = h('input', { type: 'file', accept: '.json', style: 'display:none' });
  importInp.addEventListener('change', async () => {
    const f = importInp.files[0];
    if (!f) return;
    try {
      importAll(await f.text());
      toast(L('配置已导入，返回型号页重新进入生效', 'Profile imported — leave to the model page and re-enter to take effect'));
    } catch (e) {
      toast(L('导入失败: ', 'Import failed: ') + e.message, true);
    }
    importInp.value = '';
  });
  const importBtn = h('button', { class: 'btn', onclick: () => importInp.click() }, iconEl('upload', 13), L('导入', 'Import'));
  const resetBtn = h('button', { class: 'btn danger', onclick: async () => {
    if (!(await confirmBox(L('恢复出厂', 'Factory reset'), L('将当前型号配置恢复为驱动默认值？', 'Restore this model\'s profile to the driver defaults?')))) return;
    const { defaultCfg, loadCfgFor } = await import('../store.js');
    loadCfgFor(state.slug, state.model); // 重新生成默认配置
    toast(L('已恢复默认（当前页重新进入生效）', 'Defaults restored (re-enter this page to take effect)'));
  } }, iconEl('rotate-ccw', 13), L('恢复出厂设置', 'Factory reset'));
  const profiles = h('div', { class: 'set-card' },
    cardHead('download', L('配置档', 'Profiles')),
    h('p', { class: 'dim', style: 'margin-bottom:6px', text: L('配置保存在浏览器 localStorage，可导出 JSON 备份或分享', 'Profiles are stored in browser localStorage; export as JSON to back up or share.') }),
    h('div', { class: 'btn-row' }, exportBtn, importBtn, resetBtn), importInp,
  );

  root.append(h('div', { class: 'page-inner' },
    h('div', { class: 'set-grid' }, info, devSet, profiles),
  ));
}

function cardHead(icon, text) {
  return h('h4', {}, iconEl(icon, 13), text);
}
function kv(k, v, mono = false) {
  return h('div', { class: 'kv' }, h('span', { class: 'k', text: k }),
    h('span', mono ? { class: 'v-mono', text: String(v) } : { text: String(v) }));
}
// 连接状态：带状态点的药丸（绿点=真机已连接，灰点=演示模式）
function kvConn(k, label, ok) {
  return h('div', { class: 'kv' }, h('span', { class: 'k', text: k }),
    h('span', { class: 'kv-pill' + (ok ? ' ok' : ''), text: label }));
}
function hx(v) { return (v ?? 0).toString(16).padStart(4, '0'); }

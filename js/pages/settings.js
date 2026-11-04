// 设置页：设备信息 / 语言 / 睡眠 / 按键去抖 / 配置档 / 恢复
import { h, toast, confirmBox, download } from '../ui.js';
import { iconEl } from '../ui-icons.js';
import { t } from '../i18n.js';
import { state, updateCfg, save, exportAll, importAll } from '../store.js';
import { device } from '../device/index.js';
import { modelSleepTable, sleepUiIndexOf, cfgGenOf } from '../device/protocol.js';

export function renderSettingsPage(root, ctx) {
  const { model, cfg } = state;

  // 连接通道：按主接口 VID/PID 判别（device.channelOf）
  const ch = device.channelOf(device.dev);
  const chLabel = ch === 'wireless' ? t('app.common.wireless')
    : ch === 'wired' ? t('app.settings.wiredUsb') : '—';

  // 固件版本（USB bcdDevice，经 WebUSB 读取）：连接设备时会顺手取得 WebUSB 授权
  // （device.ensureFwGrant），正常流程进页即静默回填、无任何交互。仅当授权缺失时
  // （旧会话静默重连、或连接时取消了授权弹窗）才显示可点的「未查询」兜底——点一下
  // 弹一次授权窗（授权按源持久），此后同样全自动，不再有常驻按钮。
  const fwSlot = h('span', { class: 'v-mono' });
  const fwQuery = async () => {
    fwSlot.textContent = t('app.settings.querying');
    const text = await device.readFwVersion();
    if (text) fwSlot.textContent = text;
    else {
      fwSlot.replaceChildren(fwLazy); // 回到可重试态（失败详情见 toast 与调试台）
      toast(t('app.settings.fwFail'), true);
    }
  };
  const fwLazy = h('button', { class: 'fw-lazy', type: 'button', onclick: fwQuery,
    title: t('app.settings.fwLazyTip') },
    t('app.settings.notQueried'));
  if (device.fwVersion) fwSlot.textContent = device.fwVersion;
  else {
    fwSlot.append(fwLazy);
    device.readFwVersion(false).then((text) => { if (text) fwSlot.textContent = text; }).catch(() => { /* 静默 */ });
  }

  // 电量：LEOBOG/fw24 三模/双模型号走 0x13 cmd 0x4A（仅 2.4G 应答）；K65/fw26 走屏幕控制器
  // 寄存器（feature report 10/5，电压×25mV + 充电位——2026-10-27 真机定位；此版 Chrome
  // 整设备授权下不可达，失败时栏内显示「不支持」，交互范式与固件版本一致：静默预查 +
  // 失败可点重试，不用 toast）
  const batVal = h('span', { class: 'v-mono' });
  const batQuery = async () => {
    batVal.textContent = t('app.settings.querying');
    const r = await device.readBattery();
    if (r) batVal.textContent = batText(r);
    else batVal.replaceChildren(batLazy); // 回到可重试态（失败详情见调试台）
  };
  const batLazy = h('button', { class: 'fw-lazy', type: 'button', onclick: batQuery,
    title: t('app.settings.battTip') }, t('app.settings.notSupported'));
  const batText = (r) => {
    const extra = r.voltage != null ? `（${r.voltage.toFixed(2)}V${r.charging ? ' ' + t('app.settings.charging') : ''}）` : '';
    return `${r.percent}%${extra}`;
  };
  if (device.batteryResult) batVal.textContent = batText(device.batteryResult);
  else {
    batVal.append(batLazy);
    device.readBattery().then((r) => {
      if (!r) return; // 保持可点「不支持」；无读数（K65 在此浏览器下）不再反复自动查
      batVal.textContent = batText(r);
    }).catch(() => { /* 保持可点 */ });
  }
  const showBattery = (model.channelMask & 2) !== 0; // 三模/双模型号才有电池（fw26 K65 走寄存器通道）

  // 设备信息
  const info = h('div', { class: 'set-card' },
    cardHead('keyboard', t('app.settings.deviceInfo')),
    kv(t('app.settings.model'), model.name),
    h('div', { class: 'kv' },
      h('span', { class: 'k', text: t('app.settings.fwVersion') }),
      fwSlot),
    ...(showBattery ? [h('div', { class: 'kv' },
      h('span', { class: 'k', text: t('tc_msg5') }),
      batVal)] : []),
    kv('VID:PID', `${hx(model.vid)}:${hx(model.pid)}` + (model.vidW ? ` / ${hx(model.vidW)}:${hx(model.pidW)} (2.4G)` : ''), true),
    kv(t('app.settings.keysLayers'), `${model.keys.length} / ${model.layerNum}`, true),
    kvConn(t('app.settings.channel'), chLabel, !!ch),
  );

  // 设备参数：离散挡位一律用滑块（拖动即时显示挡位值，「写入」按钮触发写入）
  const mkLevel = (label, levels, idx0, fmt, apply) => {
    const idx = Math.max(0, Math.min(levels.length - 1, idx0));
    const val = h('span', { class: 'val', text: fmt(levels[idx]) });
    const inp = h('input', { type: 'range', min: 0, max: levels.length - 1, step: 1, value: idx,
      oninput: () => { val.textContent = fmt(levels[+inp.value]); } });
    const btn = h('button', { class: 'btn', onclick: () => apply(levels[+inp.value]) },
      t('app.common.write'), iconEl('send', 12));
    return h('div', { class: 'slider-row' }, h('label', { text: label }), inp, val, btn);
  };
  const sleepText = (m) => (m === 0 ? t('app.common.off') : m + ' ' + t('tc_msg37'));

  // 睡眠档位按型号（K65 等 fw26 = 官方驱动内置档 [30..1200] 分钟、写入 HW=分钟/30；
  // LEOBOG fw24 = 旧档位表 [0..120] 分钟、写入索引——见 protocol.js modelSleepTable）
  const sleepTbl = modelSleepTable(model);
  const sleepRow = mkLevel(t('tc_msg49'), sleepTbl.ui,
    sleepUiIndexOf(sleepTbl, cfg.sleep ?? model.sleepTime ?? 0), sleepText,
    (v) => { cfg.sleep = v; updateCfg({}); device.applySleep(v); });
  const dbRow = mkLevel(t('tc_msg54'), [1, 2, 3, 4, 5], (cfg.debounce ?? 2) - 1,
    (l) => l + ' ' + t('tc_msg55'),
    (v) => { cfg.debounce = v; updateCfg({}); device.applyDebounce(v); });
  // Tap 灵敏度：官方 KB.ini ShowTapTip=0 的型号（K65/Hi75 等）隐藏该设置
  // 不 toast「已写入」：apply* 吞错不回传结果，无条件弹等于假确认；失败路径见 HID 调试台日志
  const tapRows = model.show?.tapTip === false ? [] : [mkLevel('Tap ' + t('tc_kb12'), [1, 2, 3, 4, 5, 6, 7, 8], (cfg.tapSens ?? 4) - 1,
    (l) => l + ' ' + t('tc_msg55'),
    (v) => { cfg.tapSens = v; updateCfg({}); device.applyTapSens(v); })];

  // 「键盘设置」：与「设备信息」一字之差的旧标题易混，且内容（休眠/去抖/灵敏度）均为键盘硬件行为
  const devSet = h('div', { class: 'set-card' },
    cardHead('settings', t('app.settings.keyboardSettings')),
    sleepRow, dbRow, ...tapRows,
  );

  // 配置档
  const exportBtn = h('button', { class: 'btn', onclick: () => {
    download(`leobog-web-config-${new Date().toISOString().slice(0, 10)}.json`, exportAll());
  } }, iconEl('download', 13), t('app.common.export'));
  const importInp = h('input', { type: 'file', accept: '.json', style: 'display:none' });
  importInp.addEventListener('change', async () => {
    const f = importInp.files[0];
    if (!f) return;
    try {
      const r = importAll(await f.text());
      toast(t('app.settings.importedToast', {
        macros: r.macros, cfgs: r.cfgs,
        extra: r.dropped ? t('app.settings.dropped', { n: r.dropped }) : '',
      }));
    } catch (e) {
      toast(t('app.settings.importFailed', { msg: e.message }), true);
    }
    importInp.value = '';
  });
  const importBtn = h('button', { class: 'btn', onclick: () => importInp.click() }, iconEl('upload', 13), t('app.common.import'));
  const resetBtn = h('button', { class: 'btn danger', onclick: async () => {
    if (!(await confirmBox(t('app.settings.factoryResetTitle'), t('app.settings.factoryResetConfirm')))) return;
    const { defaultCfg, loadCfgFor } = await import('../store.js');
    loadCfgFor(state.slug, state.model); // 重新生成默认配置
    toast(t('app.settings.factoryResetDone'));
  } }, iconEl('rotate-ccw', 13), t('app.settings.factoryResetBtn'));
  const profiles = h('div', { class: 'set-card' },
    cardHead('download', t('app.settings.profiles')),
    h('p', { class: 'dim', style: 'margin-bottom:6px', text: t('app.settings.profilesNote') }),
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
// 状态药丸：带状态点（绿点=有值，灰点=无——未连接真机时通道为空）
function kvConn(k, label, ok) {
  return h('div', { class: 'kv' }, h('span', { class: 'k', text: k }),
    h('span', { class: 'kv-pill' + (ok ? ' ok' : ''), text: label }));
}
function hx(v) { return (v ?? 0).toString(16).padStart(4, '0'); }

// HID 控制台：面向专业用户的调试台——收发监视（级别过滤/搜索/跟随滚动）+
// 报文构造发送（0x13 协议帧 / 特征报告 / 原始输出报告）+ 只读探针。
// 发送一律经设备管理器（device.rawSendOutput/rawSendFeature，不绕过架构边界），
// 探针全部只读；模拟模式下发送被拒绝并记录错误行。
import { onDevLog, getLogs, clearLogs, devLog, device, exportDiagnostics } from './index.js';
import * as P from './protocol.js';
import { on } from '../store.js';
import { h, download } from '../ui.js';
import { iconEl } from '../ui-icons.js';
import { t } from '../i18n.js';

// 六个级别（与 devLog 的 kind 一一对应）：点击级别徽标切换显隐
const KINDS = [
  { k: 'tx', label: () => t('app.dbg.kindTx') },
  { k: 'rx', label: () => t('app.dbg.kindRx') },
  { k: 'in', label: () => t('app.dbg.kindIn') },
  { k: 'ok', label: () => t('app.dbg.kindOk') },
  { k: 'warn', label: () => t('app.dbg.kindWarn') },
  { k: 'er', label: () => t('app.dbg.kindEr') },
];
const LOG_DOM_CAP = 800; // 与 logBuf 容量一致，DOM 不超缓冲
const kindOn = new Set(KINDS.map((x) => x.k));
let query = '';
let follow = true; // 跟随滚动：用户上翻即自动暂停，勾选恢复

export function initPanel() {
  const drawer = document.getElementById('debug-drawer');
  const logEl = document.getElementById('dbg-log');
  const btn = document.getElementById('btn-debug');
  const statusEl = document.getElementById('dbg-status');
  const kindsEl = document.getElementById('dbg-kinds');
  const searchEl = document.getElementById('dbg-search');
  const followEl = document.getElementById('dbg-follow');
  const countEl = document.getElementById('dbg-count');
  const modeSel = document.getElementById('dbg-mode');
  const targetSel = document.getElementById('dbg-target');
  const inp = document.getElementById('dbg-input');
  const previewEl = document.getElementById('dbg-preview');
  const readbackEl = document.getElementById('dbg-readback');
  const readbackWrap = document.getElementById('dbg-readback-wrap');

  // ---------- 悬浮小窗：一键把调试台从底部抽屉变成全页面可拖动的小窗 ----------
  // 位置记入 localStorage，调试中刷新页面后小窗还在原处
  const head = drawer.querySelector('.dbg-head');
  const btnFloat = document.getElementById('dbg-float');
  const FLOAT_KEY = 'keyhub-dbg-float';
  const loadPos = () => { try { const p = JSON.parse(localStorage.getItem(FLOAT_KEY)); return p && isFinite(p.x) && isFinite(p.y) ? p : null; } catch { return null; } };
  const savePos = (p) => { try { localStorage.setItem(FLOAT_KEY, JSON.stringify(p)); } catch { /* 隐私模式等写不进就算了 */ } };
  const floating = () => drawer.classList.contains('float');
  function clampInto(x, y) {
    const w = drawer.offsetWidth, hgt = drawer.offsetHeight;
    const maxW = document.documentElement.clientWidth, maxH = document.documentElement.clientHeight;
    return {
      x: Math.min(Math.max(8, x), Math.max(8, maxW - w - 8)),
      y: Math.min(Math.max(8, y), Math.max(8, maxH - hgt - 8)),
    };
  }
  function placeAt(x, y, persist) {
    const p = clampInto(x, y);
    drawer.style.left = p.x + 'px';
    drawer.style.top = p.y + 'px';
    if (persist) savePos(p);
  }
  btnFloat.addEventListener('click', () => {
    const onF = drawer.classList.toggle('float');
    btnFloat.replaceChildren(iconEl(onF ? 'panelBottom' : 'pip', 14)); // 悬浮=画中画，停靠=底部栏
    btnFloat.title = onF ? t('app.dbg.dock') : t('app.dbg.float');
    if (onF) {
      const p = loadPos();
      // .float 类已先加上，offsetWidth/Height 已是小窗尺寸
      if (p) placeAt(p.x, p.y, false);
      else placeAt(document.documentElement.clientWidth - drawer.offsetWidth - 24,
        document.documentElement.clientHeight - drawer.offsetHeight - 24, false);
    } else {
      drawer.style.left = drawer.style.top = '';
    }
  });
  // 拖动：按住表头移动（表头上的按钮照常可点）；move/up 挂 window，指针移出表头也不断线
  let drag = null;
  head.addEventListener('pointerdown', (e) => {
    if (!floating() || e.target.closest('button, input, select')) return;
    const r = drawer.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId };
    e.preventDefault();
  });
  window.addEventListener('pointermove', (e) => {
    if (drag && e.pointerId === drag.id) placeAt(e.clientX - drag.dx, e.clientY - drag.dy, false);
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    savePos({ x: parseFloat(drawer.style.left), y: parseFloat(drawer.style.top) });
  };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  window.addEventListener('resize', () => {
    if (floating() && drawer.style.left) placeAt(parseFloat(drawer.style.left), parseFloat(drawer.style.top), false);
  });

  // ---------- 日志渲染 ----------
  const fmt = (e) => `[${e.time}] ${e.kind.toUpperCase()} ${e.msg}`;
  const visible = (e) => kindOn.has(e.kind) && (!query || e.msg.toLowerCase().includes(query) || e.time.includes(query));

  // 20 字节 0x13 帧的悬停注解（Send13 语义：帧号/总帧数/tag/片长/校验和）。
  // 匹配消息中任意位置的完整 20 对十六进制串（纯帧日志与「label: hex」格式都覆盖）。
  function frameTip(msg) {
    const m = /(?:^|[\s|:])([0-9a-f]{2}(?: [0-9a-f]{2}){19})(?=\s|$)/.exec(msg);
    if (!m) return '';
    const d = P.decodeFrame(m[1].split(' ').map((x) => parseInt(x, 16)));
    if (!d) return '';
    return `${d.name ?? 'cmd 0x' + d.cmd.toString(16)} · ${t('app.dbg.tipFrame', { i: d.seq + 1, n: d.nFrames, tag: d.tag, len: d.len })} · ${d.sumOk ? t('app.dbg.tipSumOk') : t('app.dbg.tipSumBad')}`;
  }
  function lineEl(e) {
    const span = h('span', { class: e.kind, text: fmt(e) + '\n' });
    const tip = frameTip(e.msg);
    if (tip) span.title = tip;
    return span;
  }
  function updateCount() {
    countEl.textContent = t('app.dbg.lineCount', { shown: logEl.childNodes.length, total: getLogs().length });
  }
  function rerender() {
    logEl.textContent = '';
    const frag = document.createDocumentFragment();
    for (const e of getLogs()) if (visible(e)) frag.appendChild(lineEl(e));
    logEl.appendChild(frag);
    if (follow) logEl.scrollTop = logEl.scrollHeight;
    updateCount();
  }
  onDevLog((entry) => {
    if (entry === null) { rerender(); return; } // clearLogs 广播 null
    if (!visible(entry)) { updateCount(); return; }
    logEl.appendChild(lineEl(entry));
    while (logEl.childNodes.length > LOG_DOM_CAP) logEl.removeChild(logEl.firstChild);
    if (follow) logEl.scrollTop = logEl.scrollHeight;
    updateCount();
  });

  // 级别徽标 + 搜索框 + 跟随
  for (const { k, label } of KINDS) {
    const chip = h('button', { class: `dbg-kind ${k} on`, type: 'button', title: t('app.dbg.toggleLevel') },
      h('i', { class: 'dot' }), h('span', { text: label() }));
    chip.addEventListener('click', () => {
      chip.classList.toggle('on');
      chip.classList.contains('on') ? kindOn.add(k) : kindOn.delete(k);
      rerender();
    });
    kindsEl.appendChild(chip);
  }
  let searchTimer = 0;
  searchEl.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { query = searchEl.value.trim().toLowerCase(); rerender(); }, 150);
  });
  followEl.addEventListener('change', () => {
    follow = followEl.checked;
    if (follow) logEl.scrollTop = logEl.scrollHeight;
  });
  logEl.addEventListener('scroll', () => { // 上翻即暂停跟随（回到底部可勾选恢复）
    if (follow && logEl.scrollTop + logEl.clientHeight < logEl.scrollHeight - 40) {
      follow = false;
      followEl.checked = false;
    }
  });

  // 静态 HTML 里的控件文案（跟随/读回应答/发送/筛选/只读探针等）统一由
  // main.js applyStaticI18n 按 data-i18n-* 属性写入，切语言即时刷新，此处不再手工设置

  // ---------- 连接状态徽标 + 发送目标接口 ----------
  const chipEl = (cls, text) => h('span', { class: 'dbg-chip ' + cls, text });
  function refreshTargets() {
    const devs = device.hidDevs ?? [];
    targetSel.replaceChildren();
    if (!devs.length) {
      targetSel.appendChild(h('option', { text: t('app.dbg.noDevice'), selected: '' }));
      targetSel.disabled = true;
      return;
    }
    targetSel.disabled = false;
    devs.forEach((d, i) => {
      const id = `${(d.vendorId || 0).toString(16).padStart(4, '0')}:${(d.productId || 0).toString(16).padStart(4, '0')}`;
      targetSel.appendChild(h('option', {
        value: String(i), selected: i === 0 ? '' : null,
        text: `IF${i} ${id.toUpperCase()} · ${device.ifaceSummary(d)}`,
      }));
    });
  }
  function refreshStatus() {
    statusEl.replaceChildren();
    if (device.mode !== 'hid') {
      statusEl.appendChild(chipEl('sim', t('app.dbg.demoNoDev')));
    } else {
      const ch = device.channelOf(device.dev);
      statusEl.appendChild(chipEl(ch === 'wireless' ? 'wifi' : 'wired',
        ch === 'wireless' ? t('app.common.wireless') : t('app.common.wired')));
      const id = `${(device.dev.vendorId || 0).toString(16).padStart(4, '0')}:${(device.dev.productId || 0).toString(16).padStart(4, '0')}`;
      statusEl.appendChild(chipEl('id', id.toUpperCase()));
      statusEl.appendChild(chipEl('sim', t('app.dbg.ifaceCount', { n: device.hidDevs.length })));
    }
    statusEl.title = device.dev?.productName || '';
    refreshTargets();
  }
  on('device', refreshStatus);
  refreshStatus();

  // ---------- 报文构造器 ----------
  const MODES = [
    {
      v: '13',
      name: () => t('app.dbg.mode13'),
      ph: () => t('app.dbg.mode13Ph'),
    },
    {
      v: 'feat',
      name: () => t('app.dbg.modeFeat'),
      ph: () => t('app.dbg.modeFeatPh'),
    },
    {
      v: 'raw',
      name: () => t('app.dbg.modeRaw'),
      ph: () => t('app.dbg.modeRawPh'),
    },
  ];
  for (const m of MODES) modeSel.appendChild(h('option', { value: m.v, text: m.name() }));
  const applyMode = () => {
    const m = MODES.find((x) => x.v === modeSel.value);
    inp.placeholder = m.ph();
    readbackWrap.style.display = modeSel.value === 'feat' ? '' : 'none'; // 读回应答仅特征报告模式
    updatePreview();
  };
  modeSel.addEventListener('change', applyMode);
  applyMode();

  function parseBytes(raw) {
    const bytes = [];
    for (const x of raw.trim().split(/[\s,]+/).filter(Boolean)) {
      const v = parseInt(x, 16);
      if (!Number.isFinite(v) || v < 0 || v > 255) throw new Error(t('app.dbg.badHex', { x }));
      bytes.push(v);
    }
    return bytes;
  }

  // 解析输入 → { error } | { bytes, note }；不发任何东西。0x13 模式补零并重算校验和。
  function buildPacket() {
    const raw = inp.value.trim();
    if (!raw) return { error: '' }; // 空输入静默等待
    let bytes;
    try { bytes = parseBytes(raw); } catch (e) { return { error: e.message }; }
    const hx = (b) => b.toString(16).padStart(2, '0');
    if (modeSel.value === '13') {
      if (bytes.length > 20) return { error: t('app.dbg.over20') };
      if (bytes[0] !== P.REPORT_ID) return { error: t('app.dbg.firstByte13') };
      const f = new Uint8Array(20);
      f.set(bytes);
      const given = bytes.length === 20 ? f[19] : null;
      f[19] = P.checksum(f);
      const d = P.decodeFrame(f);
      const parts = [d.name ?? 'cmd 0x' + hx(d.cmd), t('app.dbg.framePart', { cur: d.seq + 1, total: d.nFrames })];
      if (d.tag || d.len) parts.push(`tag ${d.tag} · ${d.len}B`);
      if (given != null && given !== f[19]) parts.push(t('app.dbg.checksumFix', { from: hx(given), to: hx(f[19]) }));
      return { bytes: f, note: parts.join(' · ') };
    }
    if (modeSel.value === 'feat') {
      if (bytes.length < 2) return { error: t('app.dbg.need2') };
      if (bytes.length - 1 > 520) return { error: t('app.dbg.over520') };
      return {
        bytes,
        note: t('app.dbg.setFeatureNote', { id: hx(bytes[0]), n: bytes.length - 1 })
          + (readbackEl.checked ? t('app.dbg.getFeatureReadback') : ''),
      };
    }
    if (bytes.length < 2) return { error: t('app.dbg.need2') };
    if (bytes.length > 64) return { error: t('app.dbg.over64') };
    return { bytes, note: t('app.dbg.rawNote', { id: hx(bytes[0]), n: bytes.length - 1 }) };
  }

  function updatePreview() {
    previewEl.classList.remove('err');
    const p = buildPacket();
    if (p.error) {
      previewEl.textContent = p.error;
      previewEl.classList.add('err');
      return;
    }
    if (!p.bytes) { previewEl.textContent = t('app.dbg.waiting'); return; }
    previewEl.textContent = `${P.hex(p.bytes)}  ${p.note}`;
    previewEl.title = frameTip(P.hex(p.bytes)) || '';
  }
  inp.addEventListener('input', updatePreview);
  readbackEl.addEventListener('change', updatePreview);

  const send = async () => {
    const p = buildPacket();
    if (p.error) { updatePreview(); return; }
    if (!p.bytes) return;
    const target = device.hidDevs?.[+targetSel.value] ?? device.dev;
    if (modeSel.value === 'feat') await device.rawSendFeature(target, p.bytes[0], p.bytes.slice(1), readbackEl.checked);
    else await device.rawSendOutput(target, p.bytes);
    // 保留输入内容便于重复发送；清空请手动删或点清空日志
  };
  document.getElementById('dbg-send').addEventListener('click', send);
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
    e.stopPropagation();
  });
  searchEl.addEventListener('keydown', (e) => e.stopPropagation());

  // ---------- 只读探针 ----------
  const PROBES = [
    { label: () => t('app.dbg.probePsd'), tip: () => t('app.dbg.probePsdTip'), run: () => device.probePsd() },
    { label: () => t('app.dbg.probeBattery'), tip: () => t('app.dbg.probeBatteryTip'), run: () => device.probeBattery() },
    { label: () => t('app.dbg.probeConfig'), tip: () => t('app.dbg.probeConfigTip'), run: () => device.probeConfig() },
    { label: () => t('app.dbg.probeKeymap'), tip: () => t('app.dbg.probeKeymapTip'), run: () => device.probeKeymap(0) },
    { label: () => t('app.dbg.probeSweep'), tip: () => t('app.dbg.probeSweepTip'), run: () => device.probeWiredStores() },
  ];
  const probesEl = document.getElementById('dbg-probes');
  for (const pr of PROBES) {
    const b = h('button', { class: 'btn dbg-probe', type: 'button', title: pr.tip(), text: pr.label() });
    b.addEventListener('click', async () => {
      if (b.disabled) return;
      b.disabled = true;
      try { await pr.run(); } catch (e) { /* run 内部已记日志，这里兜底 */ console.warn(e); }
      b.disabled = false;
    });
    probesEl.appendChild(b);
  }

  // ---------- 工具按钮 ----------
  btn.addEventListener('click', () => {
    drawer.classList.toggle('hidden');
    const shown = !drawer.classList.contains('hidden');
    btn.classList.toggle('on', shown);
    if (shown) { refreshStatus(); rerender(); }
  });
  document.getElementById('dbg-close').addEventListener('click', () => {
    drawer.classList.add('hidden');
    btn.classList.remove('on');
  });
  document.getElementById('dbg-clear').addEventListener('click', clearLogs);
  document.getElementById('dbg-copy').addEventListener('click', async () => {
    const lines = getLogs().filter(visible);
    const text = lines.map(fmt).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      devLog('ok', t('app.dbg.copiedFiltered', { n: lines.length }));
    } catch (e) {
      devLog('er', t('app.common.copyFailed', { msg: e.message }));
    }
  });
  document.getElementById('dbg-dl').addEventListener('click', () => {
    const head = ['KeyHub HID console log', `exported: ${new Date().toLocaleString()}`, `ua: ${navigator.userAgent}`, `url: ${location.href}`, '─'.repeat(60), ''].join('\n');
    download(`keyhub-hid-${new Date().toISOString().replace(/[:.]/g, '-')}.log`, head + getLogs().map(fmt).join('\n'));
  });
  // 适配诊断包（社区贡献/issue 排障）：环境+接口能力+最近识别结果+完整日志的只读 JSON 快照
  document.getElementById('dbg-diag').addEventListener('click', exportDiagnostics);

  // 初始回放缓冲里的历史日志
  rerender();
}

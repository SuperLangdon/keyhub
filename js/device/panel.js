// HID 控制台：面向专业用户的调试台——收发监视（级别过滤/搜索/跟随滚动）+
// 报文构造发送（0x13 协议帧 / 特征报告 / 原始输出报告）+ 只读探针。
// 发送一律经设备管理器（device.rawSendOutput/rawSendFeature，不绕过架构边界），
// 探针全部只读；模拟模式下发送被拒绝并记录错误行。
import { onDevLog, getLogs, clearLogs, devLog, device } from './index.js';
import * as P from './protocol.js';
import { on } from '../store.js';
import { h, download } from '../ui.js';
import { iconEl } from '../ui-icons.js';
import { L } from '../i18n.js';

// 六个级别（与 devLog 的 kind 一一对应）：点击级别徽标切换显隐
const KINDS = [
  { k: 'tx', label: () => L('发送', 'TX') },
  { k: 'rx', label: () => L('接收', 'RX') },
  { k: 'in', label: () => L('信息', 'Info') },
  { k: 'ok', label: () => L('成功', 'OK') },
  { k: 'warn', label: () => L('警告', 'Warn') },
  { k: 'er', label: () => L('错误', 'Error') },
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
    btnFloat.title = onF ? L('停靠回底部抽屉', 'Dock to bottom drawer') : L('悬浮为可拖动小窗', 'Float as draggable window');
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
    return `${d.name ?? 'cmd 0x' + d.cmd.toString(16)} · 帧 ${d.seq + 1}/${d.nFrames} · tag ${d.tag} · 片长 ${d.len}B · ${d.sumOk ? '校验和正确' : '校验和不符'}`;
  }
  function lineEl(e) {
    const span = h('span', { class: e.kind, text: fmt(e) + '\n' });
    const tip = frameTip(e.msg);
    if (tip) span.title = tip;
    return span;
  }
  function updateCount() {
    countEl.textContent = L(`${logEl.childNodes.length}/${getLogs().length} 行`, `${logEl.childNodes.length}/${getLogs().length} lines`);
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
    const chip = h('button', { class: `dbg-kind ${k} on`, type: 'button', title: L('点击切换该级别显隐', 'Toggle this level') },
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

  // 静态 HTML 里的控件文案（跟随/读回应答/发送/只读探针）在初始化时按当前语言写入
  followEl.parentNode.lastChild.textContent = L('跟随', 'Follow');
  readbackEl.parentNode.lastChild.textContent = L('读回应答', 'Read back');
  document.getElementById('dbg-send').textContent = L('发送', 'Send');
  searchEl.placeholder = L('筛选…', 'Filter…');
  document.querySelector('.dbg-quick-label').textContent = L('只读探针', 'Read-only probes');

  // ---------- 连接状态徽标 + 发送目标接口 ----------
  const chipEl = (cls, text) => h('span', { class: 'dbg-chip ' + cls, text });
  function refreshTargets() {
    const devs = device.hidDevs ?? [];
    targetSel.replaceChildren();
    if (!devs.length) {
      targetSel.appendChild(h('option', { text: L('（未连接真机）', '(no device)'), selected: '' }));
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
      statusEl.appendChild(chipEl('sim', L('演示模式 · 未连接真机', 'Demo · no device')));
    } else {
      const ch = device.channelOf(device.dev);
      statusEl.appendChild(chipEl(ch === 'wireless' ? 'wifi' : 'wired',
        ch === 'wireless' ? L('2.4G 无线', '2.4G wireless') : L('有线', 'Wired')));
      const id = `${(device.dev.vendorId || 0).toString(16).padStart(4, '0')}:${(device.dev.productId || 0).toString(16).padStart(4, '0')}`;
      statusEl.appendChild(chipEl('id', id.toUpperCase()));
      statusEl.appendChild(chipEl('sim', L(`${device.hidDevs.length} 个接口`, `${device.hidDevs.length} interface(s)`)));
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
      name: () => L('0x13 协议帧', '0x13 protocol frame'),
      ph: () => L('13 44 01 00 …（≤20 字节，自动补零并重算校验和）', '13 44 01 00 … (≤20 bytes, zero-padded, checksum recomputed)'),
    },
    {
      v: 'feat',
      name: () => L('特征报告', 'Feature report'),
      ph: () => L('06 82 01 00 01 00 06 00 …（首字节=report ID，其余=数据）', '06 82 01 00 01 00 06 00 … (first byte = report ID)'),
    },
    {
      v: 'raw',
      name: () => L('原始输出报告', 'Raw output report'),
      ph: () => L('13 44 01 …（原样发送，首字节=report ID）', '13 44 01 … (sent as-is, first byte = report ID)'),
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
      if (!Number.isFinite(v) || v < 0 || v > 255) throw new Error(L(`「${x}」不是合法的十六进制字节`, `"${x}" is not a valid hex byte`));
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
      if (bytes.length > 20) return { error: L('超过 20 字节（0x13 帧 = 1 报文 ID + 19 数据）', 'Over 20 bytes (0x13 frame = 1 report ID + 19 data)') };
      if (bytes[0] !== P.REPORT_ID) return { error: L('首字节须为 13；发任意报文请切到「原始输出报告」', 'First byte must be 13; use "Raw output report" for arbitrary frames') };
      const f = new Uint8Array(20);
      f.set(bytes);
      const given = bytes.length === 20 ? f[19] : null;
      f[19] = P.checksum(f);
      const d = P.decodeFrame(f);
      const parts = [d.name ?? 'cmd 0x' + hx(d.cmd), L(`帧 ${d.seq + 1}/${d.nFrames}`, `frame ${d.seq + 1}/${d.nFrames}`)];
      if (d.tag || d.len) parts.push(`tag ${d.tag} · ${d.len}B`);
      if (given != null && given !== f[19]) parts.push(L(`校验和重算 ${hx(given)}→${hx(f[19])}`, `checksum ${hx(given)}→${hx(f[19])}`));
      return { bytes: f, note: parts.join(' · ') };
    }
    if (modeSel.value === 'feat') {
      if (bytes.length < 2) return { error: L('至少需要 report ID + 1 字节数据', 'Need at least a report ID + 1 data byte') };
      if (bytes.length - 1 > 520) return { error: L('数据超过 520 字节（520B feature 帧上限）', 'Data over 520 bytes (520B feature frame limit)') };
      return {
        bytes,
        note: L(`SetFeature(F${hx(bytes[0])}, ${bytes.length - 1}B 数据)`, `SetFeature(F${hx(bytes[0])}, ${bytes.length - 1}B data)`)
          + (readbackEl.checked ? L(' → GetFeature 回读', ' → GetFeature read-back') : ''),
      };
    }
    if (bytes.length < 2) return { error: L('至少需要 report ID + 1 字节数据', 'Need at least a report ID + 1 data byte') };
    if (bytes.length > 64) return { error: L('超过 64 字节（输出报文上限）', 'Over 64 bytes (output report limit)') };
    return { bytes, note: L(`sendReport(F${hx(bytes[0])}, ${bytes.length - 1}B) 原样发送`, `sendReport(F${hx(bytes[0])}, ${bytes.length - 1}B) as-is`) };
  }

  function updatePreview() {
    previewEl.classList.remove('err');
    const p = buildPacket();
    if (p.error) {
      previewEl.textContent = p.error;
      previewEl.classList.add('err');
      return;
    }
    if (!p.bytes) { previewEl.textContent = L('等待输入…（发送前会显示报文解析与校验）', 'Waiting for input… (frame analysis shown before sending)'); return; }
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
    { label: () => L('识别 GetPSD', 'Identify GetPSD'), tip: () => L('型号识别：对全部已授权接口逐条路径探测（只读）', 'Model identification across all granted interfaces (read-only)'), run: () => device.probePsd() },
    { label: () => L('电量 0x4A', 'Battery 0x4A'), tip: () => L('电量查询（仅 2.4G 无线通道应答，只读）', 'Battery query (2.4G only, read-only)'), run: () => device.probeBattery() },
    { label: () => L('读配置 0x44', 'Config 0x44'), tip: () => L('读灯光配置十片并按协议字段解码（2.4G 通道，只读）', 'Read & decode the 10-frame light config (2.4G, read-only)'), run: () => device.probeConfig() },
    { label: () => L('键位层 0x41', 'Keymap 0x41'), tip: () => L('读层 0 键位表 dword（2.4G 通道，只读）', 'Read layer-0 keymap dwords (2.4G, read-only)'), run: () => device.probeKeymap(0) },
    { label: () => L('有线命令扫描', 'Wired cmd sweep'), tip: () => L('有线 520B feature 帧：只读遍历 cmd 83-8A × sub 0-2 并解码配置（只读）', 'Wired 520B frames: read-only sweep of cmds 83-8A (read-only)'), run: () => device.probeWiredStores() },
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
      devLog('ok', L(`已复制 ${lines.length} 行（当前筛选）`, `Copied ${lines.length} lines (current filter)`));
    } catch (e) {
      devLog('er', L('复制失败：', 'Copy failed: ') + e.message);
    }
  });
  document.getElementById('dbg-dl').addEventListener('click', () => {
    const head = ['KeyHub HID console log', `exported: ${new Date().toLocaleString()}`, `ua: ${navigator.userAgent}`, `url: ${location.href}`, '─'.repeat(60), ''].join('\n');
    download(`keyhub-hid-${new Date().toISOString().replace(/[:.]/g, '-')}.log`, head + getLogs().map(fmt).join('\n'));
  });

  // 初始回放缓冲里的历史日志
  rerender();
}

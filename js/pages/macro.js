// 宏页：宏列表 + 浏览器键盘录制 + 时间轴编辑 + 预览回放 + 写入键盘（cmd 0x03）
import { h, toast, promptBox, confirmBox } from '../ui.js';
import { iconEl } from '../ui-icons.js';
import { t, L } from '../i18n.js';
import { state, save } from '../store.js';
import { vkName } from '../vk.js';
import { CODE_VK } from '../codevk.js';
import { device } from '../device/index.js';

let nextId = 1;
let _stopRec = null;

export function renderMacroPage(root, ctx) {
  let curId = state.macros[0]?.id ?? null;
  let recording = false;
  let recEvents = null;
  let recT0 = 0;
  let loop = 1;

  // ---- 列表 ----
  const list = h('div', { class: 'macro-list' });
  const rebuildList = () => {
    list.innerHTML = '';
    for (const m of state.macros) {
      const item = h('div', { class: 'macro-item' + (m.id === curId ? ' on' : '') },
        h('span', { text: m.name, ondblclick: async (e) => {
          e.stopPropagation();
          const nm = await promptBox(t('tc_macro_msg8', '重命名'), m.name);
          if (nm) { m.name = nm; save(); rebuildList(); }
        } }),
        h('span', {},
          h('span', { class: 'mi-x', title: L('重命名', 'Rename'), onclick: async (e) => {
            e.stopPropagation();
            const nm = await promptBox(t('tc_macro_msg8', '重命名'), m.name);
            if (nm) { m.name = nm; save(); rebuildList(); }
          } }, iconEl('pencil', 12)),
          h('span', { class: 'mi-x', title: L('删除', 'Delete'), onclick: async (e) => {
            e.stopPropagation();
            if (!(await confirmBox(L('删除宏', 'Delete macro'), L(`删除「${m.name}」？`, `Delete "${m.name}"?`)))) return;
            state.macros = state.macros.filter((x) => x !== m);
            if (curId === m.id) curId = state.macros[0]?.id ?? null;
            save(); rebuildList(); rebuildEvents();
          } }, iconEl('x', 12)),
        ),
      );
      item.addEventListener('click', () => { curId = m.id; rebuildList(); rebuildEvents(); });
      list.appendChild(item);
    }
    if (!state.macros.length) list.appendChild(h('div', { class: 'dim', text: L('当前没有宏', 'No macros yet') }));
  };

  const cur = () => state.macros.find((m) => m.id === curId);

  const newBtn = h('button', { class: 'btn primary', text: t('tc_macro_msg2', '新建宏'), onclick: async () => {
    const nm = await promptBox(t('tc_macro_msg3', '请输入名称'), L('宏 ', 'Macro ') + (state.macros.length + 1));
    if (!nm) return;
    const m = { id: nextId++, name: nm, events: [] };
    state.macros.push(m);
    curId = m.id;
    save(); rebuildList(); rebuildEvents();
  } });

  // ---- 录制 ----
  const recBtn = h('button', { class: 'btn' }, iconEl('circle', 13), t('tc_macro_msg4', '录制'));
  const stopBtn = h('button', { class: 'btn', disabled: true }, iconEl('square', 13), t('tc_macro_msg5', '停止'));

  function startRec() {
    const m = cur();
    if (!m) { toast(L('请先新建/选择一个宏', 'Create or select a macro first'), true); return; }
    recording = true;
    recEvents = [];
    recT0 = performance.now();
    recBtn.classList.add('rec-on');
    recBtn.disabled = true; stopBtn.disabled = false;
    toast(L('录制中… 在键盘上按键，点「停止」结束', 'Recording… press keys on the keyboard, click "Stop" to finish'));
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
  }
  function stopRec() {
    recording = false;
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', onKeyUp);
    recBtn.classList.remove('rec-on');
    recBtn.disabled = false; stopBtn.disabled = true;
    const m = cur();
    if (m && recEvents) {
      // 相邻重复 down 去抖
      m.events = recEvents.filter((e, i) => !(i > 0 && e.kind === 'dn' && recEvents[i - 1].kind === 'dn' && e.code === recEvents[i - 1].code));
      save();
    }
    rebuildEvents();
  }
  const onKey = (e) => {
    if (!recording) return;
    if (e.repeat) return;
    const vk = CODE_VK[e.code] ?? CODE_VK[e.code?.toUpperCase?.()] ?? null;
    recEvents.push({ at: Math.round(performance.now() - recT0), kind: 'dn', code: vk ?? 0, label: vk ? vkName(vk) : (e.code || '?') });
  };
  const onKeyUp = (e) => {
    if (!recording) return;
    const vk = CODE_VK[e.code] ?? CODE_VK[e.code?.toUpperCase?.()] ?? null;
    recEvents.push({ at: Math.round(performance.now() - recT0), kind: 'up', code: vk ?? 0, label: vk ? vkName(vk) : (e.code || '?') });
  };
  recBtn.addEventListener('click', startRec);
  stopBtn.addEventListener('click', stopRec);
  _stopRec = stopRec; // 供页面卸载时停止

  // ---- 事件时间轴 ----
  const evBox = h('div', { class: 'macro-events' });
  const loopInp = h('input', { class: 'inp', type: 'number', min: 1, max: 255, value: 1, style: 'width:52px' });
  loopInp.addEventListener('change', () => { loop = Math.max(1, +loopInp.value || 1); });

  const playBtn = h('button', { class: 'btn primary', onclick: () => playMacro() }, iconEl('play', 13), t('tc_macro_msg14', '预览'));

  function rebuildEvents() {
    evBox.innerHTML = '';
    const m = cur();
    if (!m) { evBox.appendChild(h('div', { class: 'dim', style: 'padding:10px', text: L('选择左侧宏', 'Select a macro on the left') })); return; }
    const evs = [...m.events].sort((a, b) => a.at - b.at);
    let prevAt = 0;
    evs.forEach((e, i) => {
      const gap = e.at - prevAt;
      if (gap > 15) {
        evBox.appendChild(h('div', { class: 'mev' },
          h('span', { class: 't', text: '+' + gap + 'ms' }),
          h('span', { class: 'act-dly', text: L('延时', 'Delay') }),
          h('span'), h('span'),
        ));
      }
      prevAt = e.at;
      evBox.appendChild(h('div', { class: 'mev' },
        h('span', { class: 't', text: (e.at / 1000).toFixed(3) + 's' }),
        h('span', { class: e.kind === 'dn' ? 'act-dn' : 'act-up', text: e.kind === 'dn' ? L('↓ 按下', '↓ Down') : L('↑ 释放', '↑ Up') }),
        h('span', { text: e.label || vkName(e.code) || '—' }),
        h('span', { class: 'mev-x', title: L('删除', 'Delete'), onclick: () => {
          m.events.splice(m.events.indexOf(e), 1); save(); rebuildEvents();
        } }, iconEl('x', 11)),
      ));
    });
    if (!evs.length) evBox.appendChild(h('div', { class: 'dim', style: 'padding:10px', text: L('空宏 — 点「录制」并敲击键盘', 'Empty macro — click "Record" and tap keys') }));
  }

  // ---- 回放（屏幕键盘可视化）----
  let playTimers = [];
  function playMacro() {
    const m = cur();
    if (!m || !m.events.length) { toast(L('宏为空', 'Macro is empty'), true); return; }
    stopPlay();
    toast(L(`回放「${m.name}」×${loop}`, `Playing "${m.name}" ×${loop}`));
    for (let p = 0; p < loop; p++) {
      const off = p * (m.events[m.events.length - 1].at + 300);
      for (const e of m.events) {
        playTimers.push(setTimeout(() => {
          if (e.code) {
            ctx.lightsim.press(e.code);
            if (e.kind === 'dn') pressVisual(e.code, 160);
          }
        }, off + e.at));
      }
    }
    playTimers.push(setTimeout(stopPlay, loop * (m.events[m.events.length - 1].at + 400)));
  }
  function pressVisual(code, ms) {
    const el = ctx.keyElByVk?.(code);
    if (el) { el.classList.add('sel'); setTimeout(() => el.classList.remove('sel'), ms); }
  }
  function stopPlay() { playTimers.forEach(clearTimeout); playTimers = []; }

  const clearBtn = h('button', { class: 'btn danger', onclick: async () => {
    const m = cur();
    if (!m || !m.events.length) return;
    if (!(await confirmBox(L('清空', 'Clear'), L(`清空「${m.name}」的所有事件？`, `Clear all events of "${m.name}"?`)))) return;
    m.events = [];
    save(); rebuildEvents();
  } }, iconEl('eraser', 13), L('清空事件', 'Clear events'));

  // ---- 写入键盘（逆向自原驱动：无线 CDev3632 cmd 0x03 / 有线 CDevG5KB cmd 05 + 键位指派读改写）----
  const dlBtn = h('button', { class: 'btn primary', onclick: async () => {
    if (!state.macros.length) { toast(L('还没有宏可写入', 'No macros to write yet'), true); return; }
    dlBtn.disabled = true;
    try {
      const r = await device.applyMacros();
      if (r?.sent) toast(L(`✓ 已写入 ${state.macros.length} 条宏${r.assigned ? `，指派 ${r.assigned} 键` : ''}——回放由键盘固件执行`,
        `✓ Wrote ${state.macros.length} macro(s)${r.assigned ? `, assigned to ${r.assigned} key(s)` : ''} — playback runs on the keyboard firmware`));
      else if (r?.error === 'too-big') toast(L(`打包 ${r.size}B 超上限（10240B）——删减宏/事件后重试`,
        `Packed ${r.size}B exceeds the 10240B limit — trim macros/events and retry`), true);
      else if (r?.error === 'no-channel') toast(L('当前接口不支持宏写入（需 2.4G 接收器或有线 feature 帧接口），请重新连接',
        'This interface does not support macro writes (needs the 2.4G dongle or a wired feature-frame interface) — reconnect'), true);
      else if (!r?.sim) toast(L('宏写入未成功，详见调试台日志', 'Macro write failed — see the debug panel log'), true);
    } finally { dlBtn.disabled = false; }
  } }, iconEl('send', 13), L('写入键盘', 'Write to keyboard'));

  root.append(h('div', { class: 'page-inner' },
    h('div', { class: 'macro-wrap' },
      h('div', { class: 'macro-side' },
        h('h3', { text: L('宏编辑', 'Macro editor') }),
        newBtn,
        list,
      ),
      h('div', { class: 'macro-editor' },
        h('div', { class: 'macro-tools' },
          recBtn, stopBtn, playBtn,
          h('span', { class: 'dim', text: L('循环', 'Loop') }), loopInp,
          clearBtn, dlBtn,
        ),
        evBox,
      ),
    ),
  ));
  rebuildList();
  rebuildEvents();
}

export function cleanupMacroPage() {
  if (_stopRec) _stopRec();
}
export { cleanupMacroPage as cleanup };

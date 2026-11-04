// 宏页：宏列表 + 浏览器键盘录制 + 时间轴编辑 + 预览回放 + 写入键盘（cmd 0x03）
import { h, toast, promptBox, confirmBox } from '../ui.js';
import { iconEl } from '../ui-icons.js';
import { t } from '../i18n.js';
import { state, save } from '../store.js';
import { vkName } from '../vk.js';
import { CODE_VK } from '../codevk.js';
import { device, devLog } from '../device/index.js';

// 新宏 id：取当前（含 localStorage 恢复的）全部 id 的最大值 + 1。
// 不能用模块级计数器——刷新页面后它会重置回 1，与已恢复的宏撞号，
// 导致 find(id) 选错宏、写入键盘时烧错宏内容。
const nextMacroId = () => Math.max(0, ...state.macros.map((m) => Number(m.id) || 0)) + 1;

let _stopRec = null;

export function renderMacroPage(root, ctx) {
  let curId = state.macros[0]?.id ?? null;
  // 旧版本 bug 可能留下重复 id 的宏：不自动迁移（键位指派按 id 匹配，重排会烧错宏），
  // 仅警告提示用户删除重录 / 导出后重新导入（导入侧会统一重排 id）
  {
    const dup = state.macros.length - new Set(state.macros.map((m) => m.id)).size;
    if (dup > 0) devLog('warn', `检测到 ${dup} 个重复宏 id（旧版数据）——指派与写入可能作用在错误的宏上，建议删除重录`);
  }
  let recording = false;
  let recEvents = null;
  let recT0 = 0;
  let loop = 1;

  // ---- 列表 ----
  const list = h('div', { class: 'macro-list' });
  // 没有宏时「写入键盘」「录制」禁用（列表空态文案已说明，不再 toast 拦截）；
  // dlBtn/recBtn 在下方定义，rebuildList 首次调用晚于定义，此处引用安全
  const syncDlBtn = () => { dlBtn.disabled = !state.macros.length; recBtn.disabled = !state.macros.length || recording; };
  const rebuildList = () => {
    list.innerHTML = '';
    for (const m of state.macros) {
      const item = h('div', { class: 'macro-item' + (m.id === curId ? ' on' : '') },
        h('span', { text: m.name, ondblclick: async (e) => {
          e.stopPropagation();
          const nm = await promptBox(t('tc_macro_msg8'), m.name);
          if (nm) { m.name = nm; save(); rebuildList(); }
        } }),
        h('span', {},
          h('span', { class: 'mi-x', title: t('app.common.rename'), onclick: async (e) => {
            e.stopPropagation();
            const nm = await promptBox(t('tc_macro_msg8'), m.name);
            if (nm) { m.name = nm; save(); rebuildList(); }
          } }, iconEl('pencil', 12)),
          h('span', { class: 'mi-x', title: t('app.common.del'), onclick: async (e) => {
            e.stopPropagation();
            if (!(await confirmBox(t('app.macro.deleteMacro'), t('app.macro.deleteConfirm', { name: m.name })))) return;
            state.macros = state.macros.filter((x) => x !== m);
            if (curId === m.id) curId = state.macros[0]?.id ?? null;
            save(); rebuildList(); rebuildEvents();
          } }, iconEl('x', 12)),
        ),
      );
      item.addEventListener('click', () => { curId = m.id; rebuildList(); rebuildEvents(); });
      list.appendChild(item);
    }
    if (!state.macros.length) list.appendChild(h('div', { class: 'dim', text: t('app.macro.noMacros') }));
    syncDlBtn();
  };

  const cur = () => state.macros.find((m) => m.id === curId);

  const newBtn = h('button', { class: 'btn primary', text: t('tc_macro_msg2'), onclick: async () => {
    const nm = await promptBox(t('tc_macro_msg3'), t('app.macro.defaultName', { n: state.macros.length + 1 }));
    if (!nm) return;
    const m = { id: nextMacroId(), name: nm, events: [] };
    state.macros.push(m);
    curId = m.id;
    save(); rebuildList(); rebuildEvents();
  } });

  // ---- 录制 ----
  const recBtn = h('button', { class: 'btn', disabled: !state.macros.length }, iconEl('circle', 13), t('tc_macro_msg4'));
  const stopBtn = h('button', { class: 'btn', disabled: true }, iconEl('square', 13), t('tc_macro_msg5'));

  function startRec() {
    recording = true;
    recEvents = [];
    recT0 = performance.now();
    recBtn.classList.add('rec-on');
    recBtn.disabled = true; stopBtn.disabled = false;
    // 不 toast 操作说明：录制键变红闪烁 + 「停止」亮起即状态，事件会实时落入时间轴
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
  }
  function stopRec() {
    recording = false;
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', onKeyUp);
    recBtn.classList.remove('rec-on');
    recBtn.disabled = !state.macros.length; stopBtn.disabled = true; // 录制中宏被删空时保持禁用
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
    recEvents.push({ at: Math.round(performance.now() - recT0), kind: 'dn', code: vk ?? 0, label: vk ? vkName(vk) : (e.code || '?'), mapped: !!vk });
  };
  const onKeyUp = (e) => {
    if (!recording) return;
    const vk = CODE_VK[e.code] ?? CODE_VK[e.code?.toUpperCase?.()] ?? null;
    recEvents.push({ at: Math.round(performance.now() - recT0), kind: 'up', code: vk ?? 0, label: vk ? vkName(vk) : (e.code || '?'), mapped: !!vk });
  };
  recBtn.addEventListener('click', startRec);
  stopBtn.addEventListener('click', stopRec);
  _stopRec = stopRec; // 供页面卸载时停止

  // ---- 事件时间轴 ----
  const evBox = h('div', { class: 'macro-events' });
  const loopInp = h('input', { class: 'inp', type: 'number', min: 1, max: 255, value: 1, style: 'width:52px' });
  loopInp.addEventListener('change', () => { loop = Math.max(1, +loopInp.value || 1); });

  const playBtn = h('button', { class: 'btn primary', onclick: () => playMacro() }, iconEl('play', 13), t('tc_macro_msg14'));

  function rebuildEvents() {
    evBox.innerHTML = '';
    const m = cur();
    // 空宏/未选宏时预览按钮禁用（时间轴空态文案已说明原因，不再 toast 拦截）
    playBtn.disabled = !m || !m.events.length;
    if (!m) { evBox.appendChild(h('div', { class: 'dim', style: 'padding:10px', text: t('app.macro.selectMacro') })); return; }
    const evs = [...m.events].sort((a, b) => a.at - b.at);
    let prevAt = 0;
    evs.forEach((e, i) => {
      const gap = e.at - prevAt;
      if (gap > 15) {
        evBox.appendChild(h('div', { class: 'mev' },
          h('span', { class: 't', text: '+' + gap + 'ms' }),
          h('span', { class: 'act-dly', text: t('app.common.delay') }),
          h('span'), h('span'),
        ));
      }
      prevAt = e.at;
      // 无 HID 映射的键（FN 等本机键）：时间轴照常显示，但写入键盘时会被固件编码丢弃——
      // 灰显 + 悬停说明，避免「看到的和写进键盘的不一致」无提示（旧数据按 code===0 判定）
      const unmapped = e.mapped === false || (e.mapped == null && !e.code);
      evBox.appendChild(h('div', { class: 'mev' + (unmapped ? ' unmapped' : '') },
        h('span', { class: 't', text: (e.at / 1000).toFixed(3) + 's' }),
        h('span', { class: e.kind === 'dn' ? 'act-dn' : 'act-up', text: e.kind === 'dn' ? t('app.macro.down') : t('app.macro.up') }),
        h('span', { text: e.label || vkName(e.code) || '—', title: unmapped ? t('app.macro.unmappedTip') : '' }),
        h('span', { class: 'mev-x', title: t('app.common.del'), onclick: () => {
          m.events.splice(m.events.indexOf(e), 1); save(); rebuildEvents();
        } }, iconEl('x', 11)),
      ));
    });
    if (!evs.length) evBox.appendChild(h('div', { class: 'dim', style: 'padding:10px', text: t('app.macro.emptyMacro') }));
  }

  // ---- 回放（屏幕键盘可视化）----
  let playTimers = [];
  function playMacro() {
    const m = cur();
    if (!m || !m.events.length) return; // 空宏时按钮已禁用，此行为兜底
    stopPlay();
    // 不 toast：键盘预览上的按键动画即回放反馈
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
    if (!(await confirmBox(t('app.common.clear'), t('app.macro.clearConfirm', { name: m.name })))) return;
    m.events = [];
    save(); rebuildEvents();
  } }, iconEl('eraser', 13), t('app.macro.clearEvents'));

  // ---- 写入键盘（逆向自原驱动：无线 CDev3632 cmd 0x03 / 有线 CDevG5KB cmd 05 + 键位指派读改写）----
  const dlBtn = h('button', { class: 'btn primary' }, iconEl('send', 13), t('app.keys.writeKeyboard'));
  dlBtn.addEventListener('click', async () => {
    dlBtn.disabled = true;
    try {
      const r = await device.applyMacros();
      // 写入结果在键盘上不可见（回放由固件执行），保留成功/失败 toast
      if (r?.sent) toast(t('app.macro.writeOk', {
        n: state.macros.length,
        extra: r.assigned ? t('app.macro.writeOkAssigned', { n: r.assigned }) : '',
      }));
      else if (r?.error === 'too-big') toast(t('app.macro.tooBig', { size: r.size }), true);
      else if (r?.error === 'no-channel') toast(t('app.macro.writeNoChannel'), true);
      else if (!r?.sim) toast(t('app.macro.writeFailed'), true);
    } finally { dlBtn.disabled = false; syncDlBtn(); }
  });

  root.append(h('div', { class: 'page-inner' },
    h('div', { class: 'macro-wrap' },
      // 左列不加标题：「新建宏」按钮 + 列表即身份；标题占行且与右列不对称
      h('div', { class: 'macro-side' },
        newBtn,
        list,
      ),
      h('div', { class: 'macro-editor' },
        h('div', { class: 'macro-tools' },
          recBtn, stopBtn, playBtn,
          h('span', { class: 'dim', text: t('app.common.loop') }), loopInp,
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

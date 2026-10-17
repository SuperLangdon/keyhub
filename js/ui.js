// DOM 与弹层小工具
import { L } from './i18n.js';

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;      // false = 不设属性（setAttribute('disabled', false) 也会禁用元素！）
    if (v === true) { el.setAttribute(k, ''); continue; } // 布尔属性
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

let toastTimer = null;
export function toast(msg, err = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.toggle('err', err);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
}

// 弹层可访问性：role/aria-modal、Esc 关闭、打开时把焦点移入弹层、关闭时还原焦点。
// 返回卸载函数（弹层移除前调用）。onClose 在按 Esc 时触发（语义上等于取消/关闭）。
export function modalA11y(mask, onClose) {
  mask.setAttribute('role', 'dialog');
  mask.setAttribute('aria-modal', 'true');
  const prev = document.activeElement;
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); } };
  mask.addEventListener('keydown', onKey);
  setTimeout(() => {
    // 优先聚焦首个输入控件（prompt 场景），否则聚焦弹层卡片本身
    const box = mask.querySelector('.modal');
    const target = mask.querySelector('input, select, textarea') || box;
    if (target) { target.tabIndex = target === box ? -1 : target.tabIndex; target.focus({ preventScroll: true }); }
  });
  return () => {
    mask.removeEventListener('keydown', onKey);
    if (prev && prev.focus && document.contains(prev)) prev.focus({ preventScroll: true });
  };
}

// 确认弹层
export function confirmBox(title, msg) {
  return new Promise((resolve) => {
    const mask = h('div', { class: 'modal-mask' });
    let unA11y = () => {};
    const close = (v) => { unA11y(); mask.remove(); resolve(v); };
    unA11y = modalA11y(mask, () => close(false));
    mask.append(h('div', { class: 'modal' },
      h('h4', { text: title }),
      h('div', { text: msg }),
      h('div', { class: 'm-foot' },
        h('button', { class: 'btn', onclick: () => close(false) }, L('取消', 'Cancel')),
        h('button', { class: 'btn primary', onclick: () => close(true) }, L('确定', 'OK')),
      ),
    ));
    mask.addEventListener('click', (e) => { if (e.target === mask) close(false); });
    document.body.appendChild(mask);
  });
}

// 输入弹层（重命名/新建）
export function promptBox(title, value = '') {
  return new Promise((resolve) => {
    const mask = h('div', { class: 'modal-mask' });
    const inp = h('input', { class: 'inp', value, style: 'width:100%' });
    let unA11y = () => {};
    const close = (v) => { unA11y(); mask.remove(); resolve(v); };
    unA11y = modalA11y(mask, () => close(null));
    mask.append(h('div', { class: 'modal' },
      h('h4', { text: title }),
      inp,
      h('div', { class: 'm-foot' },
        h('button', { class: 'btn', onclick: () => close(null) }, L('取消', 'Cancel')),
        h('button', { class: 'btn primary', onclick: () => close(inp.value.trim() || null) }, L('确定', 'OK')),
      ),
    ));
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') close(inp.value.trim() || null);
      if (e.key === 'Escape') close(null);
      e.stopPropagation();
    });
    mask.addEventListener('click', (e) => { if (e.target === mask) close(null); });
    document.body.appendChild(mask);
    setTimeout(() => { inp.focus(); inp.select(); });
  });
}

export function download(filename, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

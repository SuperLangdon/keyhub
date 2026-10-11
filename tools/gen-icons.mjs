// 从 assets/icons/*.svg（lucide-static，ISC License）生成 js/ui-icons.js
// 用法: node tools/gen-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'assets', 'icons');
const OUT = path.join(ROOT, 'js', 'ui-icons.js');

const icons = {};
for (const f of fs.readdirSync(SRC).filter((x) => x.endsWith('.svg'))) {
  const name = f.replace(/\.svg$/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const svg = fs.readFileSync(path.join(SRC, f), 'utf8');
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim();
  icons[name] = inner;
}

const lines = [
  '// 由 tools/gen-icons.mjs 生成 —— 请勿手改；源: assets/icons/*.svg (lucide, ISC License)',
  'const ICONS = {',
];
for (const [k, v] of Object.entries(icons)) lines.push('  ' + JSON.stringify(k) + ': ' + JSON.stringify(v) + ',');
lines.push('};', '',
  '// 线性矢量图标，继承 currentColor',
  'export function iconHTML(name, size, cls) {',
  '  size = size || 16; cls = cls || \'\';',
  '  const inner = ICONS[name] || ICONS.circle;',
  '  return \'<svg class="ic \' + cls + \'" width="\' + size + \'" height="\' + size + \'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">\' + inner + \'</svg>\';',
  '}', '',
  'export function iconEl(name, size, cls) {',
  '  const t = document.createElement(\'template\');',
  '  t.innerHTML = iconHTML(name, size, cls);',
  '  return t.content.firstChild;',
  '}', '');

fs.writeFileSync(OUT, lines.join('\n'));
console.log('ui-icons.js: ' + Object.keys(icons).length + ' icons');

#!/usr/bin/env node
// 构建标记生成器：node tools/bump-build.mjs
// 读取 git 短哈希 + 日期，改写 js/store.js 的 BUILD 行。改 js 后运行一次（贡献清单见 CONTRIBUTING.md），
// 标记会出现在日志/诊断包里，用于核对浏览器拿到的是否最新代码（避免模块缓存误导调试）。
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STORE = resolve(ROOT, 'js', 'store.js');

const date = new Date().toISOString().slice(0, 10);
let rev = '';
try { rev = execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
catch { /* 无 git 环境（zip 解包等）：日期 + 随机后缀兜底 */ }
const tag = `${date}.${rev || Math.random().toString(36).slice(2, 8)}`;

const src = readFileSync(STORE, 'utf8');
const re = /^export const BUILD = '.*';\r?$/m;
if (!re.test(src)) { console.error('未在 js/store.js 找到 BUILD 行'); process.exit(1); }
writeFileSync(STORE, src.replace(re, `export const BUILD = '${tag}';`));
console.log(`BUILD -> ${tag}`);

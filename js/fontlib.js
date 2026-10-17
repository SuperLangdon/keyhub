// 自定义字体加载（FontFace + IndexedDB 持久化）—— 供屏幕页「加文字」使用。
// 用户选择 TTF/OTF/WOFF/WOFF2 文件后注册为 document 字体（本会话立即可用于 canvas 绘制），
// 字体文件字节存入 IndexedDB（DB: keyhub-fonts / store: fonts，键=字体族名），下次打开自动恢复。

const DB_NAME = 'keyhub-fonts';
const STORE = 'fonts';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'family' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbRun(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}

// 注册字体（ArrayBuffer）到 document.fonts；family 形如 "khf-xxx"，返回注册名
export async function registerFont(family, buffer) {
  const face = new FontFace(family, buffer);
  await face.load();
  document.fonts.add(face);
  return family;
}

// 页面启动时恢复用户此前的自定义字体（失败逐个忽略——单个损坏不影响其它）
export async function restoreFonts() {
  try {
    const rows = await idbRun('readonly', (s) => s.getAll());
    const out = [];
    for (const r of rows ?? []) {
      try { await registerFont(r.family, r.buffer); out.push({ family: r.family, label: r.label }); }
      catch (e) { console.warn('字体恢复失败:', r.family, e); }
    }
    return out;
  } catch { return []; }
}

// 保存并注册新字体；label 为展示名（原文件名），family 自动派生
export async function saveFont(label, buffer) {
  const family = 'khf-' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + buffer.byteLength.toString(36);
  await registerFont(family, buffer);
  await idbRun('readwrite', (s) => s.put({ family, label, buffer }));
  return { family, label };
}

export async function deleteFont(family) {
  await idbRun('readwrite', (s) => s.delete(family));
}

// 从文件名生成展示名（去扩展名）
export function fontLabel(fileName) {
  return fileName.replace(/\.(ttf|otf|woff2?|ttc)$/i, '') || fileName;
}

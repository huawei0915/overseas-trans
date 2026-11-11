// 組出可部署到 GitHub Pages 的靜態網站到 dist-pages/。
// importmap 指向 node_modules，所以只複製執行時需要的那幾個套件檔案。
// 用法：npm ci && npm run setup:offline && npm run build:pages
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist-pages');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

function copy(rel, filter) {
  const src = path.join(root, rel);
  if (!fs.existsSync(src)) {
    console.warn(`略過（不存在）：${rel}`);
    return;
  }
  fs.cpSync(src, path.join(out, rel), { recursive: true, filter });
}

for (const rel of ['index.html', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'icons', 'models']) copy(rel);
fs.writeFileSync(path.join(out, '.nojekyll'), '');

copy('node_modules/piper-plus', (src) => !/\.(md|map)$/.test(src));
copy('node_modules/@piper-plus/g2p', (src) => !/\.(md|map)$/.test(src));
copy('node_modules/opencc-js/dist/esm');
// onnxruntime-web：只需要 wasm 版（ort.wasm.min.mjs + ort-wasm-simd-threaded.{mjs,wasm}）
for (const f of ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  copy(`node_modules/onnxruntime-web/dist/${f}`);
}

console.log(`已輸出到 ${path.relative(root, out)}/`);

// 下載離線語音（Piper Plus）所需的模型到 models/，之後完全不需要網路。
// 用法：npm run setup:offline
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HF = 'https://huggingface.co';

// Piper Plus 多語模型（日/英/中/西/法/葡）：config.json 需放在模型旁並命名為 <model>.onnx.json
const TSUKUYOMI = `${HF}/ayousanz/piper-plus-tsukuyomi-chan/resolve/main`;
// Piper Plus 目前沒有韓文訓練模型，韓文使用 MMS-TTS Korean（VITS，ONNX）
const MMS_KOR = `${HF}/Xenova/mms-tts-kor/resolve/main`;

// 說話者聲紋模型（wespeaker ResNet34-LM，與 pyannote/wespeaker-voxceleb-resnet34-LM 同一組權重），在瀏覽器內以 onnxruntime-web 執行
const WESPEAKER = `${HF}/Wespeaker/wespeaker-voxceleb-resnet34-LM/resolve/main`;

const FILES = [
  { url: `${WESPEAKER}/voxceleb_resnet34_LM.onnx`, dest: 'models/wespeaker/voxceleb_resnet34_LM.onnx' },
  { url: `${TSUKUYOMI}/tsukuyomi-chan-6lang-fp16.onnx`, dest: 'models/piper-plus/tsukuyomi-chan-6lang-fp16.onnx' },
  { url: `${TSUKUYOMI}/config.json`, dest: 'models/piper-plus/tsukuyomi-chan-6lang-fp16.onnx.json' },
  { url: `${MMS_KOR}/onnx/model.onnx`, dest: 'models/mms-tts-kor/model.onnx' },
  { url: `${MMS_KOR}/vocab.json`, dest: 'models/mms-tts-kor/vocab.json' },
  { url: `${MMS_KOR}/config.json`, dest: 'models/mms-tts-kor/config.json' },
];

async function download({ url, dest }) {
  const target = path.join(root, dest);
  if (fs.existsSync(target) && fs.statSync(target).size > 0) {
    console.log(`✓ 已存在 ${dest}`);
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`${url} 回應 ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let loaded = 0;
  let lastPct = -1;
  const tmp = `${target}.part`;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    loaded += chunk.length;
    if (!total) return;
    const pct = Math.floor((loaded * 100) / total / 10) * 10;
    if (pct !== lastPct) {
      lastPct = pct;
      process.stdout.write(`\r↓ ${dest} ${pct}%   `);
    }
  });
  await pipeline(body, fs.createWriteStream(tmp));
  if (total && loaded !== total) throw new Error(`${dest} 下載不完整（${loaded}/${total}）`);
  fs.renameSync(tmp, target);
  process.stdout.write(`\r✓ ${dest} (${(loaded / 1048576).toFixed(1)} MB)   \n`);
}

for (const file of FILES) {
  try {
    await download(file);
  } catch (err) {
    console.error(`\n✗ ${file.dest}：${err.message}`);
    process.exitCode = 1;
  }
}

if (!process.exitCode) {
  console.log('\n完成。語音引擎選「Piper Plus（離線）」即可離線播放。');
  console.log('授權提醒：つくよみちゃん模型需標示「Piper Plus:つくよみちゃん」；MMS-TTS Korean 為 CC-BY-NC 4.0（非商用）。');
}

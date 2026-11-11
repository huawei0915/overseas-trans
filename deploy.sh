#!/usr/bin/env bash
# 部署 Cloudflare Worker（DeepL 中繼）。用法：./deploy.sh [--dry-run]
set -euo pipefail

cd "$(dirname "$0")"

DRY_RUN=()
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=(--dry-run)

[[ -d node_modules/.bin ]] || { echo "==> 安裝相依套件"; npm ci; }

if ! npx wrangler whoami 2>&1 | grep -qiE "associated with the email|logged in"; then
  echo "==> 尚未登入 Cloudflare，開啟瀏覽器登入"
  npx wrangler login
fi

echo "==> 部署 Worker"
npx wrangler deploy --config cloudflare-worker/wrangler.toml ${DRY_RUN[@]+"${DRY_RUN[@]}"}

echo "==> 完成"

#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dist/deepseek-code-nav.zip"
mkdir -p "$ROOT/dist"
rm -f "$OUT"
cd "$ROOT/src"
zip -r -X "$OUT" manifest.json content.js icon-16.png icon-32.png icon-48.png icon-128.png
echo "已生成：$OUT"
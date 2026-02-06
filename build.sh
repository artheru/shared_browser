#!/usr/bin/env bash
# ============================================================
#  Shared Browser 打包脚本
#  用法: bash build.sh
#  输出: shared-browser.zip
# ============================================================

set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "  Shared Browser - Build"
echo "  ======================"
echo ""

# ---------- 1. 生成版本号 ----------
VERSION=$(date +"%Y.%m.%d-%H%M%S")
BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
printf '{"version":"%s","buildTime":"%s"}' "$VERSION" "$BUILD_TIME" > "$ROOT/version.json"
echo "  [1/4] Version: $VERSION"

# ---------- 2. 构建前端 ----------
echo "  [2/4] Building frontend..."
cd "$ROOT/client"
if [ ! -d "node_modules" ]; then
    echo "        Installing client dependencies..."
    npm install --silent
fi
npm run build --silent
echo "  [2/4] Frontend build OK"

# ---------- 3. 打包文件 ----------
echo "  [3/4] Packaging..."
cd "$ROOT"
TEMP_DIR="$ROOT/_build_temp"
ZIP_FILE="$ROOT/shared-browser.zip"

rm -rf "$TEMP_DIR" "$ZIP_FILE"
mkdir -p "$TEMP_DIR/client"

# server（排除 data）
cp -r "$ROOT/server" "$TEMP_DIR/server"
rm -rf "$TEMP_DIR/server/data"

# client/dist
cp -r "$ROOT/client/dist" "$TEMP_DIR/client/dist"

# 根目录文件
cp "$ROOT/package.json" "$TEMP_DIR/"
cp "$ROOT/version.json" "$TEMP_DIR/"
[ -f "$ROOT/package-lock.json" ] && cp "$ROOT/package-lock.json" "$TEMP_DIR/"

# 安装脚本
[ -f "$ROOT/install.bat" ] && cp "$ROOT/install.bat" "$TEMP_DIR/"
[ -f "$ROOT/install.sh" ]  && cp "$ROOT/install.sh"  "$TEMP_DIR/"

# ---------- 4. 压缩 ----------
cd "$TEMP_DIR"
zip -rq "$ZIP_FILE" .
cd "$ROOT"
rm -rf "$TEMP_DIR"

SIZE=$(du -h "$ZIP_FILE" | cut -f1)
echo "  [4/4] Done!"
echo ""
echo "  Output: shared-browser.zip ($SIZE)"
echo "  Deploy: copy zip to target machine, unzip, run install.sh"
echo ""

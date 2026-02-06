#!/usr/bin/env bash
# ============================================================
#  Shared Browser - Linux / macOS Installer
#  解压 shared-browser.zip 后运行: bash install.sh
# ============================================================

set -e

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "  =========================================="
echo "   Shared Browser - Installer"
echo "  =========================================="
echo ""
echo "  Install directory: $INSTALL_DIR"
echo ""

# ---------- Helper ----------
ask_yn() {
    local prompt="$1" default="${2:-y}"
    local yn
    read -r -p "      $prompt [Y/n]: " yn
    yn="${yn:-$default}"
    [[ "$yn" =~ ^[Yy] ]]
}

# ---------- 1. 检测 Node.js ----------
echo "  [1/6] Checking Node.js..."

if command -v node &>/dev/null; then
    NODE_VER=$(node --version)
    echo "        Found: $NODE_VER ($(command -v node))"
else
    echo ""
    echo "  [!] Node.js not found!"
    echo ""
    echo "      Install options:"
    echo "        Ubuntu/Debian:  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs"
    echo "        macOS:          brew install node"
    echo "        Other:          https://nodejs.org/"
    echo ""

    if ask_yn "Try auto-install via package manager?"; then
        if command -v apt &>/dev/null; then
            echo "      Installing via apt..."
            curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
            sudo apt install -y nodejs
        elif command -v brew &>/dev/null; then
            echo "      Installing via brew..."
            brew install node
        elif command -v dnf &>/dev/null; then
            echo "      Installing via dnf..."
            curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
            sudo dnf install -y nodejs
        else
            echo "      [!] No supported package manager found. Please install Node.js manually."
            exit 1
        fi

        if ! command -v node &>/dev/null; then
            echo "      [!] Installation failed. Please install Node.js manually."
            exit 1
        fi
        echo "      Installed: $(node --version)"
    else
        echo "      Aborted. Please install Node.js and try again."
        exit 1
    fi
fi
echo ""

# ---------- 2. 检测 Chrome ----------
echo "  [2/6] Checking Chrome..."

CHROME_BIN=""
for candidate in \
    /usr/bin/google-chrome \
    /usr/bin/google-chrome-stable \
    /usr/bin/chromium-browser \
    /usr/bin/chromium \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
    if [ -f "$candidate" ] || [ -x "$candidate" ]; then
        CHROME_BIN="$candidate"
        break
    fi
done

if [ -n "$CHROME_BIN" ]; then
    echo "        Found: $CHROME_BIN"
else
    echo ""
    echo "  [!] Chrome/Chromium not found!"
    echo "      Install: sudo apt install -y google-chrome-stable"
    echo "      Or:      sudo apt install -y chromium-browser"
    echo ""
    if ask_yn "Try auto-install chromium?"; then
        if command -v apt &>/dev/null; then
            sudo apt install -y chromium-browser || sudo apt install -y chromium
        elif command -v brew &>/dev/null; then
            brew install --cask google-chrome
        fi
    fi
fi
echo ""

# ---------- 3. 配置端口 ----------
echo "  [3/6] Configure service port"
echo ""
read -r -p "      Port [default: 3000]: " SERVICE_PORT
SERVICE_PORT="${SERVICE_PORT:-3000}"
echo "        Using port: $SERVICE_PORT"
echo ""

# ---------- 4. 安装依赖 ----------
echo "  [4/6] Installing npm dependencies..."
echo ""
cd "$INSTALL_DIR"
npm install --omit=dev
echo ""
echo "        Dependencies installed."
echo ""

# ---------- 5. 防火墙 ----------
echo "  [5/6] Firewall configuration"
echo ""
if ask_yn "Open port $SERVICE_PORT in firewall?"; then
    if command -v ufw &>/dev/null; then
        sudo ufw allow "$SERVICE_PORT/tcp" 2>/dev/null && echo "        UFW rule added." || echo "        [!] Failed to add UFW rule."
    elif command -v firewall-cmd &>/dev/null; then
        sudo firewall-cmd --permanent --add-port="$SERVICE_PORT/tcp" 2>/dev/null && sudo firewall-cmd --reload && echo "        Firewalld rule added." || echo "        [!] Failed."
    else
        echo "        [!] No supported firewall tool found. Please open port manually."
    fi
else
    echo "        Skipped."
fi
echo ""

# ---------- 6. 创建启动脚本 ----------
echo "  [6/6] Creating startup script..."

cat > "$INSTALL_DIR/start.sh" << EOF
#!/usr/bin/env bash
cd "$INSTALL_DIR"
export PORT=$SERVICE_PORT
echo ""
echo "  Shared Browser starting on port $SERVICE_PORT ..."
echo "  Open: http://localhost:$SERVICE_PORT"
echo "  Press Ctrl+C to stop."
echo ""
node server/index.js
EOF
chmod +x "$INSTALL_DIR/start.sh"
echo "        Created: start.sh"
echo ""

# ---------- 完成 ----------
echo "  =========================================="
echo "   Installation Complete!"
echo "  =========================================="
echo ""
echo "  Start:    bash start.sh"
echo "  URL:      http://localhost:$SERVICE_PORT"
echo "  Login:    admin / admin123"
echo ""

if ask_yn "Start the service now?"; then
    echo ""
    echo "  Starting..."
    echo ""
    bash "$INSTALL_DIR/start.sh"
fi

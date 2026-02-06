@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion

:: ============================================================
::  Shared Browser - Windows Installer
::  解压 shared-browser.zip 后运行此脚本即可完成安装
:: ============================================================

title Shared Browser Installer

echo.
echo   ==========================================
echo    Shared Browser - Installer
echo   ==========================================
echo.

:: ---------- 检测当前目录 ----------
set "INSTALL_DIR=%~dp0"
:: 去掉末尾反斜杠
if "%INSTALL_DIR:~-1%"=="\" set "INSTALL_DIR=%INSTALL_DIR:~0,-1%"

echo   Install directory: %INSTALL_DIR%
echo.

:: ---------- 检测 Node.js ----------
echo   [1/6] Checking Node.js...

set "NODE_EXE="
set "NPM_CMD="

:: 先检查 PATH 中的 node
where node >nul 2>&1
if %errorlevel%==0 (
    for /f "tokens=*" %%i in ('where node') do set "NODE_EXE=%%i"
    for /f "tokens=*" %%i in ('node --version') do set "NODE_VER=%%i"
    echo         Found: !NODE_VER! ^(!NODE_EXE!^)
    set "NPM_CMD=npm"
    goto :node_ok
)

:: 检查常见安装路径
if exist "C:\Program Files\nodejs\node.exe" (
    set "NODE_EXE=C:\Program Files\nodejs\node.exe"
    set "NPM_CMD=C:\Program Files\nodejs\npm.cmd"
    for /f "tokens=*" %%i in ('"C:\Program Files\nodejs\node.exe" --version') do set "NODE_VER=%%i"
    echo         Found: !NODE_VER! ^(!NODE_EXE!^)
    goto :node_ok
)

echo.
echo   [!] Node.js not found!
echo.
echo       Please install Node.js 18+ first:
echo       https://nodejs.org/
echo.
echo       Or install via winget:
echo         winget install OpenJS.NodeJS.LTS
echo.
set /p "INSTALL_NODE=      Install Node.js now via winget? [Y/n]: "
if /i "!INSTALL_NODE!"=="n" (
    echo.
    echo   Aborted. Please install Node.js and try again.
    goto :end
)
echo.
echo       Installing Node.js LTS...
winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
if %errorlevel% neq 0 (
    echo   [!] Installation failed. Please install Node.js manually.
    goto :end
)
echo.
echo   [!] Node.js installed. Please RESTART this script to continue.
echo       ^(New PATH takes effect after restart^)
goto :end

:node_ok
echo.

:: ---------- 检测 Chrome ----------
echo   [2/6] Checking Chrome...

set "CHROME_FOUND=0"
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    set "CHROME_FOUND=1"
    echo         Found: C:\Program Files\Google\Chrome\Application\chrome.exe
)
if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
    set "CHROME_FOUND=1"
    echo         Found: C:\Program Files ^(x86^)\Google\Chrome\Application\chrome.exe
)

if "!CHROME_FOUND!"=="0" (
    echo.
    echo   [!] Chrome not found!
    echo       Please install Google Chrome:
    echo       https://www.google.com/chrome/
    echo.
    set /p "INSTALL_CHROME=      Install Chrome now via winget? [Y/n]: "
    if /i "!INSTALL_CHROME!"=="n" (
        echo.
        echo   [!] Warning: Chrome is required. Service may not work without it.
    ) else (
        echo       Installing Chrome...
        winget install Google.Chrome --accept-package-agreements --accept-source-agreements
    )
)
echo.

:: ---------- 配置端口 ----------
echo   [3/6] Configure service port
echo.
set "SERVICE_PORT=3000"
set /p "SERVICE_PORT=      Port [default: 3000]: "
if "!SERVICE_PORT!"=="" set "SERVICE_PORT=3000"
echo         Using port: !SERVICE_PORT!
echo.

:: ---------- 安装依赖 ----------
echo   [4/6] Installing npm dependencies...
echo.

:: 设置 PATH（确保 node/npm 可用）
set "PATH=%PATH%;C:\Program Files\nodejs"

pushd "%INSTALL_DIR%"
call !NPM_CMD! install --omit=dev 2>&1
if %errorlevel% neq 0 (
    echo.
    echo   [!] npm install failed. Check errors above.
    popd
    goto :end
)
popd
echo.
echo         Dependencies installed.
echo.

:: ---------- 防火墙 ----------
echo   [5/6] Firewall configuration
echo.
set /p "OPEN_FW=      Open port !SERVICE_PORT! in Windows Firewall? [Y/n]: "
if /i "!OPEN_FW!"=="n" (
    echo         Skipped.
) else (
    netsh advfirewall firewall delete rule name="SharedBrowser" >nul 2>&1
    netsh advfirewall firewall add rule name="SharedBrowser" dir=in action=allow protocol=tcp localport=!SERVICE_PORT! >nul 2>&1
    if %errorlevel%==0 (
        echo         Firewall rule added for port !SERVICE_PORT!.
    ) else (
        echo         [!] Failed to add firewall rule. Try running as Administrator.
    )
)
echo.

:: ---------- 创建启动脚本 ----------
echo   [6/6] Creating startup script...

:: start.bat
(
echo @echo off
echo title Shared Browser
echo cd /d "%INSTALL_DIR%"
echo set "PATH=%%PATH%%;C:\Program Files\nodejs"
echo set PORT=!SERVICE_PORT!
echo echo.
echo echo   Shared Browser starting on port !SERVICE_PORT! ...
echo echo   Open: http://localhost:!SERVICE_PORT!
echo echo   Press Ctrl+C to stop.
echo echo.
echo node server\index.js
echo pause
) > "%INSTALL_DIR%\start.bat"

echo         Created: start.bat
echo.

:: ---------- 完成 ----------
echo   ==========================================
echo    Installation Complete!
echo   ==========================================
echo.
echo   Start:    run start.bat
echo   URL:      http://localhost:!SERVICE_PORT!
echo   Login:    admin / admin123
echo.
set /p "START_NOW=   Start the service now? [Y/n]: "
if /i "!START_NOW!"=="n" (
    echo.
    echo   Run start.bat when you're ready.
) else (
    echo.
    echo   Starting...
    echo.
    start "SharedBrowser" cmd /c "%INSTALL_DIR%\start.bat"
    timeout /t 3 >nul
    echo   Service started! Open http://localhost:!SERVICE_PORT! in your browser.
)

:end
echo.
pause

@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion

:: ============================================================
::  Shared Browser - Windows Installer / Updater
::  解压 shared-browser.zip 后运行此脚本即可完成安装
::  已有安装时支持增量更新模式（跳过环境检查，按需 npm install）
::
::  用法:
::    install.bat              交互式（自动检测模式）
::    install.bat /update      增量更新模式（静默，适合 AI 调用）
::    install.bat /full        强制全新安装模式
::    install.bat /port 8080   指定端口
:: ============================================================

title Shared Browser Installer

:: ---------- 解析命令行参数 ----------
set "FORCE_UPDATE=0"
set "FORCE_FULL=0"
set "CLI_PORT="
set "SILENT=0"

:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="/update"      ( set "FORCE_UPDATE=1" & set "SILENT=1" & shift & goto :parse_args )
if /i "%~1"=="--update"     ( set "FORCE_UPDATE=1" & set "SILENT=1" & shift & goto :parse_args )
if /i "%~1"=="/incremental" ( set "FORCE_UPDATE=1" & set "SILENT=1" & shift & goto :parse_args )
if /i "%~1"=="/full"        ( set "FORCE_FULL=1" & shift & goto :parse_args )
if /i "%~1"=="--full"       ( set "FORCE_FULL=1" & shift & goto :parse_args )
if /i "%~1"=="/port"        ( set "CLI_PORT=%~2" & shift & shift & goto :parse_args )
if /i "%~1"=="--port"       ( set "CLI_PORT=%~2" & shift & shift & goto :parse_args )
if /i "%~1"=="/silent"      ( set "SILENT=1" & shift & goto :parse_args )
if /i "%~1"=="--silent"     ( set "SILENT=1" & shift & goto :parse_args )
shift
goto :parse_args
:args_done

:: ---------- 检测当前目录 ----------
set "INSTALL_DIR=%~dp0"
:: 去掉末尾反斜杠
if "%INSTALL_DIR:~-1%"=="\" set "INSTALL_DIR=%INSTALL_DIR:~0,-1%"

echo.
echo   ==========================================
echo    Shared Browser - Installer
echo   ==========================================
echo.
echo   Install directory: %INSTALL_DIR%
echo.

:: ---------- 检测已有安装 ----------
set "EXISTING_INSTALL=0"
if exist "%INSTALL_DIR%\node_modules" if exist "%INSTALL_DIR%\server\index.js" set "EXISTING_INSTALL=1"

:: 读取已保存的端口
set "SAVED_PORT="
if exist "%INSTALL_DIR%\.install-port" (
    set /p SAVED_PORT=<"%INSTALL_DIR%\.install-port"
)

:: ---------- 确定运行模式 ----------
if "!FORCE_FULL!"=="1" (
    echo   Mode: FULL INSTALL ^(forced^)
    goto :full_install
)

if "!FORCE_UPDATE!"=="1" (
    if "!EXISTING_INSTALL!"=="0" (
        echo   [!] No existing installation found, switching to full install.
        goto :full_install
    )
    echo   Mode: INCREMENTAL UPDATE
    goto :update_mode
)

:: 交互式：自动检测
if "!EXISTING_INSTALL!"=="1" (
    echo   [*] Existing installation detected.
    echo.
    echo       1) Incremental update  ^(fast, skip env checks^)
    echo       2) Full install        ^(check everything^)
    echo.
    set /p "INSTALL_CHOICE=      Choose [1]: "
    if "!INSTALL_CHOICE!"=="2" goto :full_install
    goto :update_mode
) else (
    goto :full_install
)

:: ============================================================
::  INCREMENTAL UPDATE MODE
:: ============================================================

:update_mode
echo.
echo   --- Incremental Update ---
echo.

:: 设置 PATH（确保 node/npm 可用）
set "PATH=%PATH%;C:\Program Files\nodejs"

:: 确定端口
if defined CLI_PORT (
    set "SERVICE_PORT=!CLI_PORT!"
) else if defined SAVED_PORT (
    set "SERVICE_PORT=!SAVED_PORT!"
) else (
    set "SERVICE_PORT=3000"
)

:: [U1] 停止已运行的服务
echo   [U1] Stopping existing service...
:: 精确终止通过 start.bat 启动的 node 进程（避免误杀其他 node）
for /f "tokens=2" %%p in ('wmic process where "commandline like '%%server\\index.js%%' and commandline like '%%!INSTALL_DIR:\=\\!%%'" get processid 2^>nul ^| findstr /r "[0-9]"') do (
    taskkill /f /pid %%p >nul 2>&1
)
:: 兜底：也按端口查找
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":!SERVICE_PORT! " ^| findstr "LISTENING" 2^>nul') do (
    taskkill /f /pid %%p >nul 2>&1
)
timeout /t 2 /nobreak >nul
echo         Service stopped.
echo.

:: [U2] 检查 package.json 是否变化 → 决定是否 npm install
echo   [U2] Checking dependencies...

set "NEED_NPM=0"

:: 计算当前 package.json 的 hash
if exist "%INSTALL_DIR%\package.json" (
    for /f "tokens=*" %%h in ('certutil -hashfile "%INSTALL_DIR%\package.json" SHA256 2^>nul ^| findstr /v "hash" ^| findstr /v "CertUtil"') do (
        set "CURRENT_PKG_HASH=%%h"
    )
)

:: 读取上次安装时保存的 hash
set "SAVED_PKG_HASH="
if exist "%INSTALL_DIR%\.pkg-hash" (
    set /p SAVED_PKG_HASH=<"%INSTALL_DIR%\.pkg-hash"
)

:: 比较 hash
if not defined CURRENT_PKG_HASH (
    set "NEED_NPM=1"
    echo         package.json hash unavailable, will run npm install.
) else if not defined SAVED_PKG_HASH (
    set "NEED_NPM=1"
    echo         First update, will run npm install.
) else if "!CURRENT_PKG_HASH!" neq "!SAVED_PKG_HASH!" (
    set "NEED_NPM=1"
    echo         package.json changed, will run npm install.
) else (
    echo         Dependencies unchanged, skipping npm install.
)

if "!NEED_NPM!"=="1" (
    echo.
    echo         Running npm install...
    pushd "%INSTALL_DIR%"
    call npm install --omit=dev 2>&1
    if %errorlevel% neq 0 (
        echo.
        echo   [!] npm install failed. Check errors above.
        popd
        goto :end
    )
    popd
    echo         Dependencies installed.

    :: 保存 package.json hash
    if defined CURRENT_PKG_HASH (
        echo !CURRENT_PKG_HASH!> "%INSTALL_DIR%\.pkg-hash"
    )
)
echo.

:: [U3] 确保 start.bat 存在
echo   [U3] Checking startup script...
if not exist "%INSTALL_DIR%\start.bat" (
    echo         Creating start.bat...
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
) else (
    echo         start.bat exists, OK.
)
echo.

:: 保存端口
echo !SERVICE_PORT!> "%INSTALL_DIR%\.install-port"

:: [U4] 启动服务
echo   [U4] Starting service...
if "!SILENT!"=="1" (
    start "SharedBrowser" cmd /c "%INSTALL_DIR%\start.bat"
    timeout /t 3 /nobreak >nul
    echo         Service started on port !SERVICE_PORT!.
) else (
    set /p "START_NOW=   Start the service now? [Y/n]: "
    if /i "!START_NOW!"=="n" (
        echo.
        echo   Run start.bat when you're ready.
    ) else (
        start "SharedBrowser" cmd /c "%INSTALL_DIR%\start.bat"
        timeout /t 3 /nobreak >nul
        echo         Service started! Open http://localhost:!SERVICE_PORT!
    )
)

echo.
echo   ==========================================
echo    Update Complete!
echo   ==========================================
echo.
echo   URL:      http://localhost:!SERVICE_PORT!
echo.
goto :end

:: ============================================================
::  FULL INSTALL MODE
:: ============================================================

:full_install
echo.
echo   --- Full Install ---
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
if defined CLI_PORT (
    set "SERVICE_PORT=!CLI_PORT!"
) else (
    set "SERVICE_PORT=3000"
    set /p "SERVICE_PORT=      Port [default: 3000]: "
    if "!SERVICE_PORT!"=="" set "SERVICE_PORT=3000"
)
echo         Using port: !SERVICE_PORT!
echo.

:: ---------- 停止已运行的服务（如存在） ----------
if "!EXISTING_INSTALL!"=="1" (
    echo   [3.5] Stopping existing service...
    for /f "tokens=2" %%p in ('wmic process where "commandline like '%%server\\index.js%%' and commandline like '%%!INSTALL_DIR:\=\\!%%'" get processid 2^>nul ^| findstr /r "[0-9]"') do (
        taskkill /f /pid %%p >nul 2>&1
    )
    for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":!SERVICE_PORT! " ^| findstr "LISTENING" 2^>nul') do (
        taskkill /f /pid %%p >nul 2>&1
    )
    timeout /t 2 /nobreak >nul
    echo         Stopped.
    echo.
)

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

:: 保存 package.json hash（用于后续增量更新判断）
if exist "%INSTALL_DIR%\package.json" (
    for /f "tokens=*" %%h in ('certutil -hashfile "%INSTALL_DIR%\package.json" SHA256 2^>nul ^| findstr /v "hash" ^| findstr /v "CertUtil"') do (
        echo %%h> "%INSTALL_DIR%\.pkg-hash"
    )
)

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

:: 保存端口
echo !SERVICE_PORT!> "%INSTALL_DIR%\.install-port"

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
if "!SILENT!"=="0" pause

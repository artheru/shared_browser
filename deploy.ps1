# 共享浏览器部署脚本
# 用法: .\deploy.ps1 [-VehicleHelperUrl <url>] [-RemotePath <path>] [-ServicePort <port>]
# 功能: 构建前端、打包、通过 VehicleHelper API 上传到远程服务器并启动

param(
    [string]$VehicleHelperUrl = "http://192.168.0.190:9697",
    [string]$RemotePath = "C:\shared-browser",
    [int]$ServicePort = 3000,
    [string]$NodeDir = "C:\Program Files\nodejs"
)

$ErrorActionPreference = "Stop"

# ============== 辅助函数 ==============

function Write-Step($msg) {
    Write-Host "`n=== $msg ===" -ForegroundColor Cyan
}

function Write-OK($msg) {
    Write-Host "  $msg" -ForegroundColor Green
}

function Write-Warn($msg) {
    Write-Host "  $msg" -ForegroundColor Yellow
}

function Write-Err($msg) {
    Write-Host "  $msg" -ForegroundColor Red
}

function Invoke-VH($method, $endpoint, $body = $null, $contentType = "application/json") {
    $uri = "$VehicleHelperUrl$endpoint"
    $params = @{
        Uri = $uri
        Method = $method
        ContentType = $contentType
    }
    if ($body) {
        $params.Body = $body
    }
    try {
        return Invoke-RestMethod @params
    } catch {
        Write-Warn "请求失败: $method $endpoint - $_"
        return $null
    }
}

function Invoke-VH-Terminal($command, $waitSec = 3) {
    Write-Host "  > $command" -ForegroundColor DarkGray
    $body = @{ Command = $command } | ConvertTo-Json
    Invoke-VH "POST" "/api/ai/terminal/execute" $body | Out-Null
    Start-Sleep -Seconds $waitSec
    $result = Invoke-VH "GET" "/api/ai/terminal/output"
    if ($result) { return $result.Output }
    return ""
}

function Wait-VH-Terminal($maxWait = 60) {
    $elapsed = 0
    while ($elapsed -lt $maxWait) {
        Start-Sleep -Seconds 2
        $elapsed += 2
        $result = Invoke-VH "GET" "/api/ai/terminal/output"
        if ($result -and -not $result.IsRunning) {
            return $result.Output
        }
    }
    Write-Warn "等待超时 ($maxWait 秒)"
    $result = Invoke-VH "GET" "/api/ai/terminal/output"
    if ($result) { return $result.Output }
    return ""
}

# ============== Step 0: 检查 VehicleHelper 可用性 ==============

Write-Step "检查 VehicleHelper 连接"
try {
    $status = Invoke-RestMethod -Uri "$VehicleHelperUrl/version" -Method GET -TimeoutSec 5
    Write-OK "VehicleHelper 已连接: $status"
} catch {
    Write-Err "无法连接到 VehicleHelper: $VehicleHelperUrl"
    Write-Err "请确保 VehicleHelper 正在运行"
    exit 1
}

# ============== Step 1: 启用 AI API 和终端 ==============

Write-Step "启用 VehicleHelper AI API"
Invoke-VH "POST" "/api/ai/enable" '{}' | Out-Null
Start-Sleep -Seconds 1

$aiStatus = Invoke-VH "GET" "/api/ai/status"
if ($aiStatus -and $aiStatus.Enabled) {
    Write-OK "AI API 已启用"
} else {
    Write-Err "AI API 启用失败"
    exit 1
}

# 启动终端
Invoke-VH "POST" "/api/ai/terminal/start" '{}' | Out-Null
Start-Sleep -Seconds 2

$termStatus = Invoke-VH "GET" "/api/ai/terminal/output"
if ($termStatus) {
    Write-OK "AI Terminal 已启动"
} else {
    Write-Warn "终端启动状态未知，继续执行..."
}

# ============== Step 2: 生成版本号 + 构建前端 ==============

Write-Step "生成版本号"
$now = Get-Date
$versionStr = $now.ToString("yyyy.MM.dd-HHmmss")
$buildTime = $now.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
$versionJson = @{
    version = $versionStr
    buildTime = $buildTime
} | ConvertTo-Json
# Write UTF-8 without BOM (PowerShell's -Encoding UTF8 adds BOM which breaks JSON.parse)
[System.IO.File]::WriteAllText("$PSScriptRoot\version.json", $versionJson, (New-Object System.Text.UTF8Encoding $false))
Write-OK "Version: $versionStr"

Write-Step "构建前端"
Push-Location "$PSScriptRoot\client"
try {
    & npm run build 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "前端构建失败 (exit code: $LASTEXITCODE)"
    }
    Write-OK "前端构建完成"
} catch {
    Write-Err "前端构建失败: $_"
    Pop-Location
    exit 1
} finally {
    Pop-Location
}

# ============== Step 3: 打包部署文件 ==============

Write-Step "打包部署文件"
$zipPath = "$PSScriptRoot\deploy-package.zip"

# 删除旧包
if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
}

# 创建临时目录
$tempDir = "$PSScriptRoot\deploy-temp"
if (Test-Path $tempDir) {
    Remove-Item $tempDir -Recurse -Force
}
New-Item -ItemType Directory -Path $tempDir | Out-Null

# 复制 server 目录（排除 data 目录，避免覆盖远程配置）
Copy-Item "$PSScriptRoot\server" "$tempDir\server" -Recurse
if (Test-Path "$tempDir\server\data") {
    Remove-Item "$tempDir\server\data" -Recurse -Force
}

# 复制 client/dist
New-Item -ItemType Directory -Path "$tempDir\client" -Force | Out-Null
Copy-Item "$PSScriptRoot\client\dist" "$tempDir\client\dist" -Recurse -Force

# 复制 package.json 和 version.json
Copy-Item "$PSScriptRoot\package.json" "$tempDir\package.json"
Copy-Item "$PSScriptRoot\version.json" "$tempDir\version.json"
if (Test-Path "$PSScriptRoot\package-lock.json") {
    Copy-Item "$PSScriptRoot\package-lock.json" "$tempDir\package-lock.json"
}

# 复制 test-server（用于测试）
Copy-Item "$PSScriptRoot\test-server" "$tempDir\test-server" -Recurse
# 排除 test-server 中的临时文件
if (Test-Path "$tempDir\test-server\uploads") { Remove-Item "$tempDir\test-server\uploads" -Recurse -Force }
if (Test-Path "$tempDir\test-server\downloads") { Remove-Item "$tempDir\test-server\downloads" -Recurse -Force }
if (Test-Path "$tempDir\test-server\__pycache__") { Remove-Item "$tempDir\test-server\__pycache__" -Recurse -Force }

# 压缩
Compress-Archive -Path "$tempDir\*" -DestinationPath $zipPath -Force
Remove-Item $tempDir -Recurse -Force

$zipSize = (Get-Item $zipPath).Length
Write-OK "打包完成: deploy-package.zip ($([math]::Round($zipSize / 1MB, 2)) MB)"

# ============== Step 4: 检查远程环境 ==============

Write-Step "检查远程环境"

# 先将 Node 加入 PATH，再检查版本（避免因 PATH 缺失误判为未安装）
$output = Invoke-VH-Terminal "set `"PATH=%PATH%;$NodeDir`" & node --version" 3
if ($output -match "v(\d+)") {
    $nodeVer = $Matches[0]
    Write-OK "Node.js 已安装: $nodeVer"
} else {
    # 确认 node.exe 是否存在于默认路径
    $output = Invoke-VH-Terminal "if exist `"$NodeDir\node.exe`" (echo NODE_FOUND) else (echo NODE_NOT_FOUND)" 2
    if ($output -match "NODE_FOUND") {
        Write-OK "Node.js 已安装（在 $NodeDir）"
    } else {
        Write-Warn "Node.js 未安装，尝试安装..."
        Invoke-VH-Terminal "winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements" 5
        Start-Sleep -Seconds 30
        $installOutput = Wait-VH-Terminal 120

        # 验证安装
        $output = Invoke-VH-Terminal "set `"PATH=%PATH%;$NodeDir`" & node --version" 3
        if ($output -match "v\d+") {
            Write-OK "Node.js 安装成功: $($Matches[0])"
        } else {
            Write-Err "Node.js 安装失败，请手动安装"
            exit 1
        }
    }
}

# 检查 Chrome（直接检查文件存在，不依赖 PATH）
$output = Invoke-VH-Terminal 'if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" echo CHROME_FOUND' 2
if ($output -match "CHROME_FOUND") {
    Write-OK "Chrome 已安装"
} else {
    Write-Warn "Chrome 未安装，尝试安装..."
    Invoke-VH-Terminal "winget install Google.Chrome --accept-package-agreements --accept-source-agreements" 5
    Start-Sleep -Seconds 30
    Wait-VH-Terminal 120
    Write-OK "Chrome 安装完成"
}

# ============== Step 5: 上传部署包 ==============

Write-Step "上传部署包到远程服务器"

# 确保远程目录存在
Invoke-VH-Terminal "if not exist `"$RemotePath`" mkdir `"$RemotePath`"" 2

# 获取本地 IP
$localIP = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like "192.168.*" } | Select-Object -First 1).IPAddress
if (-not $localIP) {
    $localIP = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "127.*" } | Select-Object -First 1).IPAddress
}

Write-Host "  本地 IP: $localIP" -ForegroundColor DarkGray

# Method 1: Try curl.exe (native Windows curl, NOT PowerShell alias)
$uploadSuccess = $false
$curlExe = Get-Command curl.exe -ErrorAction SilentlyContinue
if ($curlExe) {
    try {
        Write-Host "  Trying VehicleHelper API upload via curl.exe..." -ForegroundColor DarkGray
        $curlResult = & curl.exe -s -w "%{http_code}" -X POST "$VehicleHelperUrl/api/files/upload" `
            -F "file=@$zipPath" `
            -F "path=$RemotePath" 2>&1
        if ($curlResult -match "200|success") {
            # Verify the file actually arrived
            $checkOutput = Invoke-VH-Terminal "if exist `"$RemotePath\deploy-package.zip`" echo DOWNLOAD_OK" 2
            if ($checkOutput -match "DOWNLOAD_OK") {
                $uploadSuccess = $true
                Write-OK "API upload successful"
            }
        }
    } catch {
        Write-Warn "API upload failed: $_"
    }
}

# Method 2: Try HTTP transfer if subnets allow
if (-not $uploadSuccess) {
    Write-Host "  Trying HTTP download (local server -> remote)..." -ForegroundColor DarkGray
    $httpPort = 19876
    $httpJob = Start-Job -ScriptBlock {
        param($dir, $port)
        Set-Location $dir
        & python -m http.server $port 2>&1
    } -ArgumentList $PSScriptRoot, $httpPort

    Start-Sleep -Seconds 2

    $downloadCmd = "powershell -Command `"Invoke-WebRequest -Uri 'http://${localIP}:${httpPort}/deploy-package.zip' -OutFile '${RemotePath}\deploy-package.zip' -UseBasicParsing -TimeoutSec 30`""
    Invoke-VH-Terminal $downloadCmd 5
    $output = Wait-VH-Terminal 60

    Stop-Job $httpJob -ErrorAction SilentlyContinue
    Remove-Job $httpJob -ErrorAction SilentlyContinue

    # Verify - must check file size to avoid using stale files
    $checkOutput = Invoke-VH-Terminal "if exist `"$RemotePath\deploy-package.zip`" echo DOWNLOAD_OK" 2
    if ($checkOutput -match "DOWNLOAD_OK") {
        $uploadSuccess = $true
        Write-OK "HTTP download successful"
    }
}

# Method 3: Base64 transfer via VehicleHelper terminal (most reliable, works across subnets)
if (-not $uploadSuccess) {
    Write-Host "  Using base64 transfer via terminal (reliable fallback)..." -ForegroundColor DarkGray

    $zipContent = [System.IO.File]::ReadAllBytes($zipPath)
    $base64 = [System.Convert]::ToBase64String($zipContent)
    $chunkSize = 6000
    $totalChunks = [math]::Ceiling($base64.Length / $chunkSize)

    Write-Host "  Sending $totalChunks chunks ($($base64.Length) chars)..." -ForegroundColor DarkGray

    # Clear existing temp file
    Invoke-VH-Terminal "if exist `"$RemotePath\deploy-package.b64`" del `"$RemotePath\deploy-package.b64`"" 2

    for ($i = 0; $i -lt $totalChunks; $i++) {
        $start = $i * $chunkSize
        $len = [math]::Min($chunkSize, $base64.Length - $start)
        $chunk = $base64.Substring($start, $len)
        $cmd = "powershell -Command `"Add-Content -Path '$RemotePath\deploy-package.b64' -Value '$chunk' -NoNewline`""
        $body = @{ Command = $cmd } | ConvertTo-Json
        Invoke-RestMethod -Uri "$VehicleHelperUrl/api/ai/terminal/execute" -Method POST -Body $body -ContentType "application/json" | Out-Null
        Start-Sleep -Seconds 2

        if (($i + 1) % 10 -eq 0 -or $i -eq $totalChunks - 1) {
            $pct = [math]::Round(($i + 1) / $totalChunks * 100)
            Write-Host "  Progress: $($i + 1)/$totalChunks ($pct%)" -ForegroundColor DarkGray
        }
    }

    Start-Sleep -Seconds 3

    # Decode base64 to zip
    $decodeCmd = "powershell -Command `"`$b64 = Get-Content '$RemotePath\deploy-package.b64' -Raw; [IO.File]::WriteAllBytes('$RemotePath\deploy-package.zip', [Convert]::FromBase64String(`$b64)); Write-Host 'DECODE_OK'`""
    $decodeOutput = Invoke-VH-Terminal $decodeCmd 10
    if ($decodeOutput -match "DECODE_OK") {
        $uploadSuccess = $true
        # Clean up b64 file
        Invoke-VH-Terminal "del `"$RemotePath\deploy-package.b64`"" 2
        Write-OK "Base64 transfer and decode successful"
    } else {
        Write-Err "Base64 decode failed"
        exit 1
    }
}

if (-not $uploadSuccess) {
    Write-Err "All transfer methods failed"
    exit 1
}

# ============== Step 6: 停止旧服务、解压、安装依赖 ==============

Write-Step "停止旧服务"
Invoke-VH-Terminal "taskkill /f /im node.exe 2>nul" 3
Write-OK "已尝试停止旧 Node.js 进程"

Write-Step "解压部署包"
$expandCmd = "powershell -Command `"Expand-Archive -Path '$RemotePath\deploy-package.zip' -DestinationPath '$RemotePath' -Force`""
Invoke-VH-Terminal $expandCmd 5
$output = Wait-VH-Terminal 60
Write-OK "解压完成"

# 清理 zip
Invoke-VH-Terminal "del `"$RemotePath\deploy-package.zip`"" 2

Write-Step "安装 npm 依赖"
Invoke-VH-Terminal "cd /d $RemotePath & set `"PATH=%PATH%;$NodeDir`" & npm install --production" 5
$output = Wait-VH-Terminal 120

if ($output -match "added|up to date|npm warn") {
    Write-OK "npm 依赖安装完成"
} else {
    Write-Warn "npm 安装输出: $($output.Substring(0, [Math]::Min(200, $output.Length)))"
}

# ============== Step 7: 启动服务 ==============

Write-Step "启动共享浏览器服务"

# 重置终端
Invoke-VH "POST" "/api/ai/terminal/reset" '{}' | Out-Null
Start-Sleep -Seconds 3
Invoke-VH "POST" "/api/ai/terminal/start" '{}' | Out-Null
Start-Sleep -Seconds 2

# 设置环境变量并启动（确保 Node.js 在 PATH 中）
$startCmd = "cd /d $RemotePath & set `"PATH=%PATH%;$NodeDir`" & set PORT=$ServicePort & node server/index.js"
Invoke-VH-Terminal $startCmd 3
Start-Sleep -Seconds 5

# 验证服务
Write-Step "验证服务"
$maxRetry = 5
$running = $false
for ($i = 1; $i -le $maxRetry; $i++) {
    try {
        $resp = Invoke-WebRequest -Uri "http://192.168.0.190:$ServicePort/api/auth/verify" -UseBasicParsing -TimeoutSec 5 -ErrorAction SilentlyContinue
        if ($resp.StatusCode -eq 401 -or $resp.StatusCode -eq 200) {
            $running = $true
            break
        }
    } catch {
        if ($_.Exception.Response.StatusCode -eq 401 -or $_.Exception.Response.StatusCode.value__ -eq 401) {
            $running = $true
            break
        }
    }
    Write-Host "  等待服务启动... ($i/$maxRetry)" -ForegroundColor DarkGray
    Start-Sleep -Seconds 3
}

if ($running) {
    Write-Host ""
    Write-Host "  ========================================" -ForegroundColor Green
    Write-Host "  ✓ Deploy SUCCESS!  v$versionStr" -ForegroundColor Green
    Write-Host "  URL:  http://192.168.0.190:$ServicePort" -ForegroundColor Green
    Write-Host "  Auth: admin / admin123" -ForegroundColor Green
    Write-Host "  ========================================" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "  服务启动验证超时，请手动检查:" -ForegroundColor Yellow
    Write-Host "  http://192.168.0.190:$ServicePort" -ForegroundColor Yellow

    # 获取终端输出用于调试
    $termOutput = Invoke-VH "GET" "/api/ai/terminal/output"
    if ($termOutput -and $termOutput.Output) {
        Write-Host "`n  终端输出:" -ForegroundColor DarkGray
        Write-Host $termOutput.Output
    }
}

# 清理本地临时文件
if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
}

Write-Host "`n部署脚本执行完毕！" -ForegroundColor Cyan

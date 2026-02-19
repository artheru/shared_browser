# ============================================================
#  Shared Browser 打包脚本
#  用法: .\build.ps1
#  输出: shared-browser.zip（可直接部署到目标机器）
# ============================================================

param(
    # Optional phrase for deploy verification (e.g. "jackie").
    # It will be embedded into version.json and the version string.
    [string]$Phrase = $env:SB_BUILD_PHRASE
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot

Write-Host ""
Write-Host "  Shared Browser - Build" -ForegroundColor Cyan
Write-Host "  ======================" -ForegroundColor Cyan
Write-Host ""

# ---------- 1. 生成版本号 ----------

$now = Get-Date
$versionStr = $now.ToString("yyyy.MM.dd-HHmmss")
$buildTime  = $now.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")

$phraseClean = ""
if ($Phrase) {
    # Allow only simple ASCII tokens to avoid quoting/encoding issues across Windows shells.
    $phraseClean = ($Phrase -replace '[^a-zA-Z0-9._-]', '').Trim()
}
if ($phraseClean) {
    $versionStr = "$versionStr-$phraseClean"
}

$versionJson = @{
    version   = $versionStr
    buildTime = $buildTime
    phrase    = $phraseClean
} | ConvertTo-Json

# 写入 UTF-8 无 BOM（避免 JSON.parse 失败）
[System.IO.File]::WriteAllText("$Root\version.json", $versionJson, (New-Object System.Text.UTF8Encoding $false))
Write-Host "  [1/4] Version: $versionStr" -ForegroundColor Green

# ---------- 2. 构建前端 ----------

Write-Host "  [2/4] Building frontend..." -ForegroundColor Yellow
Push-Location "$Root\client"
try {
    # 确保前端依赖已安装
    if (-not (Test-Path "node_modules")) {
        Write-Host "        Installing client dependencies..." -ForegroundColor DarkGray
        & npm install 2>&1 | Out-Null
    }
    & npm run build 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Frontend build failed (exit code: $LASTEXITCODE)" }
    Write-Host "  [2/4] Frontend build OK" -ForegroundColor Green
} finally {
    Pop-Location
}

# ---------- 3. 打包文件 ----------

Write-Host "  [3/4] Packaging..." -ForegroundColor Yellow

$zipPath = "$Root\shared-browser.zip"
$tempDir = "$Root\_build_temp"

# 清理
if (Test-Path $zipPath)  { Remove-Item $zipPath  -Force }
if (Test-Path $tempDir)  { Remove-Item $tempDir  -Recurse -Force }
New-Item -ItemType Directory -Path $tempDir | Out-Null

# server（排除 data 目录，保留用户数据）
Copy-Item "$Root\server" "$tempDir\server" -Recurse
if (Test-Path "$tempDir\server\data") { Remove-Item "$tempDir\server\data" -Recurse -Force }

# client/dist
New-Item -ItemType Directory -Path "$tempDir\client" -Force | Out-Null
Copy-Item "$Root\client\dist" "$tempDir\client\dist" -Recurse -Force

# 根目录文件
Copy-Item "$Root\package.json"     "$tempDir\package.json"
Copy-Item "$Root\version.json"     "$tempDir\version.json"
if (Test-Path "$Root\package-lock.json") {
    Copy-Item "$Root\package-lock.json" "$tempDir\package-lock.json"
}

# 安装脚本
if (Test-Path "$Root\install.bat") { Copy-Item "$Root\install.bat" "$tempDir\install.bat" }
if (Test-Path "$Root\install.sh")  { Copy-Item "$Root\install.sh"  "$tempDir\install.sh" }

# ---------- 4. 压缩 ----------

Compress-Archive -Path "$tempDir\*" -DestinationPath $zipPath -Force
Remove-Item $tempDir -Recurse -Force

$sizeMB = [math]::Round((Get-Item $zipPath).Length / 1MB, 2)
Write-Host "  [4/4] Done!" -ForegroundColor Green
Write-Host ""
Write-Host "  Output: shared-browser.zip ($sizeMB MB)" -ForegroundColor Cyan
Write-Host "  Deploy: copy zip to target machine, unzip, run install.bat" -ForegroundColor DarkGray
Write-Host ""

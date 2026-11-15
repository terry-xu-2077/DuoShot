# 打包绿色版：release\分镜对照-绿色版\分镜对照.exe
# 配置（settings.json）、所有分镜稿（drafts.json）、导出文件（exports\）都在运行时生成在 exe 旁边。
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Frontend = Join-Path $Root 'frontend'
$Manifest = Join-Path $Frontend 'src-tauri\Cargo.toml'
$BuiltExe = Join-Path $Frontend 'src-tauri\target\release\storyboard-compare.exe'
$OutDir = Join-Path $Root 'release\分镜对照-绿色版'

function Step([string]$Text) { Write-Host "`n==> $Text" -ForegroundColor Cyan }
function Fail([string]$Text) {
    Write-Host "`n[打包失败] $Text" -ForegroundColor Red
    if ([Environment]::UserInteractive -and -not $env:CI) { Read-Host '按回车键关闭' | Out-Null }
    exit 1
}

# 本机通常已把 cargo 装在用户目录；窗口里 PATH 没刷新时补上
$CargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if ((Test-Path $CargoBin) -and (($env:Path -split ';') -notcontains $CargoBin)) { $env:Path = "$CargoBin;$env:Path" }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail '没有找到 Node.js，请先安装。' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail '没有找到 npm，请先安装 Node.js。' }
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { Fail '没有找到 cargo，请先安装 Rust（https://rustup.rs）和 Microsoft C++ 生成工具。' }

Set-Location $Frontend

if (-not (Test-Path (Join-Path $Frontend 'node_modules'))) {
    Step '安装前端依赖'
    & npm install --package-lock=false
    if ($LASTEXITCODE -ne 0) { Fail '前端依赖安装失败。' }
}

if (-not (Test-Path (Join-Path $Frontend 'src-tauri\icons\icon.ico'))) {
    Step '生成应用图标'
    & npm run tauri -- icon 'src-tauri/app-icon.png' --output 'src-tauri/icons'
    if ($LASTEXITCODE -ne 0) { Fail '图标生成失败。' }
}

Step '构建前端（vite）'
& npm run build
if ($LASTEXITCODE -ne 0) { Fail '前端构建失败。' }

Step '编译 release exe（第一次需要几分钟）'
# 生产构建必须带 tauri/custom-protocol，否则窗口会去加载 devUrl（localhost:1420）而不是内置页面
& cargo build --release --features tauri/custom-protocol --manifest-path $Manifest
if ($LASTEXITCODE -ne 0) { Fail 'Rust 编译失败，请查看上面的报错。' }
if (-not (Test-Path $BuiltExe)) { Fail "没有找到编译产物：$BuiltExe" }

Step '整理绿色版文件夹'
# 原地覆盖 exe，不删文件夹：保留 exe 旁边的 settings.json / drafts.json / exports
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$Target = Join-Path $OutDir '分镜对照.exe'
try {
    Copy-Item $BuiltExe $Target -Force
} catch {
    Fail "无法覆盖 $Target ，请先关闭正在运行的「分镜对照」再重新打包。"
}

$SizeMB = [math]::Round((Get-Item $Target).Length / 1MB, 1)
Write-Host "`n完成！" -ForegroundColor Green
Write-Host "绿色版：$Target（$SizeMB MB）" -ForegroundColor Green
Write-Host '整个文件夹可以拷到任何地方，双击 exe 即可使用；重新打包不会动里面的数据文件。' -ForegroundColor DarkGray
if ([Environment]::UserInteractive -and -not $env:CI) { Read-Host '按回车键关闭' | Out-Null }

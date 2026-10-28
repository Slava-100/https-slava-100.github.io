# Запускает HTTPS-туннель к локальному серверу (http://localhost:3000),
# чтобы гости могли открыть мини-апп из Telegram.
#
# Использование (PowerShell, из папки проекта):
#   powershell -ExecutionPolicy Bypass -File tools\tunnel.ps1
#
# При первом запуске скачает cloudflared.exe (~30 МБ) в tools\bin.
# В консоли появится строка вида:
#   https://random-words-1234.trycloudflare.com
# Этот адрес вставь в .env (PUBLIC_URL, необязательно) и в BotFather
# как адрес Mini App / кнопки меню.

$ErrorActionPreference = 'Stop'

$dir = Join-Path $PSScriptRoot 'bin'
$exe = Join-Path $dir 'cloudflared.exe'

if (-not (Test-Path $exe)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Write-Host 'Скачиваю cloudflared (один раз, ~30 МБ)...' -ForegroundColor Yellow
    $url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe'
    Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing
    Write-Host 'Готово.' -ForegroundColor Green
}

Write-Host ''
Write-Host 'Поднимаю туннель. Ссылка появится ниже (строка с https://...trycloudflare.com).' -ForegroundColor Cyan
Write-Host 'Это окно должно оставаться открытым, пока идёт вечеринка.' -ForegroundColor DarkGray
Write-Host ''

& $exe tunnel --url http://localhost:3000 --protocol http2 --no-autoupdate

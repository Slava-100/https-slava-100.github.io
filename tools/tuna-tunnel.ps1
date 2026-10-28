# Starts a permanent free HTTPS tunnel to the local server (http://localhost:3000)
# using Tuna (tuna.am). The address is stable between restarts.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools\tuna-tunnel.ps1
#   powershell -ExecutionPolicy Bypass -File tools\tuna-tunnel.ps1 -Subdomain brave-otter-4821
#
# The subdomain is the permanent free one shown in https://my.tuna.am/domains
# (the client also prints it as a hint when run without -Subdomain).

param(
    [string]$Subdomain = '',
    [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'

# Kaspersky Endpoint Security intercepts TLS with its own root CA.
# Go binaries (tuna) do not trust it by default, so point them at the
# exported root certificate.
$cert = Join-Path $PSScriptRoot 'certs\kaspersky-root.pem'
if (Test-Path $cert) {
    $env:SSL_CERT_FILE = $cert
}

$exe = Join-Path $PSScriptRoot 'bin\tuna\tuna.exe'
if (-not (Test-Path $exe)) {
    throw "tuna.exe not found: $exe"
}

$args = @('http', "$Port", '--no-colors')
if ($Subdomain) {
    $args += "--subdomain=$Subdomain"
}

Write-Host ''
Write-Host 'Starting tunnel. Keep this window open during the party.' -ForegroundColor Cyan
Write-Host ''

& $exe @args

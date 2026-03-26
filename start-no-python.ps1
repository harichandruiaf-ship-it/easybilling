# Easy Billing - local static server (no Python / no Node required)
# Uses Windows PowerShell + .NET HttpListener

$ErrorActionPreference = "Stop"
$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$port = 8080

$mimes = @{
  ".html" = "text/html; charset=utf-8"
  ".htm"  = "text/html; charset=utf-8"
  ".css"  = "text/css; charset=utf-8"
  ".js"   = "application/javascript; charset=utf-8"
  ".mjs"  = "application/javascript; charset=utf-8"
  ".json" = "application/json; charset=utf-8"
  ".map"  = "application/json; charset=utf-8"
  ".png"  = "image/png"
  ".jpg"  = "image/jpeg"
  ".jpeg" = "image/jpeg"
  ".gif"  = "image/gif"
  ".webp" = "image/webp"
  ".svg"  = "image/svg+xml"
  ".ico"  = "image/x-icon"
  ".woff" = "font/woff"
  ".woff2"= "font/woff2"
  ".txt"  = "text/plain; charset=utf-8"
  ".xml"  = "application/xml; charset=utf-8"
  ".webmanifest" = "application/manifest+json; charset=utf-8"
}

function Get-SafePath {
  param([string]$UrlPath)
  $p = [Uri]::UnescapeDataString($UrlPath)
  if ($p -eq "/" -or [string]::IsNullOrWhiteSpace($p)) {
    return [System.IO.Path]::GetFullPath((Join-Path $root "index.html"))
  }
  $rel = $p.TrimStart("/").Replace("/", [IO.Path]::DirectorySeparatorChar)
  $full = [System.IO.Path]::GetFullPath((Join-Path $root $rel))
  $rootFull = [System.IO.Path]::GetFullPath($root)
  if (-not $full.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
    return $null
  }
  return $full
}

$prefix = "http://127.0.0.1:$port/"
$listener = New-Object System.Net.HttpListener
try {
  $listener.Prefixes.Add($prefix)
  $listener.Start()
} catch {
  Write-Host ""
  Write-Host "[ERROR] Could not start on $prefix"
  Write-Host $_.Exception.Message
  Write-Host "Try: run PowerShell as Administrator once, or edit start-no-python.ps1 and change port = 8080 to another port."
  Write-Host ""
  Read-Host "Press Enter to exit"
  exit 1
}

Write-Host ""
Write-Host "========================================"
Write-Host "  Easy Billing - local server (no Python)"
Write-Host "========================================"
Write-Host ""
Write-Host "  $prefix"
Write-Host "  Folder: $root"
Write-Host ""
Write-Host "  HOW TO STOP (pick one):" -ForegroundColor Yellow
Write-Host "    1) Click this window, press Ctrl+C (may need two presses)"
Write-Host "    2) Double-click STOP.bat in this folder (easiest)"
Write-Host "    3) Run: powershell -File stop-server.ps1"
Write-Host "========================================"
Write-Host ""

Start-Process $prefix

try {
  while ($listener.IsListening) {
    $ctx = $null
    try {
      $ctx = $listener.GetContext()
    } catch [System.Net.HttpListenerException] {
      break
    }
    if ($null -eq $ctx) { break }
    $req = $ctx.Request
    $res = $ctx.Response
    try {
      if ($req.HttpMethod -ne "GET" -and $req.HttpMethod -ne "HEAD") {
        $res.StatusCode = 405
        $res.Close()
        continue
      }

      $full = Get-SafePath $req.Url.LocalPath
      if ($null -eq $full) {
        $msg = [Text.Encoding]::UTF8.GetBytes("403 Forbidden")
        $res.StatusCode = 403
        $res.ContentType = "text/plain; charset=utf-8"
        $res.ContentLength64 = $msg.Length
        $res.OutputStream.Write($msg, 0, $msg.Length)
        $res.Close()
        continue
      }

      if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
        $res.StatusCode = 404
        $msg = [Text.Encoding]::UTF8.GetBytes("404 Not Found")
        $res.ContentType = "text/plain; charset=utf-8"
        $res.ContentLength64 = $msg.Length
        $res.OutputStream.Write($msg, 0, $msg.Length)
        $res.Close()
        continue
      }

      $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
      $ct = $mimes[$ext]
      if (-not $ct) { $ct = "application/octet-stream" }

      $bytes = [System.IO.File]::ReadAllBytes($full)
      $res.StatusCode = 200
      $res.ContentType = $ct
      $res.ContentLength64 = $bytes.Length
      if ($req.HttpMethod -eq "GET") {
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
      }
    } catch {
      try {
        $res.StatusCode = 500
      } catch { }
    } finally {
      try { $res.OutputStream.Close() } catch { }
      try { $res.Close() } catch { }
    }
  }
} finally {
  $listener.Stop()
  $listener.Close()
}

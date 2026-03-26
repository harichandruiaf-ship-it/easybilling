# Easy Billing - force-stop the local static server (same port as start-no-python.ps1)
$port = 8080
$found = $false
Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
  Where-Object { $_.State -eq 'Listen' } |
  ForEach-Object {
    $found = $true
    try {
      Stop-Process -Id $_.OwningProcess -Force
      Write-Host "Stopped process $($_.OwningProcess) (port $port)"
    } catch {
      Write-Host "Could not stop PID $($_.OwningProcess): $($_.Exception.Message)"
    }
  }
if (-not $found) {
  Write-Host "No process was listening on port $port."
  Write-Host "Server may already be stopped, or the port was changed in start-no-python.ps1."
}

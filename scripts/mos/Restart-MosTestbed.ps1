#Requires -Version 7.0
[CmdletBinding()]
param(
    [ValidateRange(1, 45)][int]$WaitSeconds = 45
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$processPath = Join-Path $workspaceRoot '.mos-testbed\process.json'
if (-not (Test-Path -LiteralPath $processPath -PathType Leaf)) {
    throw 'No saved MOS VM settings exist. Start the installed testbed before using Restart-MosTestbed.ps1.'
}

$savedRecord = Get-Content -Raw -LiteralPath $processPath
$record = $savedRecord | ConvertFrom-Json
if ($record.bootMode -ne 'Installed') {
    throw 'Restart-MosTestbed.ps1 supports the installed MOS testbed only. No shutdown command was sent.'
}
$memoryMiB = [int]$record.memoryMiB
$cpuCount = [int]$record.cpuCount
$accelerator = [string]$record.accelerator
if ($memoryMiB -lt 2048 -or $memoryMiB -gt 32768 -or
    $cpuCount -lt 1 -or $cpuCount -gt 8 -or
    $accelerator -notin @('whpx', 'tcg')) {
    throw 'The saved memory, CPU or accelerator settings are invalid. No shutdown command was sent.'
}

# WHPX can stall when UEFI is entered after a guest soft reboot. Shut MOS down
# normally, confirm that the verified QEMU process exited, then boot from disk.
# Stop-MosTestbed checks PID, executable, start time and RPC port ownership;
# its timeout is a terminating error, so an unconfirmed shutdown never reaches
# Start-MosTestbed and no forced process termination is used here.
& (Join-Path $PSScriptRoot 'Stop-MosTestbed.ps1') -WaitSeconds $WaitSeconds
if ((Get-Content -Raw -LiteralPath $processPath) -cne $savedRecord) {
    throw 'The MOS process record changed during shutdown. No replacement VM was started.'
}
& (Join-Path $PSScriptRoot 'Start-MosTestbed.ps1') -Mode Installed -MemoryMiB $memoryMiB -CpuCount $cpuCount -Accelerator $accelerator
& (Join-Path $PSScriptRoot 'Start-MosConsole.ps1')
Write-Output 'MOS cold boot was requested with the previous VM settings. Wait for the desktop at http://127.0.0.1:13600/.'

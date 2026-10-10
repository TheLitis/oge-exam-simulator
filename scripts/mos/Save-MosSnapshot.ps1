#Requires -Version 7.0
param([ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$')][string]$Name = 'ready-for-tests')
$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$stateRoot = Join-Path $workspaceRoot '.mos-testbed'
$processPath = Join-Path $stateRoot 'process.json'
if (Test-Path -LiteralPath $processPath) {
    $record = Get-Content -Raw -LiteralPath $processPath | ConvertFrom-Json
    if (Get-Process -Id $record.pid -ErrorAction SilentlyContinue) { throw 'Stop the VM before saving a disk snapshot.' }
}
$diskRoot = Join-Path $stateRoot 'disks'
$diskPath = Join-Path $diskRoot 'mos-system.qcow2'
$varsPath = Join-Path $diskRoot 'uefi-vars.fd'
$snapshotVarsPath = Join-Path $diskRoot "uefi-vars.$Name.fd"
if (Test-Path -LiteralPath $snapshotVarsPath) { throw 'A firmware snapshot with this name already exists. Use another name.' }
$qemuImg = Join-Path $stateRoot 'tools\qemu\qemu-img.exe'
& $qemuImg snapshot -c $Name $diskPath
if ($LASTEXITCODE -ne 0) { throw 'Could not save the disk snapshot.' }
Copy-Item -LiteralPath $varsPath -Destination $snapshotVarsPath
Write-Output "Saved offline disk and UEFI baseline: $Name"

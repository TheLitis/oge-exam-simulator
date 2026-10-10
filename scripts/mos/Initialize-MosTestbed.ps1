#Requires -Version 7.0
param()
$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$stateRoot = Join-Path $workspaceRoot '.mos-testbed'
$downloadRoot = Join-Path $stateRoot 'downloads'
$qemuRoot = Join-Path $stateRoot 'tools\qemu'
$consoleRoot = Join-Path $stateRoot 'tools\console'
$isoName = 'MOS_2021.1_MOS-V_x86_64_260926.iso'
$isoPath = Join-Path $downloadRoot $isoName
$expectedIsoHash = '043d2b52944698592e10c2f088a6ab501a602b75165fd0dbad0b17565764619c'
New-Item -ItemType Directory -Path $downloadRoot, $consoleRoot, (Join-Path $stateRoot 'evidence'), (Join-Path $stateRoot 'boot') -Force | Out-Null
if (-not (Test-Path -LiteralPath $isoPath)) {
    $partialPath = $isoPath + '.partial'
    & curl.exe --fail --location --retry 3 --output $partialPath 'https://hub.mos.ru/mos/iso/-/package_files/2009/download'
    if ($LASTEXITCODE -ne 0) { throw 'The official MOS ISO download failed.' }
    if ((Get-FileHash -LiteralPath $partialPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedIsoHash) { throw 'MOS ISO checksum mismatch.' }
    Move-Item -LiteralPath $partialPath -Destination $isoPath
}
if ((Get-Item -LiteralPath $isoPath).Length -ne 5371672576 -or (Get-FileHash -LiteralPath $isoPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedIsoHash) { throw 'MOS ISO size or checksum mismatch.' }
if (-not (Test-Path -LiteralPath (Join-Path $qemuRoot 'qemu-system-x86_64.exe'))) {
    & winget.exe install --id SoftwareFreedomConservancy.QEMU --exact --version 11.1.0 --source winget --silent --disable-interactivity --location $qemuRoot --log (Join-Path $stateRoot 'evidence\qemu-install.log')
    if ($LASTEXITCODE -ne 0) { throw 'QEMU installation failed.' }
}
$bootRoot = Join-Path $stateRoot 'boot'
if (-not (Test-Path -LiteralPath (Join-Path $bootRoot 'vmlinuz0')) -or -not (Test-Path -LiteralPath (Join-Path $bootRoot 'initrd0.img'))) {
    & tar.exe -xf $isoPath -C $bootRoot EFI/BOOT/grub.cfg vmlinuz0 initrd0.img
    if ($LASTEXITCODE -ne 0) { throw 'Could not extract the official live kernel.' }
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'console-package.json') -Destination (Join-Path $consoleRoot 'package.json')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'console-package-lock.json') -Destination (Join-Path $consoleRoot 'package-lock.json')
& npm.cmd ci --prefix $consoleRoot --ignore-scripts --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'Console dependency installation failed.' }
$configPath = Join-Path $stateRoot 'config.json'
if (-not (Test-Path -LiteralPath $configPath)) {
    [ordered]@{ mosVersion='12'; release='260926'; variant='MOS-V'; iso=$isoName; isoSha256=$expectedIsoHash; bootMode='Live' } | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding utf8NoBOM
}
Write-Output 'MOS 12 (260926) ISO verified; QEMU and local console prepared. Start-MosTestbed.ps1 boots the VM.'

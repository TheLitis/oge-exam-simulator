#Requires -Version 7.0
param(
    [ValidateSet('Auto', 'Live', 'Installed', 'Installer')][string]$Mode = 'Auto',
    [ValidateRange(2048, 32768)][int]$MemoryMiB = 8192,
    [ValidateRange(1, 8)][int]$CpuCount = 4,
    [ValidateSet('whpx', 'tcg')][string]$Accelerator = 'whpx'
)
$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$stateRoot = Join-Path $workspaceRoot '.mos-testbed'
$qemuRoot = Join-Path $stateRoot 'tools\qemu'
$qemuExe = Join-Path $qemuRoot 'qemu-system-x86_64.exe'
$isoPath = Join-Path $stateRoot 'downloads\MOS_2021.1_MOS-V_x86_64_260926.iso'
$diskRoot = Join-Path $stateRoot 'disks'
$diskPath = Join-Path $diskRoot 'mos-system.qcow2'
$varsPath = Join-Path $diskRoot 'uefi-vars.fd'
$configPath = Join-Path $stateRoot 'config.json'
$processPath = Join-Path $stateRoot 'process.json'
if (-not (Test-Path -LiteralPath $qemuExe)) { throw 'QEMU is missing. Initialize the testbed first.' }
if ($Mode -eq 'Auto') {
    $Mode = if (Test-Path -LiteralPath $configPath) { (Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json).bootMode } else { 'Live' }
    if ($Mode -notin @('Live', 'Installed', 'Installer')) { throw 'Invalid saved boot mode.' }
}
if (Test-Path -LiteralPath $processPath) {
    $previous = Get-Content -Raw -LiteralPath $processPath | ConvertFrom-Json
    $active = Get-Process -Id $previous.pid -ErrorAction SilentlyContinue
    if ($active -and $active.Path -eq $qemuExe -and $active.StartTime.ToUniversalTime().Ticks -eq ([datetime]$previous.startedAt).ToUniversalTime().Ticks) {
        Write-Output "MOS VM is already running (PID $($previous.pid)). Console: http://127.0.0.1:13600/"
        return
    }
}
$activeListeners = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
foreach ($port in @(14500, 14501, 15900, 22222)) {
    if ($activeListeners | Where-Object { $_.Port -eq $port }) { throw "Port $port is already occupied." }
}
New-Item -ItemType Directory -Path $diskRoot, (Join-Path $stateRoot 'evidence') -Force | Out-Null
if (-not (Test-Path -LiteralPath $diskPath)) {
    & (Join-Path $qemuRoot 'qemu-img.exe') create -f qcow2 $diskPath 64G
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the test disk.' }
}
if (-not (Test-Path -LiteralPath $varsPath)) {
    Copy-Item -LiteralPath (Join-Path $qemuRoot 'share\edk2-i386-vars.fd') -Destination $varsPath
}
$firmwarePath = Join-Path $qemuRoot 'share\edk2-x86_64-code.fd'
$acceleratorOption = if ($Accelerator -eq 'whpx') { 'whpx,kernel-irqchip=off' } else { 'tcg,thread=multi' }
# The VMware backdoor's vmmouse can take over input in relative mode. VNC
# needs the USB tablet's absolute coordinates to match the displayed desktop.
$vmArguments = @(
    '-name', 'MOS-OGE-260926', '-machine', 'q35,vmport=off', '-accel', $acceleratorOption,
    '-cpu', 'max', '-m', "$MemoryMiB", '-smp', "$CpuCount",
    '-drive', "if=pflash,format=raw,readonly=on,file=$firmwarePath",
    '-drive', "if=pflash,format=raw,file=$varsPath",
    '-drive', "if=virtio,format=qcow2,file=$diskPath",
    '-device', 'virtio-vga', '-device', 'qemu-xhci,id=xhci', '-device', 'usb-tablet,bus=xhci.0',
    '-netdev', 'user,id=net0,hostname=mos-testbed,hostfwd=tcp:127.0.0.1:22222-:22',
    '-device', 'virtio-net-pci,netdev=net0', '-device', 'virtio-serial-pci',
    '-chardev', 'socket,id=qga,host=127.0.0.1,port=14501,server=on,wait=off',
    '-device', 'virtserialport,chardev=qga,name=org.qemu.guest_agent.0',
    '-qmp', 'tcp:127.0.0.1:14500,server=on,wait=off', '-display', 'none',
    '-vnc', '127.0.0.1:10000', '-serial', ('file:' + (Join-Path $stateRoot 'evidence\serial.log'))
)
if ($Mode -ne 'Installed') {
    if (-not (Test-Path -LiteralPath $isoPath)) { throw 'MOS ISO is missing.' }
    $bootRoot = Join-Path $stateRoot 'boot'
    $kernelPath = Join-Path $bootRoot 'vmlinuz0'
    $initrdPath = Join-Path $bootRoot 'initrd0.img'
    if (-not (Test-Path -LiteralPath $kernelPath) -or -not (Test-Path -LiteralPath $initrdPath)) { throw 'Extract the official kernel and initrd before starting live mode.' }
    $kernelArguments = 'root=live:LABEL=MOS_2021.1_MOS-V_x86_64_260926 ro rd.live.image inst.lang=ru_RU.UTF-8 locale.LANG=ru_RU.UTF-8 locale.LANGUAGE=ru_RU.UTF-8 console=tty0 console=ttyS0,115200n8 systemd.wants=qemu-guest-agent.service'
    if ($Mode -eq 'Installer') { $kernelArguments += ' plymouth.enable=0 systemd.unit=anaconda.target inst.text inst.ks=http://10.0.2.2:13601/anaconda.ks' }
    $vmArguments += @('-drive', "media=cdrom,format=raw,readonly=on,file=$isoPath", '-kernel', $kernelPath, '-initrd', $initrdPath, '-append', $kernelArguments)
}
$quotedArguments = $vmArguments | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }
$qemuProcess = Start-Process -FilePath $qemuExe -ArgumentList $quotedArguments -WorkingDirectory $qemuRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $stateRoot 'evidence\qemu.stdout.log') -RedirectStandardError (Join-Path $stateRoot 'evidence\qemu.stderr.log') -PassThru
$processRecord = [ordered]@{ pid=$qemuProcess.Id; startedAt=$qemuProcess.StartTime.ToUniversalTime().ToString('o'); executable=$qemuExe; bootMode=$Mode; accelerator=$Accelerator; memoryMiB=$MemoryMiB; cpuCount=$CpuCount; console='http://127.0.0.1:13600/'; qmpPort=14500; qgaPort=14501; sshPort=22222; vncPort=15900 }
$processRecord | ConvertTo-Json | Set-Content -LiteralPath $processPath -Encoding utf8NoBOM
Write-Output "Started MOS VM: PID $($qemuProcess.Id), mode $Mode, accelerator $Accelerator. Console: http://127.0.0.1:13600/"

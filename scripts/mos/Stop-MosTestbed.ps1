#Requires -Version 7.0
[CmdletBinding()]
param(
    [switch]$StopConsole,
    [ValidateRange(1, 45)][int]$WaitSeconds = 45
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$stateRoot = Join-Path $workspaceRoot '.mos-testbed'
$processPath = Join-Path $stateRoot 'process.json'
$consoleRecordPath = Join-Path $stateRoot 'console-process.json'
$qemuExe = Join-Path $stateRoot 'tools\qemu\qemu-system-x86_64.exe'
$consoleScript = Join-Path $PSScriptRoot 'console.cjs'
$rpcScript = Join-Path $PSScriptRoot 'rpc.cjs'

function Get-VerifiedProcess {
    param($Record, [string]$ExpectedExecutable)
    if ([int]$Record.pid -le 0 -or -not $Record.startedAt -or -not $Record.executable) {
        throw 'The saved process record is incomplete. No process was stopped.'
    }
    if ([IO.Path]::GetFullPath([string]$Record.executable) -ine $ExpectedExecutable) {
        throw 'The saved record points to another executable. No process was stopped.'
    }
    $active = Get-Process -Id ([int]$Record.pid) -ErrorAction SilentlyContinue
    if (-not $active) { return $null }
    # Retain the native handle so later exit-status/Stop-Process operations refer
    # to this process instance even if Windows subsequently recycles its PID.
    $null = $active.Handle
    if ($active.Path -ine $ExpectedExecutable -or
        $active.StartTime.ToUniversalTime().Ticks -ne ([datetime]$Record.startedAt).ToUniversalTime().Ticks) {
        throw 'The recorded PID now belongs to another process. No process was stopped.'
    }
    return $active
}

function Assert-RpcOwner {
    param($Record, [int]$Port)
    $active = Get-VerifiedProcess -Record $Record -ExpectedExecutable $qemuExe
    if (-not $active) { throw 'The recorded VM already exited.' }
    $listeners = @(Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort $Port -ErrorAction SilentlyContinue)
    if ($listeners.Count -ne 1 -or $listeners[0].OwningProcess -ne $active.Id) {
        throw "RPC port 127.0.0.1:$Port is unavailable or belongs to another process."
    }
}

function Get-RpcTimeout {
    $remaining = [Math]::Floor(($deadline - [DateTime]::UtcNow).TotalMilliseconds)
    if ($remaining -le 0) {
        throw "Shutdown was not confirmed within $WaitSeconds seconds. The VM was not forcibly terminated."
    }
    return [int][Math]::Min(3000, $remaining)
}

function Invoke-TestbedRpc {
    param([string]$Kind, [string]$Command, [hashtable]$Arguments = @{}, [int]$TimeoutMs = 3000)
    # Structured arguments go directly to Node; no shell or command interpolation.
    $source = @'
const { rpc } = require(process.argv[1]);
const [kind, command, json, timeout] = process.argv.slice(2);
rpc(kind, command, JSON.parse(json), Number(timeout)).then(
  value => console.log(JSON.stringify({ ok: true, value })),
  error => {
    // QGA guest-shutdown intentionally sends no success response.
    // https://www.qemu.org/docs/master/interop/qemu-ga-ref.html#command-guest-shutdown
    const pending = kind === 'qga' && command === 'guest-shutdown' &&
      (error.message === 'qga connection closed.' || error.message === 'qga: guest-shutdown timed out.');
    console.log(JSON.stringify({ ok: pending, pending, error: error.message }));
    if (!pending) process.exitCode = 1;
  }
);
'@
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $nodeExe
    $startInfo.WorkingDirectory = $workspaceRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in @('--eval', $source, $rpcScript, $Kind, $Command, ($Arguments | ConvertTo-Json -Compress), [string]$TimeoutMs)) {
        $startInfo.ArgumentList.Add($argument)
    }
    $helper = [Diagnostics.Process]::new()
    $helper.StartInfo = $startInfo
    try {
        if (-not $helper.Start()) { throw 'Could not start the Node RPC helper.' }
        $stdoutTask = $helper.StandardOutput.ReadToEndAsync()
        $stderrTask = $helper.StandardError.ReadToEndAsync()
        if (-not $helper.WaitForExit($TimeoutMs + 2000)) {
            throw 'The RPC helper did not finish within its timeout; shutdown is not confirmed.'
        }
        $stdout = $stdoutTask.GetAwaiter().GetResult().Trim()
        $stderr = $stderrTask.GetAwaiter().GetResult().Trim()
        if (-not $stdout) { throw "The RPC helper returned no result. $stderr" }
        $result = $stdout | ConvertFrom-Json
        if (-not $result.ok) { throw "$Kind $Command failed: $($result.error)" }
        return $result
    } finally {
        $helper.Dispose()
    }
}

function Stop-RecordedConsole {
    if (-not (Test-Path -LiteralPath $consoleRecordPath)) {
        Write-Warning 'No console-process.json exists. The console was not stopped; use its original terminal.'
        return
    }
    $record = Get-Content -Raw -LiteralPath $consoleRecordPath | ConvertFrom-Json
    if (-not $record.script -or [IO.Path]::GetFullPath([string]$record.script) -ine $consoleScript -or
        [IO.Path]::GetFileName([string]$record.executable) -ine 'node.exe') {
        throw 'The saved console record does not describe this console. No console process was stopped.'
    }
    $expectedExe = [IO.Path]::GetFullPath([string]$record.executable)
    $active = Get-VerifiedProcess -Record $record -ExpectedExecutable $expectedExe
    if (-not $active) {
        Write-Output 'The recorded MOS console is already stopped.'
        return
    }
    $details = Get-CimInstance Win32_Process -Filter "ProcessId=$($active.Id)" -ErrorAction Stop
    $exeToken = [regex]::Escape($expectedExe)
    $scriptToken = [regex]::Escape($consoleScript)
    $expectedCommand = '^\s*(?:"' + $exeToken + '"|' + $exeToken + ')\s+(?:"' + $scriptToken + '"|' + $scriptToken + ')(?=\s|$)'
    if (-not $details -or $details.CommandLine -notmatch $expectedCommand) {
        throw 'The recorded node process is not running this console. No console process was stopped.'
    }
    # Recheck immediately before stopping only the explicitly requested console.
    $active = Get-VerifiedProcess -Record $record -ExpectedExecutable $expectedExe
    if ($active) {
        Stop-Process -InputObject $active -ErrorAction Stop
        if (-not $active.WaitForExit(5000)) { throw 'The console process has not exited yet.' }
        Write-Output "Stopped MOS console (PID $($record.pid))."
    }
}

if (-not (Test-Path -LiteralPath $processPath)) {
    Write-Output 'No recorded MOS VM exists; no VM shutdown command was sent.'
} else {
    $record = Get-Content -Raw -LiteralPath $processPath | ConvertFrom-Json
    $vmProcess = Get-VerifiedProcess -Record $record -ExpectedExecutable $qemuExe
    if (-not $vmProcess) {
        Write-Output 'The recorded MOS VM is already stopped.'
    } else {
        if ([int]$record.qmpPort -ne 14500 -or [int]$record.qgaPort -ne 14501) {
            throw 'Saved RPC ports differ from rpc.cjs. No shutdown command was sent.'
        }
        if (-not (Test-Path -LiteralPath $rpcScript -PathType Leaf)) { throw 'scripts/mos/rpc.cjs is missing.' }
        $nodeExe = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
        $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
        $method = ''
        try {
            Assert-RpcOwner -Record $record -Port 14501
            $null = Invoke-TestbedRpc -Kind qga -Command 'guest-ping' -TimeoutMs (Get-RpcTimeout)
            Assert-RpcOwner -Record $record -Port 14501
            $null = Invoke-TestbedRpc -Kind qga -Command 'guest-shutdown' -Arguments @{ mode = 'powerdown' } -TimeoutMs (Get-RpcTimeout)
            $method = 'QGA guest-shutdown'
        } catch {
            if (Get-VerifiedProcess -Record $record -ExpectedExecutable $qemuExe) {
                Write-Warning "QGA shutdown is unavailable: $($_.Exception.Message) Trying QMP system_powerdown."
                Assert-RpcOwner -Record $record -Port 14500
                $null = Invoke-TestbedRpc -Kind qmp -Command 'system_powerdown' -TimeoutMs (Get-RpcTimeout)
                $method = 'QMP system_powerdown'
            }
        }
        if ($method) { Write-Output "Requested $method; waiting for the verified VM process to exit." }
        while (Get-VerifiedProcess -Record $record -ExpectedExecutable $qemuExe) {
            if ([DateTime]::UtcNow -ge $deadline) {
                throw "MOS VM did not shut down within $WaitSeconds seconds. It was not forcibly terminated. Shut it down from its desktop and inspect the VM logs."
            }
            Start-Sleep -Milliseconds 250
        }
        $vmProcess.Refresh()
        if ($vmProcess.HasExited -and $vmProcess.ExitCode -ne 0) {
            throw "The VM process exited with code $($vmProcess.ExitCode). Inspect .mos-testbed/evidence/qemu.stderr.log."
        }
        Write-Output "MOS VM is stopped (recorded PID $($record.pid))."
    }
}

if ($StopConsole) { Stop-RecordedConsole }

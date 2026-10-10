#Requires -Version 7.0
[CmdletBinding()]
param(
    [ValidateRange(1, 30)][int]$WaitSeconds = 15
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$stateRoot = Join-Path $workspaceRoot '.mos-testbed'
$runtimeRoot = Join-Path $stateRoot 'tools\console'
$scriptPath = Join-Path $PSScriptRoot 'console.cjs'
$recordPath = Join-Path $stateRoot 'console-process.json'
$evidenceRoot = Join-Path $stateRoot 'evidence'
$consoleUrl = 'http://127.0.0.1:13600/'
$nodeExe = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source

function Get-VerifiedConsoleProcess {
    param($Record)
    if ([int]$Record.pid -le 0 -or -not $Record.startedAt -or -not $Record.executable -or -not $Record.script) {
        throw 'The saved console process record is incomplete.'
    }
    if ([IO.Path]::GetFullPath([string]$Record.script) -ne $scriptPath) {
        throw 'The saved record points to another console script. No process was changed.'
    }
    if ([IO.Path]::GetFileName([string]$Record.executable) -ine 'node.exe') {
        throw 'The saved console executable is not node.exe. No process was changed.'
    }
    $active = Get-Process -Id ([int]$Record.pid) -ErrorAction SilentlyContinue
    if (-not $active) { return $null }
    if ($active.Path -ine [IO.Path]::GetFullPath([string]$Record.executable) -or
        $active.StartTime.ToUniversalTime().Ticks -ne ([datetime]$Record.startedAt).ToUniversalTime().Ticks) {
        throw 'The saved console PID now belongs to another process. No process was changed.'
    }
    $details = Get-CimInstance Win32_Process -Filter "ProcessId=$($active.Id)" -ErrorAction Stop
    $exeToken = [regex]::Escape([string]$Record.executable)
    $scriptToken = [regex]::Escape($scriptPath)
    $expectedCommand = '^\s*(?:"' + $exeToken + '"|' + $exeToken + ')\s+(?:"' + $scriptToken + '"|' + $scriptToken + ')(?=\s|$)'
    if (-not $details -or $details.CommandLine -notmatch $expectedCommand) {
        throw 'The saved node process is not running this console script. No process was changed.'
    }
    return $active
}

function Test-ConsoleHealth {
    param([int]$ExpectedPid)
    $listeners = @(Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort 13600 -ErrorAction SilentlyContinue)
    if ($listeners.Count -ne 1 -or $listeners[0].OwningProcess -ne $ExpectedPid) { return $false }
    try {
        $health = Invoke-RestMethod -Uri ($consoleUrl + 'health') -TimeoutSec 2 -ErrorAction Stop
        return $health.status -eq 'ready' -and $health.vnc -eq '127.0.0.1:15900'
    } catch {
        return $false
    }
}

if (Test-Path -LiteralPath $recordPath) {
    $previous = Get-Content -Raw -LiteralPath $recordPath | ConvertFrom-Json
    $active = Get-VerifiedConsoleProcess -Record $previous
    if ($active) {
        if (-not (Test-ConsoleHealth -ExpectedPid $active.Id)) {
            throw "The verified console (PID $($active.Id)) is running but /health is unavailable. Check $evidenceRoot."
        }
        Write-Output "MOS console is already running (PID $($active.Id)): $consoleUrl"
        return
    }
}

foreach ($package in @('ws\package.json', '@novnc\novnc\package.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $runtimeRoot "node_modules\$package") -PathType Leaf)) {
        throw "Console dependencies are missing in $runtimeRoot. Install the pinned console-package.json dependencies first."
    }
}

$listeners = [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
if ($listeners | Where-Object { $_.Port -eq 13600 }) {
    throw 'Port 127.0.0.1:13600 is occupied by a process not recorded by this launcher. Stop that console in its original terminal, then run this script again.'
}

New-Item -ItemType Directory -Path $evidenceRoot -Force | Out-Null
$consoleArguments = @(('"' + $scriptPath + '"'), '--runtime-root', ('"' + $runtimeRoot + '"'), '--vnc-port', '15900')
$consoleProcess = Start-Process -FilePath $nodeExe -ArgumentList $consoleArguments -WorkingDirectory $workspaceRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $evidenceRoot 'console.stdout.log') -RedirectStandardError (Join-Path $evidenceRoot 'console.stderr.log') -PassThru
$record = [ordered]@{
    pid = $consoleProcess.Id
    startedAt = $consoleProcess.StartTime.ToUniversalTime().ToString('o')
    executable = [IO.Path]::GetFullPath($nodeExe)
    script = $scriptPath
    runtimeRoot = $runtimeRoot
    console = $consoleUrl
    vncPort = 15900
}
$record | ConvertTo-Json | Set-Content -LiteralPath $recordPath -Encoding utf8NoBOM

$deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
do {
    $active = Get-VerifiedConsoleProcess -Record $record
    if (-not $active) {
        throw "The console process exited before becoming ready. See $evidenceRoot\console.stderr.log."
    }
    if (Test-ConsoleHealth -ExpectedPid $active.Id) {
        Write-Output "Started MOS console (PID $($active.Id)): $consoleUrl"
        return
    }
    Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $deadline)

throw "The console did not become ready within $WaitSeconds seconds. Its process record was preserved; see $evidenceRoot\console.stderr.log."

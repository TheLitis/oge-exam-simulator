#Requires -Version 7.0
param()
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'Start-MosTestbed.ps1')
& (Join-Path $PSScriptRoot 'Start-MosConsole.ps1')
Start-Process 'http://127.0.0.1:13600/'

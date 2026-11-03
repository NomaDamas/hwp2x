$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Test-Path .venv)) { py -m venv .venv }
. .\.venv\Scripts\Activate.ps1
python -m pip install -e ".[windows,compare]"
hwp2x @args

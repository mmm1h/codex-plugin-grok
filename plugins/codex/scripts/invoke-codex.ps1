# Portable Codex launcher for Windows PowerShell / pwsh.
# Avoids bash-style stdin redirection (`codex ... - < file`) which fails on PowerShell.
#
# Examples:
#   .\invoke-codex.ps1 -Repo . -Prompt "status only"
#   .\invoke-codex.ps1 -Repo D:\proj -PromptFile .\tmp\codex-out\spec.md -Effort high -OutName job1.md
#   .\invoke-codex.ps1 -Repo . -PromptFile $env:TEMP\spec.md -ReadOnly

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Repo,

  [Parameter(Mandatory = $false)]
  [string]$Prompt,

  [Parameter(Mandatory = $false)]
  [string]$PromptFile,

  [Parameter(Mandatory = $false)]
  [string]$OutDir,

  [Parameter(Mandatory = $false)]
  [string]$OutName = "codex-out.md",

  [Parameter(Mandatory = $false)]
  [ValidateSet("none", "minimal", "low", "medium", "high", "xhigh", "max")]
  [string]$Effort = "medium",

  [Parameter(Mandatory = $false)]
  [string]$Profile = "codex-api",

  [Parameter(Mandatory = $false)]
  [switch]$ReadOnly,

  [Parameter(Mandatory = $false)]
  [string]$CodexCmd
)

$ErrorActionPreference = "Stop"

if (-not $Prompt -and -not $PromptFile) {
  throw "Provide -Prompt or -PromptFile."
}
if ($Prompt -and $PromptFile) {
  throw "Use only one of -Prompt or -PromptFile."
}

$repoPath = (Resolve-Path -LiteralPath $Repo).Path

if (-not $OutDir) {
  $OutDir = Join-Path $repoPath "tmp/codex-out"
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$outFile = Join-Path $OutDir $OutName

if (-not $CodexCmd) {
  $candidates = @(
    (Get-Command codex -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue),
    (Join-Path $env:APPDATA "npm\codex.cmd"),
    (Join-Path $env:APPDATA "npm\codex"),
    "codex"
  ) | Where-Object { $_ }
  $CodexCmd = $candidates | Where-Object {
    $_ -eq "codex" -or (Test-Path -LiteralPath $_)
  } | Select-Object -First 1
  if (-not $CodexCmd) {
    throw "codex CLI not found. Install with: npm install -g @openai/codex"
  }
}

$args = @(
  "exec",
  "--profile", $Profile,
  "-c", "model_reasoning_effort=$Effort",
  "-C", $repoPath,
  "-o", $outFile
)
if ($ReadOnly) {
  $args += @("-s", "read-only")
}

if ($PromptFile) {
  $promptPath = (Resolve-Path -LiteralPath $PromptFile).Path
  $args += "-"
  Write-Host "invoke-codex: piping $promptPath -> $CodexCmd $($args -join ' ')"
  Get-Content -Raw -LiteralPath $promptPath | & $CodexCmd @args
} else {
  $args += $Prompt
  Write-Host "invoke-codex: $CodexCmd $($args -join ' ')"
  # Close stdin so codex.ps1 / codex.cmd does not block on "Reading additional input from stdin..."
  $null | & $CodexCmd @args
}

$code = $LASTEXITCODE
if ($code -ne 0) {
  throw "codex exited with code $code"
}
Write-Host "invoke-codex: wrote $outFile"
exit 0

# Portable Codex launcher for Windows PowerShell / pwsh.
# Avoids bash-style stdin redirection (`codex ... - < file`) which fails on PowerShell.
#
# Also avoids PowerShell pipeline hangs when launching codex.cmd/codex.ps1 under Grok's
# Job Object (pipeline + npm wrappers can leave the outer shell "running" after Codex
# has already written -o and finished).
#
# Implementation notes:
# - Prefer `node codex.js` over npm's codex.cmd/ps1 wrappers.
# - Use ProcessStartInfo with redirected stdin only; inherit stdout/stderr so Grok sees
#   live output without PowerShell ScriptBlock OutputDataReceived (no runspace on
#   thread-pool callbacks).
# - Always close stdin after write.
# - Exit via [Environment]::Exit so the host process cannot linger.
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
  [ValidateSet("none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra")]
  [string]$Effort,

  [Parameter(Mandatory = $false)]
  [Alias("Profile")]
  [string]$CodexProfile,

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

function Resolve-NodeExe {
  $candidates = @()
  if ($env:GROK_NODE) { $candidates += $env:GROK_NODE }
  foreach ($name in @("node.exe", "node")) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { $candidates += $cmd.Source }
  }
  foreach ($path in @(
      (Join-Path ${env:ProgramFiles} "nodejs\node.exe"),
      $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe" } else { $null }),
      "D:\Program Files\nodejs\node.exe"
    )) {
    if ($path) { $candidates += $path }
  }
  return $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}

function Resolve-CodexJsFromWrapper {
  param([string]$WrapperPath)
  if (-not $WrapperPath) { return $null }
  $dir = Split-Path -Parent $WrapperPath
  $candidates = @(
    (Join-Path $dir "node_modules\@openai\codex\bin\codex.js"),
    (Join-Path $dir "..\node_modules\@openai\codex\bin\codex.js")
  )
  if ($env:APPDATA) {
    $candidates += (Join-Path $env:APPDATA "npm\node_modules\@openai\codex\bin\codex.js")
  }
  return $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}

function Resolve-CodexLaunch {
  param([string]$Preferred)

  # Prefer direct node + codex.js: no cmd/ps1 wrapper, no pipeline, clean process exit.
  $node = Resolve-NodeExe
  $jsCandidates = @()
  if ($Preferred -and $Preferred -match '\.js$') {
    $jsCandidates += $Preferred
  }
  if ($Preferred) {
    $fromWrapper = Resolve-CodexJsFromWrapper -WrapperPath $Preferred
    if ($fromWrapper) { $jsCandidates += $fromWrapper }
  }
  if ($env:APPDATA) {
    $jsCandidates += (Join-Path $env:APPDATA "npm\node_modules\@openai\codex\bin\codex.js")
  }
  $js = $jsCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  if ($node -and $js) {
    return [pscustomobject]@{
      FileName = $node
      PrefixArgs = @([string]$js)
      Display = "node `"$js`""
    }
  }

  if ($Preferred -and (Test-Path -LiteralPath $Preferred)) {
    return [pscustomobject]@{
      FileName = $Preferred
      PrefixArgs = @()
      Display = $Preferred
    }
  }

  $wrapperCandidates = @()
  if ($env:APPDATA) {
    $wrapperCandidates += Join-Path $env:APPDATA "npm\codex.cmd"
  }
  $wrapperCandidates += Get-Command codex.cmd -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue
  $wrapperCandidates += Get-Command codex -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue
  $wrapper = $wrapperCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  if (-not $wrapper) {
    throw "codex CLI not found. Install with: npm install -g @openai/codex"
  }
  return [pscustomobject]@{
    FileName = $wrapper
    PrefixArgs = @()
    Display = $wrapper
  }
}

function Invoke-CodexProcess {
  param(
    [Parameter(Mandatory = $true)][string]$FileName,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$ArgumentList,
    # $null => do not redirect stdin (prompt already on argv).
    # non-null string => write body then close stdin (PromptFile / "-").
    [Parameter(Mandatory = $false)][AllowEmptyString()][string]$StdinText = $null,
    [Parameter(Mandatory = $false)][switch]$UseStdin,
    [Parameter(Mandatory = $false)][string]$WorkingDirectory
  )

  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $FileName
  $psi.UseShellExecute = $false
  # Inherit stdout/stderr so Grok captures live Codex output without ScriptBlock
  # OutputDataReceived handlers (those crash: no Runspace on TP threads).
  $psi.RedirectStandardInput = [bool]$UseStdin
  $psi.RedirectStandardOutput = $false
  $psi.RedirectStandardError = $false
  $psi.CreateNoWindow = $true
  # Codex validates stdin as UTF-8; default Windows encoding would corrupt non-ASCII prompts.
  if ($UseStdin) {
    $psi.StandardInputEncoding = [System.Text.UTF8Encoding]::new($false)
  }
  if ($WorkingDirectory) {
    $psi.WorkingDirectory = $WorkingDirectory
  }
  foreach ($arg in $ArgumentList) {
    [void]$psi.ArgumentList.Add([string]$arg)
  }

  $proc = [System.Diagnostics.Process]::new()
  $proc.StartInfo = $psi

  if (-not $proc.Start()) {
    throw "Failed to start process: $FileName"
  }

  if ($UseStdin) {
    try {
      if ($null -ne $StdinText -and $StdinText.Length -gt 0) {
        # Write Unicode string through UTF-8 stdin encoding set above.
        $proc.StandardInput.Write($StdinText)
        if (-not $StdinText.EndsWith("`n")) {
          $proc.StandardInput.WriteLine()
        }
      }
    } finally {
      # Close promptly so Codex never blocks on "Reading additional input from stdin..."
      $proc.StandardInput.Close()
    }
  }

  $proc.WaitForExit()
  $exitCode = $proc.ExitCode
  $proc.Dispose()
  return $exitCode
}

$launch = Resolve-CodexLaunch -Preferred $CodexCmd

$codexArgs = [System.Collections.Generic.List[string]]::new()
foreach ($prefix in $launch.PrefixArgs) {
  [void]$codexArgs.Add([string]$prefix)
}
[void]$codexArgs.Add("exec")
if ($CodexProfile) {
  [void]$codexArgs.Add("--profile")
  [void]$codexArgs.Add([string]$CodexProfile)
}
if ($PSBoundParameters.ContainsKey("Effort")) {
  [void]$codexArgs.Add("-c")
  [void]$codexArgs.Add("model_reasoning_effort=$Effort")
}
# Always skip git-repo check: Grok/Claude workspaces are often non-git (home, TEMP).
[void]$codexArgs.Add("--skip-git-repo-check")
[void]$codexArgs.Add("-C")
[void]$codexArgs.Add([string]$repoPath)
[void]$codexArgs.Add("-o")
[void]$codexArgs.Add([string]$outFile)
if ($ReadOnly) {
  [void]$codexArgs.Add("-s")
  [void]$codexArgs.Add("read-only")
}

$useStdin = $false
$stdinText = $null
if ($PromptFile) {
  $promptPath = (Resolve-Path -LiteralPath $PromptFile).Path
  [void]$codexArgs.Add("-")
  $stdinText = [System.IO.File]::ReadAllText($promptPath, [System.Text.UTF8Encoding]::new($false))
  $useStdin = $true
  $argPreview = ($codexArgs | Select-Object -Skip $launch.PrefixArgs.Count) -join " "
  Write-Host "invoke-codex: process-stdin $promptPath -> $($launch.Display) $argPreview"
} else {
  [void]$codexArgs.Add([string]$Prompt)
  $argPreview = ($codexArgs | Select-Object -Skip $launch.PrefixArgs.Count) -join " "
  Write-Host "invoke-codex: $($launch.Display) $argPreview"
  # Prompt is on argv — do not redirect stdin (avoids "Reading additional input...").
}

$code = Invoke-CodexProcess -FileName $launch.FileName -ArgumentList $codexArgs.ToArray() -StdinText $stdinText -UseStdin:$useStdin -WorkingDirectory $repoPath

if ($code -ne 0) {
  [Console]::Error.WriteLine("invoke-codex: codex exited with code $code")
  # Force-terminate this pwsh so Grok's Job Object cannot stay "running" on a stuck runspace.
  [Environment]::Exit($code)
}

Write-Host "invoke-codex: wrote $outFile"
[Environment]::Exit(0)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = "Stop"
$Script:ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$Script:NodeExe = Join-Path $Script:ProjectRoot "runtime\node\node.exe"
$Script:NpmCmd = Join-Path $Script:ProjectRoot "runtime\node\npm.cmd"
$Script:ClipRoot = Join-Path $Script:ProjectRoot "bundle\clip"
$Script:BundledCpuPythonExe = Join-Path $Script:ProjectRoot "bundle\python-cpu\Scripts\python.exe"
$Script:ApiProcess = $null
$Script:WebProcess = $null

# Build one reusable launcher form so startup no longer needs a CLI window.
function New-LauncherForm {
  $form = New-Object System.Windows.Forms.Form
  $form.Text = "Auto Bundle Launcher"
  $form.Size = New-Object System.Drawing.Size(520, 360)
  $form.StartPosition = "CenterScreen"
  $form.BackColor = [System.Drawing.Color]::FromArgb(244, 247, 252)
  $form.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 9)

  $title = New-Object System.Windows.Forms.Label
  $title.Text = "Auto Bundle"
  $title.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 16, [System.Drawing.FontStyle]::Bold)
  $title.ForeColor = [System.Drawing.Color]::FromArgb(37, 55, 89)
  $title.Location = New-Object System.Drawing.Point(22, 18)
  $title.Size = New-Object System.Drawing.Size(220, 34)
  $form.Controls.Add($title)

  $subtitle = New-Object System.Windows.Forms.Label
  $subtitle.Text = "Port 3000 owns the backend. CLIP runs as a hidden worker. No CLI windows."
  $subtitle.ForeColor = [System.Drawing.Color]::FromArgb(104, 118, 140)
  $subtitle.Location = New-Object System.Drawing.Point(24, 54)
  $subtitle.Size = New-Object System.Drawing.Size(455, 22)
  $form.Controls.Add($subtitle)

  $log = New-Object System.Windows.Forms.TextBox
  $log.Multiline = $true
  $log.ReadOnly = $true
  $log.ScrollBars = "Vertical"
  $log.BorderStyle = "FixedSingle"
  $log.BackColor = [System.Drawing.Color]::White
  $log.ForeColor = [System.Drawing.Color]::FromArgb(55, 66, 84)
  $log.Location = New-Object System.Drawing.Point(24, 88)
  $log.Size = New-Object System.Drawing.Size(455, 165)
  $form.Controls.Add($log)

  $status = New-Object System.Windows.Forms.Label
  $status.Text = "Preparing startup..."
  $status.ForeColor = [System.Drawing.Color]::FromArgb(49, 95, 158)
  $status.Location = New-Object System.Drawing.Point(24, 264)
  $status.Size = New-Object System.Drawing.Size(455, 22)
  $form.Controls.Add($status)

  $openButton = New-Object System.Windows.Forms.Button
  $openButton.Text = "Open"
  $openButton.Location = New-Object System.Drawing.Point(232, 292)
  $openButton.Size = New-Object System.Drawing.Size(110, 28)
  $openButton.Enabled = $false
  $openButton.Add_Click({ Start-Process "http://127.0.0.1:5173" })
  $form.Controls.Add($openButton)

  $stopButton = New-Object System.Windows.Forms.Button
  $stopButton.Text = "Stop"
  $stopButton.Location = New-Object System.Drawing.Point(352, 292)
  $stopButton.Size = New-Object System.Drawing.Size(110, 28)
  $stopButton.Add_Click({ Stop-LocalServices })
  $form.Controls.Add($stopButton)

  $form | Add-Member -NotePropertyName LogBox -NotePropertyValue $log
  $form | Add-Member -NotePropertyName StatusLabel -NotePropertyValue $status
  $form | Add-Member -NotePropertyName OpenButton -NotePropertyValue $openButton
  return $form
}

# Append one timestamped status line to the visible launcher UI.
function Add-LauncherLog {
  param([System.Windows.Forms.Form]$Form, [string]$Message)
  $callback = [System.Action[System.Windows.Forms.Form,string]]{
    param($TargetForm, $Text)
    $TargetForm.LogBox.AppendText(("[" + (Get-Date -Format "HH:mm:ss") + "] " + $Text + [Environment]::NewLine))
    $TargetForm.StatusLabel.Text = $Text
  }
  $Form.BeginInvoke($callback, @($Form, $Message)) | Out-Null
}

# Run one setup command hidden and wait for its exit code.
function Invoke-HiddenSetupCommand {
  param([string]$FilePath, [string]$Arguments)
  $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $Script:ProjectRoot -WindowStyle Hidden -PassThru -Wait
  return [int]$process.ExitCode
}

# Start one long-running service hidden and remember its process.
function Start-HiddenService {
  param([string]$FilePath, [string]$Arguments)
  return Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $Script:ProjectRoot -WindowStyle Hidden -PassThru
}

# Stop every stale listener on one local TCP port using netstat and taskkill.
function Stop-PortListener {
  param([int]$Port)
  $lines = netstat -ano -p tcp | Select-String -Pattern (":" + $Port + " .*LISTENING")
  foreach ($line in $lines) {
    $parts = ($line.ToString() -split "\s+") | Where-Object { $_ }
    $pidText = $parts[$parts.Length - 1]
    if ($pidText -match "^\d+$") {
      taskkill /PID ([int]$pidText) /T /F | Out-Null
    }
  }
}

# Wait until one HTTP endpoint responds or the timeout expires.
function Wait-HttpReady {
  param([string]$Url, [int]$Seconds)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2 | Out-Null
      return $true
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  return $false
}

# Resolve the Python executable used by the bundled CLIP worker.
function Resolve-ClipPythonCommand {
  if (Test-Path $Script:BundledCpuPythonExe) {
    return $Script:BundledCpuPythonExe
  }
  if (Test-Path $Script:BundledVenvPythonExe) {
    return $Script:BundledVenvPythonExe
  }
  if (Test-Path $Script:BundledPortablePythonExe) {
    return $Script:BundledPortablePythonExe
  }
  $pyCommand = Get-Command py -ErrorAction SilentlyContinue
  if ($pyCommand) {
    return "py"
  }
  $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
  if ($pythonCommand) {
    return "python"
  }
  throw "Missing Python runtime. Put venv at bundle\python-cpu or install Python."
}

# Verify the CLIP bundle contains every runtime file the worker needs.
function Test-ClipBundle {
  $required = @(
    "work\stdio_listing_worker.py",
    "work\full_listing_server.py",
    "models\open_clip_pytorch_model.bin",
    "data\yunqi_clip_training\last_checkpoint.pt",
    "data\full_listing_index\products_listing.index",
    "data\full_clip_index\products_full_prices.json"
  )
  foreach ($relativePath in $required) {
    $target = Join-Path $Script:ClipRoot $relativePath
    if (-not (Test-Path $target)) {
      throw ("Missing CLIP bundle file: " + $target)
    }
  }
  $runtimeMeta = Join-Path $Script:ClipRoot "data\full_listing_index\products_listing_meta.runtime.json"
  $originalMeta = Join-Path $Script:ClipRoot "data\full_listing_index\products_listing_meta.json"
  if ((-not (Test-Path $runtimeMeta)) -and (-not (Test-Path $originalMeta))) {
    throw ("Missing CLIP listing metadata: " + $runtimeMeta)
  }
}

# Stop the hidden services started by this launcher and release old ports.
function Stop-LocalServices {
  if ($Script:ApiProcess -and -not $Script:ApiProcess.HasExited) {
    Stop-Process -Id $Script:ApiProcess.Id -Force
  }
  if ($Script:WebProcess -and -not $Script:WebProcess.HasExited) {
    Stop-Process -Id $Script:WebProcess.Id -Force
  }
  Stop-PortListener -Port 3000
  Stop-PortListener -Port 5173
}

# Perform startup steps in the background so the UI remains responsive.
function Start-LauncherWork {
  param([System.Windows.Forms.Form]$Form)
  $worker = New-Object System.ComponentModel.BackgroundWorker
  $worker.add_DoWork({
    try {
      Add-LauncherLog $Form "Checking runtime..."
      if (-not (Test-Path $Script:NodeExe)) { throw "Missing runtime\node\node.exe" }
      if (-not (Test-Path $Script:NpmCmd)) { throw "Missing runtime\node\npm.cmd" }
      Test-ClipBundle
      $clipPython = Resolve-ClipPythonCommand
      Add-LauncherLog $Form ("CLIP bundle ready. Python: " + $clipPython)

      Add-LauncherLog $Form "Preparing external cache..."
      $code = Invoke-HiddenSetupCommand -FilePath $Script:NodeExe -Arguments "`"server\scripts\prepare-external-cache.js`""
      if ($code -ne 0) { throw "Cache preparation failed, exit code $code" }

      if (-not (Test-Path (Join-Path $Script:ProjectRoot "node_modules\.package-lock.json"))) {
        Add-LauncherLog $Form "Installing dependencies..."
        $installCode = Invoke-HiddenSetupCommand -FilePath $Script:NpmCmd -Arguments "install"
        if ($installCode -ne 0) { throw "npm install failed, exit code $installCode" }
      }

      Add-LauncherLog $Form "Cleaning old ports 3000 / 5173 / 9990..."
      Stop-PortListener -Port 3000
      Stop-PortListener -Port 5173
      Stop-PortListener -Port 9990

      Add-LauncherLog $Form "Starting backend on port 3000..."
      $Script:ApiProcess = Start-HiddenService -FilePath $Script:NodeExe -Arguments "`"server\server.js`""

      Add-LauncherLog $Form "Starting workbench UI..."
      $Script:WebProcess = Start-HiddenService -FilePath $Script:NpmCmd -Arguments "run dev:web"

      Add-LauncherLog $Form "Waiting for services..."
      Wait-HttpReady -Url "http://127.0.0.1:3000/api/v1/config" -Seconds 30 | Out-Null
      Wait-HttpReady -Url "http://127.0.0.1:5173" -Seconds 30 | Out-Null

      Add-LauncherLog $Form "Ready. Opening workbench."
      $enableOpenButton = [System.Action[System.Windows.Forms.Form]]{ param($TargetForm) $TargetForm.OpenButton.Enabled = $true }
      $Form.BeginInvoke($enableOpenButton, @($Form)) | Out-Null
      Start-Process "http://127.0.0.1:5173"
    } catch {
      Add-LauncherLog $Form ("Startup failed: " + $_.Exception.Message)
    }
  })
  $worker.RunWorkerAsync()
}

$Form = New-LauncherForm
$Form.Add_Shown({ Start-LauncherWork -Form $Form })
[void]$Form.ShowDialog()

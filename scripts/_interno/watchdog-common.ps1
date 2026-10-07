function Get-WatchdogLogLength {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return [long]0 }
  return [long](Get-Item -LiteralPath $Path).Length
}

function ConvertFrom-ScheduledTaskDuration {
  param([Parameter(Mandatory = $true)]$Value)
  if ($Value -is [TimeSpan]) { return $Value }
  try {
    return [System.Xml.XmlConvert]::ToTimeSpan([string]$Value)
  } catch {
    throw "Duracion invalida en la tarea programada: $Value"
  }
}

function Assert-BridgeWatchdog {
  param(
    [Parameter(Mandatory = $true)][string]$TaskName,
    [Parameter(Mandatory = $true)][string]$WrapperPath,
    [Parameter(Mandatory = $true)][string]$BridgePath,
    [string]$HealthUri = '',
    [string]$LogPath = '',
    [long]$LogOffset = -1,
    [int]$StartupTimeoutSeconds = 15
  )

  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  if ([string]$task.State -notin @('Ready', 'Running')) {
    throw "Watchdog invalido: tarea $TaskName en estado $($task.State), se esperaba Ready o Running."
  }

  if ([int]$task.Settings.RestartCount -ne 3) {
    throw "Watchdog invalido: RestartCount=$($task.Settings.RestartCount), se esperaba 3."
  }
  $restartInterval = ConvertFrom-ScheduledTaskDuration $task.Settings.RestartInterval
  if ($restartInterval -ne (New-TimeSpan -Minutes 1)) {
    throw "Watchdog invalido: RestartInterval=$restartInterval, se esperaba 1 minuto."
  }
  $executionLimit = ConvertFrom-ScheduledTaskDuration $task.Settings.ExecutionTimeLimit
  if ($executionLimit -ne [TimeSpan]::Zero) {
    throw "Watchdog invalido: ExecutionTimeLimit=$executionLimit, se esperaba 0 (ilimitado)."
  }
  if ($task.Settings.DisallowStartIfOnBatteries -or $task.Settings.StopIfGoingOnBatteries) {
    throw "Watchdog invalido: la tarea no debe bloquearse ni detenerse por uso de bateria."
  }
  if (-not $task.Settings.StartWhenAvailable) {
    throw "Watchdog invalido: StartWhenAvailable debe estar activo."
  }

  $triggers = @($task.Triggers)
  $startupTrigger = $triggers | Where-Object {
    $_.CimClass.CimClassName -eq 'MSFT_TaskBootTrigger'
  } | Select-Object -First 1
  $dailyTrigger = $triggers | Where-Object {
    $_.CimClass.CimClassName -eq 'MSFT_TaskDailyTrigger'
  } | Select-Object -First 1
  if (-not $startupTrigger) {
    throw "Watchdog invalido: falta el trigger de inicio de Windows."
  }
  if (-not $dailyTrigger -or [int]$dailyTrigger.DaysInterval -ne 1) {
    throw "Watchdog invalido: falta el trigger diario de rearme."
  }
  $dailyStart = [datetime]$dailyTrigger.StartBoundary
  if ($dailyStart.Hour -ne 4 -or $dailyStart.Minute -ne 0) {
    throw "Watchdog invalido: el trigger diario debe ejecutarse a las 04:00."
  }

  $principal = [string]$task.Principal.UserId
  if ($principal -notin @('SYSTEM', 'NT AUTHORITY\SYSTEM')) {
    throw "Watchdog invalido: principal=$principal, se esperaba SYSTEM."
  }

  $expectedAction = [IO.Path]::GetFullPath($WrapperPath).TrimEnd('\')
  $actions = @($task.Actions)
  $matchingAction = $actions | Where-Object {
    $execute = [Environment]::ExpandEnvironmentVariables(([string]$_.Execute).Trim('"'))
    try {
      [IO.Path]::GetFullPath($execute).TrimEnd('\') -ieq $expectedAction
    } catch {
      $false
    }
  }
  if (-not $matchingAction) {
    throw "Watchdog invalido: la accion no ejecuta $expectedAction."
  }

  $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
  $process = $null
  $freshLog = ($LogOffset -lt 0)
  $health = $null
  do {
    $process = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
      Where-Object {
        $_.CommandLine -and $_.CommandLine.IndexOf($BridgePath, [StringComparison]::OrdinalIgnoreCase) -ge 0
      } |
      Select-Object -First 1

    if (-not $freshLog -and $LogPath -and (Test-Path -LiteralPath $LogPath)) {
      $freshLog = (Get-WatchdogLogLength -Path $LogPath) -gt $LogOffset
    }

    if ($HealthUri) {
      try {
        $health = Invoke-RestMethod -Uri $HealthUri -TimeoutSec 5
      } catch {
        $health = $null
      }
    }

    $healthy = $process -and $freshLog -and ((-not $HealthUri) -or $health)
    if (-not $healthy) { Start-Sleep -Milliseconds 500 }
  } while (-not $healthy -and (Get-Date) -lt $deadline)

  if (-not $process) {
    throw "Watchdog invalido: no existe node.exe ejecutando $BridgePath."
  }
  if (-not $freshLog) {
    throw "Watchdog invalido: $LogPath no recibio lineas nuevas despues del arranque."
  }
  if ($HealthUri -and -not $health) {
    throw "Watchdog invalido: fallo el health obligatorio $HealthUri."
  }

  Write-Host ("OK watchdog: {0} ({1}), PID {2}, restart 3 x 1 min, sin limite de ejecucion." -f $TaskName, $task.State, $process.ProcessId) -ForegroundColor Green
  if ($HealthUri) {
    Write-Host ("OK health: {0}" -f $HealthUri) -ForegroundColor Green
  }
  return [pscustomobject]@{
    Task = $task
    Process = $process
    Health = $health
  }
}

# Misma decision que scripts/lib/watchdogSettings.js (nextStationHealthState).
# No duplicar el conteo aca: si cambia el tope, se cambia en un solo lugar.
function Get-NextStationHealthState {
  param(
    [int]$ConsecutiveFailures = 0,
    [bool]$Responded = $false,
    [int]$FailureThreshold = 3
  )

  $lib = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\lib\watchdogSettings.js'))
  $nodeCmd = Get-Command node -ErrorAction Stop
  $json = (@{
    consecutiveFailures = $ConsecutiveFailures
    responded = [bool]$Responded
    failureThreshold = $FailureThreshold
  } | ConvertTo-Json -Compress)

  $output = $json | & $nodeCmd.Source $lib next-station-health
  if ($LASTEXITCODE -ne 0 -or -not $output) {
    throw "watchdogSettings.js no pudo decidir el estado de salud de la estacion"
  }
  return ($output | ConvertFrom-Json)
}

function Write-StationHealthLog {
  param(
    [Parameter(Mandatory = $true)][string]$LogPath,
    [Parameter(Mandatory = $true)][string]$Message
  )
  $line = "{0} {1}" -f (Get-Date).ToString('o'), $Message
  Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
}

function Save-StationHealthState {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$State
  )
  $utf8 = New-Object System.Text.UTF8Encoding $false
  $tmp = "$Path.$PID.tmp"
  [IO.File]::WriteAllText($tmp, (($State | ConvertTo-Json -Compress) + "`n"), $utf8)
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Force
  }
  Move-Item -LiteralPath $tmp -Destination $Path
}

function Test-HttpEndpointResponded {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [hashtable]$Headers = @{},
    [int]$TimeoutSec = 5
  )
  try {
    $params = @{
      Uri = $Uri
      Method = 'GET'
      TimeoutSec = $TimeoutSec
      UseBasicParsing = $true
    }
    if ($Headers.Count -gt 0) { $params.Headers = $Headers }
    Invoke-WebRequest @params | Out-Null
    return $true
  } catch {
    # Cualquier respuesta HTTP (401, 500, etc.) significa que el proceso sigue vivo.
    # Timeout o conexion rechazada no traen Response: eso es cuelgue o caida.
    return [bool]$_.Exception.Response
  }
}

function Invoke-NssmHttpHealthWatch {
  param(
    [Parameter(Mandatory = $true)][string]$ServiceName,
    [Parameter(Mandatory = $true)][string]$HealthUri,
    [hashtable]$Headers = @{},
    [int]$FailureThreshold = 3,
    [Parameter(Mandatory = $true)][string]$StatePath,
    [Parameter(Mandatory = $true)][string]$NssmPath,
    [Parameter(Mandatory = $true)][string]$LogPath,
    [int]$TimeoutSec = 5
  )

  $consecutive = 0
  if (Test-Path -LiteralPath $StatePath) {
    try {
      $prev = Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
      $consecutive = [int]$prev.consecutiveFailures
    } catch {
      $consecutive = 0
    }
  }

  $responded = Test-HttpEndpointResponded -Uri $HealthUri -Headers $Headers -TimeoutSec $TimeoutSec
  $decision = Get-NextStationHealthState `
    -ConsecutiveFailures $consecutive `
    -Responded $responded `
    -FailureThreshold $FailureThreshold

  Save-StationHealthState -Path $StatePath -State @{
    serviceName = $ServiceName
    consecutiveFailures = [int]$decision.consecutiveFailures
    updatedAt = (Get-Date).ToString('o')
    lastResult = $(if ($responded) { 'ok' } else { 'fail' })
  }

  if (-not $decision.shouldRestart) {
    if (-not $responded) {
      Write-StationHealthLog -LogPath $LogPath -Message (
        "Sin respuesta de $HealthUri ($($decision.consecutiveFailures)/$FailureThreshold)."
      )
    }
    return $decision
  }

  Write-StationHealthLog -LogPath $LogPath -Message (
    "Sin respuesta de $HealthUri $FailureThreshold veces seguidas. Reiniciando servicio $ServiceName."
  )
  # NSSM escribe en stderr aunque el restart haya salido bien.
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $restartOut = & $NssmPath restart $ServiceName 2>&1
  $restartCode = $LASTEXITCODE
  $ErrorActionPreference = $prevEap
  if ($restartCode -ne 0) {
    $text = (($restartOut | ForEach-Object { "$_" }) -join ' ') -replace "`0", ''
    throw "nssm restart $ServiceName fallo (exit $restartCode): $text"
  }
  Write-StationHealthLog -LogPath $LogPath -Message "Pedido de reinicio enviado a $ServiceName."
  return $decision
}

function Register-EstacionHealthWatch {
  param(
    [Parameter(Mandatory = $true)][string]$ScriptsDir
  )

  $watchScript = Join-Path $PSScriptRoot 'vigilar-estacion.ps1'
  if (-not (Test-Path -LiteralPath $watchScript)) {
    throw "Falta $watchScript"
  }

  $taskName = 'MSSGuard-Estacion-Watchdog'
  $arg = "-NoProfile -ExecutionPolicy Bypass -File `"$watchScript`""
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg
  $repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
    -RepetitionInterval (New-TimeSpan -Minutes 1) `
    -RepetitionDuration (New-TimeSpan -Days 9999)
  $boot = New-ScheduledTaskTrigger -AtStartup
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

  Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger @($boot, $repeat) `
    -Settings $settings `
    -Principal $principal `
    -Description "Si http://127.0.0.1:<puerto>/status de la estacion no responde 3 veces seguidas, reinicia el servicio NSSM." `
    -Force | Out-Null

  Write-Host "Control de cuelgue registrado: $taskName (cada 1 min, 3 fallos seguidos reinician el servicio)." -ForegroundColor Green
  Write-Host "  Script: $watchScript"
  Write-Host "  Carpeta: $ScriptsDir"
}

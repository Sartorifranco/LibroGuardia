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

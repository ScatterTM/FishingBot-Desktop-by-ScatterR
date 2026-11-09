-- Fishingbot Desktop OBS launcher (Windows).
-- This script launches Fishingbot only if the configured executable is not already running.
-- It records a PID only for a process it started, so OBS will not close an app the user opened.
obs = obslua

local config = {
  exe_path = '',
  launch_on_start = true,
  close_on_obs_exit = false,
}
local launch_attempted = false
local launched_pid = nil
local close_handled = false
local launch_timer = nil

local function log(level, message)
  obs.script_log(level, '[Fishingbot OBS] ' .. tostring(message))
end

local function ps_quote(value)
  return "'" .. tostring(value or ''):gsub("'", "''") .. "'"
end

local function app_data_dir()
  local base = os.getenv('APPDATA') or os.getenv('TEMP') or '.'
  return base .. '\\Fishingbot'
end

local function ensure_dir(dir)
  -- APPDATA is an OS-controlled path; quote it so spaces remain safe for cmd.exe.
  os.execute('if not exist "' .. dir .. '" mkdir "' .. dir .. '" >NUL 2>NUL')
end

local function write_text(file_path, content)
  local f, err = io.open(file_path, 'w')
  if not f then
    log(obs.LOG_ERROR, 'Cannot write helper script: ' .. tostring(err))
    return false
  end
  f:write(content)
  f:close()
  return true
end

local function run_powershell(script_path)
  -- The command line contains only the generated script path, not user-entered values.
  -- User paths are written as escaped PowerShell string literals in the script file.
  local cmd = 'start "" /min powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' .. script_path .. '"'
  local result = os.execute(cmd)
  if result ~= true and result ~= 0 then
    log(obs.LOG_ERROR, 'Could not start the hidden PowerShell helper. Check Windows PowerShell is available.')
    return false
  end
  return true
end

local function make_launch_script(exe_path, pid_file, log_file)
  return table.concat({
    "$ErrorActionPreference = 'Stop'",
    '$exePath = ' .. ps_quote(exe_path),
    '$pidFile = ' .. ps_quote(pid_file),
    '$logFile = ' .. ps_quote(log_file),
    'try {',
    "  if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) { throw 'The executable path does not exist.' }",
    '  $existing = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and [String]::Equals($_.ExecutablePath, $exePath, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1',
    '  if ($existing) {',
    '    if (Test-Path -LiteralPath $pidFile) { Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue }',
    "    Add-Content -LiteralPath $logFile -Value ('[' + (Get-Date -Format s) + '] Fishingbot was already running; left it untouched.')",
    '    exit 0',
    '  }',
    '  $process = Start-Process -FilePath $exePath -PassThru',
    '  Set-Content -LiteralPath $pidFile -Value ([string]$process.Id) -Encoding ASCII',
    "  Add-Content -LiteralPath $logFile -Value ('[' + (Get-Date -Format s) + '] Started Fishingbot PID ' + $process.Id)",
    '} catch {',
    "  Add-Content -LiteralPath $logFile -Value ('[' + (Get-Date -Format s) + '] START ERROR: ' + $_.Exception.Message)",
    '  exit 2',
    '}',
  }, '\r\n')
end

local function make_close_script(exe_path, pid_file, log_file)
  return table.concat({
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$exePath = ' .. ps_quote(exe_path),
    '$pidFile = ' .. ps_quote(pid_file),
    '$logFile = ' .. ps_quote(log_file),
    'try {',
    '  if (Test-Path -LiteralPath $pidFile) {',
    '    $savedPid = 0',
    '    [void][int]::TryParse((Get-Content -LiteralPath $pidFile -TotalCount 1), [ref]$savedPid)',
    '    $process = Get-Process -Id $savedPid -ErrorAction SilentlyContinue',
    '    if ($process -and $process.Path -and [String]::Equals($process.Path, $exePath, [StringComparison]::OrdinalIgnoreCase)) {',
    '      Stop-Process -Id $savedPid -Force -ErrorAction SilentlyContinue',
    "      Add-Content -LiteralPath $logFile -Value ('[' + (Get-Date -Format s) + '] Closed Fishingbot PID ' + $savedPid)",
    '    }',
    '    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue',
    '  }',
    '} catch {',
    "  Add-Content -LiteralPath $logFile -Value ('[' + (Get-Date -Format s) + '] CLOSE ERROR: ' + $_.Exception.Message)",
    '}',
  }, '\r\n')
end

local function schedule_launch()
  if launch_timer then obs.timer_remove(launch_timer) end
  launch_timer = nil
  if not config.launch_on_start or launch_attempted then return end
  local function start_once()
    obs.timer_remove(start_once)
    launch_timer = nil
    launch_attempted = true
    local exe = tostring(config.exe_path or ''):gsub('^%s+', ''):gsub('%s+$', '')
    if exe == '' then
      log(obs.LOG_WARNING, 'Set the Fishingbot executable path in Tools > Scripts > Fishingbot Auto-Start.')
      return
    end
    if exe:find('[\r\n"]') then
      log(obs.LOG_ERROR, 'The executable path contains an unsupported quote or newline.')
      return
    end
    local dir = app_data_dir()
    ensure_dir(dir)
    local pid_file = dir .. '\\obs-launched.pid'
    local helper = dir .. '\\obs-launch.ps1'
    local log_file = dir .. '\\obs-launch.log'
    if write_text(helper, make_launch_script(exe, pid_file, log_file)) then
      if run_powershell(helper) then log(obs.LOG_INFO, 'Auto-start requested for ' .. exe) end
    end
  end
  launch_timer = start_once
  obs.timer_add(start_once, 1500)
end

local function close_launched_app()
  if close_handled or not config.close_on_obs_exit then return end
  close_handled = true
  local exe = tostring(config.exe_path or ''):gsub('^%s+', ''):gsub('%s+$', '')
  if exe == '' or exe:find('[\r\n"]') then return end
  local dir = app_data_dir()
  ensure_dir(dir)
  local pid_file = dir .. '\\obs-launched.pid'
  local helper = dir .. '\\obs-close.ps1'
  local log_file = dir .. '\\obs-launch.log'
  if write_text(helper, make_close_script(exe, pid_file, log_file)) then
    run_powershell(helper)
  end
end

function script_description()
  return 'Launches Fishingbot Desktop when OBS loads. Can close only the process this script launched when OBS exits. The Windows system-startup setting is independent.'
end

function script_defaults(settings)
  obs.obs_data_set_default_bool(settings, 'launch_on_start', true)
  obs.obs_data_set_default_bool(settings, 'close_on_obs_exit', false)
  obs.obs_data_set_default_string(settings, 'exe_path', '')
end

function script_properties()
  local props = obs.obs_properties_create()
  obs.obs_properties_add_path(props, 'exe_path', 'Fishingbot executable', obs.OBS_PATH_FILE, 'Executable (*.exe)', nil)
  obs.obs_properties_add_bool(props, 'launch_on_start', 'Launch Fishingbot when OBS starts')
  obs.obs_properties_add_bool(props, 'close_on_obs_exit', 'Close Fishingbot on OBS exit (only if this script launched it)')
  return props
end

function script_update(settings)
  config.exe_path = obs.obs_data_get_string(settings, 'exe_path') or ''
  config.launch_on_start = obs.obs_data_get_bool(settings, 'launch_on_start')
  config.close_on_obs_exit = obs.obs_data_get_bool(settings, 'close_on_obs_exit')
  close_handled = false
  if not launch_attempted then schedule_launch() end
end

function script_load(settings)
  script_update(settings)
  if obs.obs_frontend_add_event_callback then obs.obs_frontend_add_event_callback(script_event) end
  schedule_launch()
end

function script_unload()
  if obs.obs_frontend_remove_event_callback then obs.obs_frontend_remove_event_callback(script_event) end
  if launch_timer then
    obs.timer_remove(launch_timer)
    launch_timer = nil
  end
  close_launched_app()
end

function script_save(settings)
  -- OBS persists the three options through its scripting settings store.
end

function script_event(event)
  if event == obs.OBS_FRONTEND_EVENT_EXIT then close_launched_app() end
end

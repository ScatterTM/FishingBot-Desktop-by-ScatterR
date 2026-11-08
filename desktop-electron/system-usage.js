// Local usage for the desktop System usage widget: this PC's CPU and memory, and the bot's local server
// process. Only numbers leave this file: no process names, paths, addresses or user data.
const os = require('node:os');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

let lastCpu = null;
let lastBot = null;
let cache = null;
let cacheAt = 0;

const clamp100 = (v) => Math.max(0, Math.min(100, Math.round(v * 10) / 10));

function cpuTotals() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}

// Whole-PC CPU since the previous read. The first read has nothing to compare with, so it returns null.
function pcCpuPercent() {
  const now = cpuTotals();
  let pct = null;
  if (lastCpu && now.total > lastCpu.total) {
    pct = (1 - (now.idle - lastCpu.idle) / (now.total - lastCpu.total)) * 100;
  }
  lastCpu = now;
  return pct === null ? null : clamp100(pct);
}

// Total CPU milliseconds and memory (working set) of one process. Null when it cannot be read.
function readProcess(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve(null);
    if (process.platform === 'win32') {
      const cmd = `$p = Get-Process -Id ${Number(pid)} -ErrorAction Stop; "$([double]$p.TotalProcessorTime.TotalMilliseconds);$($p.WorkingSet64)"`;
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd],
        { timeout: 2500, windowsHide: true, maxBuffer: 1024 },
        (err, stdout) => {
          if (err) return resolve(null);
          const [ms, rss] = String(stdout).trim().split(';').map(Number);
          resolve(Number.isFinite(ms) && Number.isFinite(rss) ? { cpuMs: ms, rssBytes: rss } : null);
        });
      return;
    }
    try {
      // /proc/<pid>/stat: fields after the command name. utime is field 14, stime 15, rss 24 (pages).
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ticks = Number(f[11]) + Number(f[12]);
      resolve({ cpuMs: ticks * 10, rssBytes: Number(f[21]) * 4096 });
    } catch (_) {
      resolve(null);
    }
  });
}

async function botUsage(pid) {
  const info = await readProcess(pid);
  if (!info) {
    lastBot = null;
    return { botCpuPercent: null, botRssBytes: null };
  }
  const now = Date.now();
  let cpu = null;
  if (lastBot && lastBot.pid === pid && now > lastBot.at) {
    cpu = ((info.cpuMs - lastBot.cpuMs) / (now - lastBot.at)) / os.cpus().length * 100;
  }
  lastBot = { pid, cpuMs: info.cpuMs, at: now };
  return { botCpuPercent: cpu === null ? null : clamp100(cpu), botRssBytes: info.rssBytes };
}

// Cached for 2 seconds so several callers do not start several PowerShell reads.
async function systemUsage(server) {
  const now = Date.now();
  if (cache && now - cacheAt < 4000) return cache;
  const pid = server && server.state ? server.state.pid : null;
  const bot = await botUsage(pid);
  const total = os.totalmem();
  const used = total - os.freemem();
  cache = {
    cpuPercent: pcCpuPercent(),
    cores: os.cpus().length,
    ramUsedBytes: used,
    ramPercent: total > 0 ? clamp100((used / total) * 100) : null,
    ...bot,
  };
  cacheAt = now;
  return cache;
}

module.exports = { systemUsage };

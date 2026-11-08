// Privacy-preserving local process/system metrics for the desktop Overview.
// Only aggregate counters are returned; no interface names, addresses or hostnames.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import { databasePath } from '../lib/db.js';

const execFileAsync = promisify(execFile);
const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();
let previousCpu = null;
let previousProcessCpu = null;
let previousProcessSampleAt = 0;
let previousNetwork = null;
let lastWindowsNetworkAt = 0;
let cachedWindowsNetwork = null;

function cpuSnapshot() {
  const rows = os.cpus();
  let idle = 0, total = 0;
  for (const cpu of rows) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  return { idle, total };
}

function linuxNetworkBytes() {
  try {
    const lines = fs.readFileSync('/proc/net/dev', 'utf8').trim().split(/\r?\n/).slice(2);
    let received = 0, sent = 0;
    for (const line of lines) {
      const values = line.trim().split(/\s+/);
      if (values.length < 10) continue;
      received += Number(values[1]) || 0;
      sent += Number(values[9]) || 0;
    }
    return { received, sent };
  } catch (_) { return null; }
}

async function windowsNetworkBytes() {
  const now = Date.now();
  if (cachedWindowsNetwork && now - lastWindowsNetworkAt < 4000) return cachedWindowsNetwork;
  try {
    // Aggregate only. Adapter names and all IP fields are deliberately omitted.
    const command = "(Get-NetAdapterStatistics -ErrorAction Stop | Measure-Object -Property ReceivedBytes -Sum).Sum; (Get-NetAdapterStatistics -ErrorAction Stop | Measure-Object -Property SentBytes -Sum).Sum";
    const result = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 1200, windowsHide: true, maxBuffer: 4096 });
    const nums = String(result.stdout || '').trim().split(/\r?\n/).map((value) => Number(value));
    if (nums.length >= 2 && nums.every(Number.isFinite)) cachedWindowsNetwork = { received: nums[0], sent: nums[1] };
  } catch (_) { /* NetAdapterStatistics may be unavailable on older Windows builds. */ }
  lastWindowsNetworkAt = now;
  return cachedWindowsNetwork;
}

function fileSize(file) {
  try { return fs.statSync(file).size; } catch (_) { return 0; }
}

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = value / 1024, index = 0;
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; }
  return `${amount.toFixed(amount >= 100 ? 0 : 1)} ${units[index]}`;
}

export async function getSystemMetrics() {
  const currentCpu = cpuSnapshot();
  let cpuPercent = null;
  if (previousCpu) {
    const total = currentCpu.total - previousCpu.total;
    const idle = currentCpu.idle - previousCpu.idle;
    if (total > 0) cpuPercent = Math.max(0, Math.min(100, (1 - idle / total) * 100));
  }
  previousCpu = currentCpu;

  const now = Date.now();
  const processCpu = process.cpuUsage();
  let processCpuPercent = null;
  if (previousProcessCpu && previousProcessSampleAt) {
    const elapsedMicros = Math.max(1, now - previousProcessSampleAt) * 1000;
    const cpuMicros = (processCpu.user - previousProcessCpu.user) + (processCpu.system - previousProcessCpu.system);
    processCpuPercent = Math.max(0, Math.min(100, cpuMicros / (elapsedMicros * Math.max(1, os.cpus().length)) * 100));
  }
  previousProcessCpu = processCpu;
  previousProcessSampleAt = now;

  const memory = process.memoryUsage();
  const heapLimit = getHeapStatistics().heap_size_limit;
  const totalRam = os.totalmem();
  const usedRam = totalRam - os.freemem();
  const dbFile = databasePath();
  const dbBytes = fileSize(dbFile) + fileSize(`${dbFile}-wal`) + fileSize(`${dbFile}-shm`);
  const network = process.platform === 'win32' ? await windowsNetworkBytes() : linuxNetworkBytes();
  let networkIn = null, networkOut = null;
  if (network && previousNetwork) {
    const elapsed = Math.max(1, Date.now() - previousNetwork.at) / 1000;
    networkIn = Math.max(0, network.received - previousNetwork.received) / elapsed;
    networkOut = Math.max(0, network.sent - previousNetwork.sent) / elapsed;
  }
  if (network) previousNetwork = { ...network, at: Date.now() };

  return {
    sampledAt: new Date().toISOString(),
    cpuPercent: cpuPercent === null ? null : Number(cpuPercent.toFixed(1)),
    processCpuPercent: processCpuPercent === null ? null : Number(processCpuPercent.toFixed(1)),
    cpuCores: os.cpus().length,
    ramTotalBytes: totalRam,
    ramUsedBytes: usedRam,
    ramPercent: totalRam > 0 ? Number((usedRam / totalRam * 100).toFixed(1)) : null,
    processRssBytes: memory.rss,
    processHeapUsedBytes: memory.heapUsed,
    processHeapLimitBytes: memory.heapTotal,
    nodeHeapLimitBytes: heapLimit,
    processExternalBytes: memory.external,
    eventLoopDelayMs: Number((loop.mean / 1e6 || 0).toFixed(1)),
    databaseBytes: dbBytes,
    databaseSize: formatBytes(dbBytes),
    networkInBytesPerSecond: networkIn === null ? null : Math.round(networkIn),
    networkOutBytesPerSecond: networkOut === null ? null : Math.round(networkOut),
    networkAvailable: !!network
  };
}

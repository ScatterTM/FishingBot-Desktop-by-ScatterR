'use strict';

// Starts, attaches to and stops the Fishingbot Node server, and polls its status.
// The server itself is unchanged: this module only runs local/launcher.js (or
// FishingbotServer.exe in an installed build) and talks to /local/status.

const { spawn, execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const POLL_MS = 3000;
const READY_TIMEOUT_MS = 30000;
const STOP_TIMEOUT_MS = 10000;
const RESTART_EXIT_CODE = 75;
const LOG_LIMIT = 2000;

function parseVersion(text) {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(String(text));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isNodeNewEnough(version) {
  return !!version && (version[0] > 22 || (version[0] === 22 && version[1] >= 5));
}

function checkNode(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve({ ok: false, version: null });
      const version = parseVersion(stdout);
      resolve({ ok: isNodeNewEnough(version), version: version ? version.join('.') : null });
    });
  });
}

function readLines(stream, onLine) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop();
    for (const line of parts) if (line.trim()) onLine(line);
  });
  stream.on('end', () => {
    if (buffer.trim()) onLine(buffer);
  });
}

class ServerManager extends EventEmitter {
  constructor({ root, port, nodeBin }) {
    super();
    this.root = root;
    this.port = port;
    this.nodeBin = nodeBin || 'node';
    this.base = `http://localhost:${port}`;
    this.child = null;
    this.owned = false;
    this.stopping = false;
    this.timer = null;
    this.ramLimitMb = null;
    this.log = [];
    this.state = { state: 'stopped', online: false, startedAt: null, pid: null, error: null, twitch: null };
  }

  // Called once at startup: begin polling, and optionally start (or attach to) the server.
  // OBS-watcher mode passes autoStart:false so OBS controls when the service launches.
  begin({ autoStart = true } = {}) {
    this.timer = setInterval(() => this.poll(), POLL_MS);
    if (autoStart) this.start();
  }

  dispose() {
    clearInterval(this.timer);
    this.timer = null;
  }

  setState(patch) {
    this.state = { ...this.state, ...patch, owned: this.owned, port: this.port };
    this.emit('state', this.state);
  }

  addLog(source, text, level = 'info') {
    const entry = { ts: Date.now(), source, text: String(text), level };
    this.log.push(entry);
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
    this.emit('log', entry);
  }

  async probe() {
    try {
      const res = await fetch(`${this.base}/local/status`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async poll() {
    const status = await this.probe();
    if (status) {
      const twitch = {
        connected: !!status.connected,
        login: status.login || null,
        displayName: status.displayName || null,
        status: status.status || null,
        lastError: status.lastError || null,
      };
      if (!this.state.online) {
        this.addLog('APP', `Local server is responding at ${this.base}.`, 'ok');
        this.setState({ online: true, state: this.owned ? 'running' : 'attached', error: null, twitch });
        this.emit('online');
      } else {
        this.setState({ twitch });
      }
    } else if (this.state.online) {
      this.addLog('APP', 'Local server stopped responding.', 'warn');
      this.setState({ online: false, twitch: null, state: this.child ? 'starting' : 'stopped' });
    }
  }

  command() {
    const exe = path.join(this.root, 'FishingbotServer.exe');
    if (fs.existsSync(exe)) return { file: exe, args: [], needsNode: false };
    const launcher = path.join(this.root, 'local', 'launcher.js');
    if (fs.existsSync(launcher)) {
      return { file: this.nodeBin, args: ['--disable-warning=ExperimentalWarning', launcher], needsNode: true };
    }
    return null;
  }

  async start() {
    if (this.child) return;
    this.stopping = false;

    if (await this.probe()) {
      this.owned = false;
      this.addLog('APP', `Attached to the server already running on port ${this.port}.`, 'ok');
      this.setState({ state: 'attached', online: true, error: null });
      this.emit('online');
      return;
    }

    const cmd = this.command();
    if (!cmd) {
      const msg = `No server found in ${this.root}. Reinstall Fishingbot or check the folder.`;
      this.addLog('APP', msg, 'error');
      this.setState({ state: 'missing', error: msg });
      return;
    }

    if (cmd.needsNode) {
      const node = await checkNode(this.nodeBin);
      if (!node.ok) {
        const msg = `Node.js 22.5 or newer is required (found ${node.version || 'none'}). Set FISHINGBOT_NODE to the node binary.`;
        this.addLog('APP', msg, 'error');
        this.setState({ state: 'error', error: msg });
        return;
      }
    }

    this.owned = true;
    // The server opens a browser tab on start unless told not to. This app never uses one.
    const env = { ...process.env, PORT: String(this.port), OPEN_BROWSER: '0' };
    delete env.ELECTRON_RUN_AS_NODE;
    if (this.ramLimitMb) {
      // Applies from the next start, as in the old desktop app.
      env.NODE_OPTIONS = [env.NODE_OPTIONS, `--max-old-space-size=${this.ramLimitMb}`].filter(Boolean).join(' ');
    }
    const child = spawn(cmd.file, cmd.args, {
      cwd: this.root,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.setState({ state: 'starting', error: null, pid: child.pid, startedAt: Date.now(), online: false });
    this.addLog('APP', `Started local server process (pid ${child.pid}).`, 'ok');

    readLines(child.stdout, (line) => this.addLog('SERVER', line));
    readLines(child.stderr, (line) => this.addLog('SERVER', line, 'error'));
    child.on('error', (err) => {
      if (this.child === child) this.child = null;
      this.owned = false;
      this.addLog('APP', `Could not start the server: ${err.message}`, 'error');
      this.setState({ state: 'error', error: err.message, pid: null, startedAt: null });
    });
    child.on('exit', (code, signal) => this.handleExit(child, code, signal));
    this.waitReady(child);
  }

  async waitReady(child) {
    const until = Date.now() + READY_TIMEOUT_MS;
    while (this.child === child && Date.now() < until) {
      if (await this.probe()) {
        await this.poll();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (this.child === child && !this.state.online) {
      this.addLog('APP', 'The server did not respond within 30 seconds. Check the log.', 'warn');
    }
  }

  handleExit(child, code, signal) {
    if (this.child !== child) return;
    this.child = null;
    const wasStopping = this.stopping;
    this.stopping = false;
    this.owned = false;

    if (!wasStopping && code === RESTART_EXIT_CODE) {
      this.addLog('APP', 'Server asked for a restart (exit code 75). Restarting…', 'warn');
      this.setState({ state: 'stopped', online: false, pid: null, startedAt: null, twitch: null });
      setTimeout(() => this.start(), 1000);
      return;
    }

    const clean = wasStopping || code === 0;
    const msg = clean ? null : `Server exited with code ${code ?? signal}.`;
    this.addLog('APP', clean ? 'Server stopped.' : msg, clean ? 'info' : 'error');
    this.setState({
      state: clean ? 'stopped' : 'error',
      error: msg,
      online: false,
      pid: null,
      startedAt: null,
      twitch: null,
    });
  }

  // Only a server this app started is stopped. An attached server keeps running.
  async stop() {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    this.addLog('APP', 'Stopping the server…');
    try {
      child.stdin.write('shutdown\n');
    } catch {
      /* stdin already closed: the kill below handles it */
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        resolve();
      }, STOP_TIMEOUT_MS);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  async post(pathname) {
    const res = await fetch(this.base + pathname, { method: 'POST', signal: AbortSignal.timeout(10000) });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* not JSON */
    }
    return { ok: res.ok, status: res.status, body };
  }
}

module.exports = { ServerManager };

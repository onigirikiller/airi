import process from 'node:process'

import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..')
const runtimeRoot = resolve(repoRoot, 'runtime')
const dashboardRuntimeRoot = resolve(runtimeRoot, 'codex-dashboard')
const codexRuntimeRoot = resolve(runtimeRoot, 'codex-daemon')
const minecraftRuntimeRoot = resolve(runtimeRoot, 'live-daemon')

const dashboardStatusPath = resolve(dashboardRuntimeRoot, 'status.json')
const codexStatusPath = resolve(codexRuntimeRoot, 'status.json')
const minecraftStatusPath = resolve(minecraftRuntimeRoot, 'launcher-status.json')
const codexWorkerLogPath = resolve(codexRuntimeRoot, 'worker.log')
const minecraftWorkerLogPath = resolve(minecraftRuntimeRoot, 'launcher-session.log')
const port = Number.parseInt(process.env.CODEX_DASHBOARD_PORT ?? '3004', 10)

function tailText(text: string, maxLines: number): string {
  return text
    .split(/\r?\n/u)
    .filter(line => line.trim().length > 0)
    .slice(-maxLines)
    .join('\n')
}

async function readOptionalText(path: string): Promise<string | null> {
  try {
    const buffer = await readFile(path)
    if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
      return buffer.subarray(2).toString('utf16le').replace(/^\uFEFF/u, '').replaceAll('\u0000', '')
    }

    const utf8Text = buffer.toString('utf8').replace(/^\uFEFF/u, '')
    if (utf8Text.includes('\u0000')) {
      return buffer.toString('utf16le').replace(/^\uFEFF/u, '').replaceAll('\u0000', '')
    }

    return utf8Text.replaceAll('\u0000', '')
  }
  catch {
    return null
  }
}

async function readOptionalJson<T>(path: string): Promise<T | null> {
  const text = await readOptionalText(path)
  if (!text) {
    return null
  }

  try {
    return JSON.parse(text) as T
  }
  catch {
    return null
  }
}

function isPidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return false
  }

  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

async function collectDaemonState(statusPath: string, workerLogPath: string): Promise<Record<string, unknown>> {
  const status = await readOptionalJson<Record<string, unknown>>(statusPath)
  const workerLog = await readOptionalText(workerLogPath)
  const iterationLogPath = typeof status?.stderrPath === 'string'
    ? status.stderrPath
    : (typeof status?.activeRunLogPath === 'string' ? status.activeRunLogPath : null)
  const lastMessagePath = typeof status?.lastMessagePath === 'string'
    ? status.lastMessagePath
    : null

  const iterationLog = iterationLogPath ? await readOptionalText(iterationLogPath) : null
  const lastMessage = lastMessagePath ? await readOptionalText(lastMessagePath) : null

  return {
    alive: isPidAlive(status?.workerPid),
    status,
    workerLogTail: workerLog ? tailText(workerLog, 24) : null,
    iterationLogTail: iterationLog ? tailText(iterationLog, 48) : null,
    lastMessageTail: lastMessage ? tailText(lastMessage, 24) : null,
  }
}

async function getDashboardState(): Promise<Record<string, unknown>> {
  const [codex, minecraft] = await Promise.all([
    collectDaemonState(codexStatusPath, codexWorkerLogPath),
    collectDaemonState(minecraftStatusPath, minecraftWorkerLogPath),
  ])

  return {
    now: new Date().toISOString(),
    codex,
    minecraft,
  }
}

function runPowerShellScript(scriptName: string): Promise<{ code: number, stdout: string, stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn('powershell.exe', [
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      resolve(repoRoot, 'scripts', scriptName),
    ], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => stdout += String(chunk))
    child.stderr.on('data', chunk => stderr += String(chunk))
    child.on('exit', (code) => {
      resolvePromise({
        code: code ?? 1,
        stdout,
        stderr,
      })
    })
    child.on('error', (error) => {
      resolvePromise({
        code: 1,
        stdout,
        stderr: error.message,
      })
    })
  })
}

async function handleAction(target: string, action: string): Promise<{ ok: boolean, output: string }> {
  if (target === 'codex' && action === 'start') {
    const result = await runPowerShellScript('start-codex-minecraft-daemon.ps1')
    return { ok: result.code === 0, output: `${result.stdout}${result.stderr}`.trim() }
  }
  if (target === 'codex' && action === 'stop') {
    const result = await runPowerShellScript('stop-codex-minecraft-daemon.ps1')
    return { ok: result.code === 0, output: `${result.stdout}${result.stderr}`.trim() }
  }
  if (target === 'minecraft' && action === 'start') {
    const result = await runPowerShellScript('start-stream-gemma-daemon.ps1')
    return { ok: result.code === 0, output: `${result.stdout}${result.stderr}`.trim() }
  }
  if (target === 'minecraft' && action === 'stop') {
    const result = await runPowerShellScript('stop-stream-gemma-daemon.ps1')
    return { ok: result.code === 0, output: `${result.stdout}${result.stderr}`.trim() }
  }

  return { ok: false, output: `Unsupported action: ${target}/${action}` }
}

function buildHtml(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codex Daemon Dashboard</title>
<style>
:root{
  --bg:#0b1112;
  --panel:#121c1d;
  --panel-2:#162427;
  --line:#2d4a4f;
  --text:#d7eeee;
  --muted:#89a7ac;
  --ok:#99ffb2;
  --warn:#ffd36d;
  --bad:#ff7b72;
  --blue:#79d3ff;
}
*{box-sizing:border-box}
body{
  margin:0;
  min-height:100vh;
  background:radial-gradient(circle at top left, rgba(121,211,255,.12), transparent 24%), linear-gradient(180deg, #081012, var(--bg));
  color:var(--text);
  font-family:"Segoe UI",system-ui,sans-serif;
}
.app{
  max-width:1400px;
  margin:0 auto;
  padding:24px;
}
.header{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:16px;
  margin-bottom:18px;
}
.title{
  font-size:26px;
  font-weight:700;
  letter-spacing:.08em;
}
.meta{
  color:var(--muted);
  font-size:13px;
}
.grid{
  display:grid;
  grid-template-columns:repeat(2, minmax(0, 1fr));
  gap:16px;
}
.panel{
  background:linear-gradient(180deg, rgba(18,28,29,.96), rgba(10,16,17,.96));
  border:1px solid rgba(121,211,255,.16);
  border-radius:16px;
  overflow:hidden;
  box-shadow:0 16px 32px rgba(0,0,0,.28);
}
.panel-header{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:12px;
  padding:14px 16px;
  border-bottom:1px solid rgba(121,211,255,.12);
  background:linear-gradient(90deg, rgba(24,37,39,.96), rgba(14,22,23,.96));
}
.panel-title{
  font-size:15px;
  font-weight:700;
  letter-spacing:.08em;
}
.badge{
  display:inline-flex;
  align-items:center;
  border-radius:999px;
  padding:4px 10px;
  font-size:12px;
  font-weight:700;
}
.badge.ok{background:rgba(153,255,178,.14); color:var(--ok)}
.badge.bad{background:rgba(255,123,114,.14); color:var(--bad)}
.badge.warn{background:rgba(255,211,109,.14); color:var(--warn)}
.panel-body{
  padding:16px;
}
.stats{
  display:grid;
  grid-template-columns:repeat(2, minmax(0, 1fr));
  gap:10px 16px;
  margin-bottom:14px;
}
.stat-label{
  color:var(--muted);
  font-size:12px;
  margin-bottom:4px;
}
.stat-value{
  font-size:14px;
  word-break:break-word;
}
.actions{
  display:flex;
  gap:10px;
  margin-bottom:14px;
}
button{
  border:none;
  border-radius:10px;
  padding:10px 14px;
  font:inherit;
  font-weight:700;
  cursor:pointer;
}
button.primary{background:var(--blue); color:#051014}
button.danger{background:var(--bad); color:#240909}
button.secondary{background:#203235; color:var(--text)}
.log-title{
  color:var(--muted);
  font-size:12px;
  margin:12px 0 6px;
}
pre{
  margin:0;
  padding:12px;
  min-height:120px;
  max-height:280px;
  overflow:auto;
  border:1px solid rgba(121,211,255,.12);
  border-radius:12px;
  background:rgba(255,255,255,.03);
  color:#d6f1f4;
  font-size:12px;
  line-height:1.45;
  white-space:pre-wrap;
  word-break:break-word;
}
.output{
  margin-top:14px;
}
@media (max-width: 960px){
  .grid{grid-template-columns:1fr}
  .stats{grid-template-columns:1fr}
  .header{flex-direction:column; align-items:flex-start}
}
</style>
</head>
<body>
<div class="app">
  <div class="header">
    <div>
      <div class="title">Codex Daemon Dashboard</div>
      <div class="meta">Codex daemon と stream daemon の状態、ログ、起動停止をここで管理</div>
    </div>
    <div class="meta" id="updatedAt">updated: -</div>
  </div>
  <div class="grid">
    <section class="panel">
      <div class="panel-header">
        <div class="panel-title">Codex Daemon</div>
        <div class="badge warn" id="codexBadge">loading</div>
      </div>
      <div class="panel-body">
        <div class="stats">
          <div><div class="stat-label">Worker PID</div><div class="stat-value" id="codexWorkerPid">-</div></div>
          <div><div class="stat-label">Iteration</div><div class="stat-value" id="codexIteration">-</div></div>
          <div><div class="stat-label">State</div><div class="stat-value" id="codexState">-</div></div>
          <div><div class="stat-label">Updated</div><div class="stat-value" id="codexUpdated">-</div></div>
          <div><div class="stat-label">Iteration Dir</div><div class="stat-value" id="codexIterationDir">-</div></div>
          <div><div class="stat-label">Prompt</div><div class="stat-value" id="codexPrompt">-</div></div>
        </div>
        <div class="actions">
          <button class="primary" onclick="runAction('codex','start')">Start</button>
          <button class="danger" onclick="runAction('codex','stop')">Stop</button>
          <button class="secondary" onclick="refreshState()">Refresh</button>
        </div>
        <div class="log-title">Current Activity</div>
        <pre id="codexIterationLog">-</pre>
        <div class="log-title">Worker Log</div>
        <pre id="codexWorkerLog">-</pre>
        <div class="log-title">Last Message</div>
        <pre id="codexLastMessage">-</pre>
      </div>
    </section>
    <section class="panel">
      <div class="panel-header">
        <div class="panel-title">Minecraft Stream Daemon</div>
        <div class="badge warn" id="minecraftBadge">loading</div>
      </div>
      <div class="panel-body">
        <div class="stats">
          <div><div class="stat-label">Worker PID</div><div class="stat-value" id="minecraftWorkerPid">-</div></div>
          <div><div class="stat-label">Mode</div><div class="stat-value" id="minecraftMode">-</div></div>
          <div><div class="stat-label">State</div><div class="stat-value" id="minecraftState">-</div></div>
          <div><div class="stat-label">Updated</div><div class="stat-value" id="minecraftUpdated">-</div></div>
          <div><div class="stat-label">Run Log</div><div class="stat-value" id="minecraftRunLog">-</div></div>
          <div><div class="stat-label">Supervisor</div><div class="stat-value" id="minecraftSupervisor">-</div></div>
        </div>
        <div class="actions">
          <button class="primary" onclick="runAction('minecraft','start')">Start</button>
          <button class="danger" onclick="runAction('minecraft','stop')">Stop</button>
          <button class="secondary" onclick="refreshState()">Refresh</button>
        </div>
        <div class="log-title">Launcher Log</div>
        <pre id="minecraftWorkerLog">-</pre>
        <div class="log-title">Current Run Log</div>
        <pre id="minecraftIterationLog">-</pre>
      </div>
    </section>
  </div>
  <section class="panel output">
    <div class="panel-header">
      <div class="panel-title">Action Output</div>
      <div class="meta" id="actionMeta">idle</div>
    </div>
    <div class="panel-body">
      <pre id="actionOutput">-</pre>
    </div>
  </section>
</div>
<script>
let refreshTimer = null;

function badgeClass(alive, state) {
  if (alive) return 'badge ok';
  if (String(state || '').includes('running')) return 'badge warn';
  return 'badge bad';
}

function setText(id, value) {
  document.getElementById(id).textContent = value && String(value).trim().length > 0 ? String(value) : '-';
}

function updateDaemon(prefix, payload) {
  const status = payload && payload.status ? payload.status : {};
  document.getElementById(prefix + 'Badge').className = badgeClass(payload && payload.alive, status.state);
  document.getElementById(prefix + 'Badge').textContent = payload && payload.alive ? 'alive' : (status.state || 'offline');
  setText(prefix + 'WorkerPid', status.workerPid);
  setText(prefix + 'State', status.state);
  setText(prefix + 'Updated', status.updatedAt);
  if (prefix === 'codex') {
    setText('codexIteration', status.iteration);
    setText('codexIterationDir', status.iterationDir);
    setText('codexPrompt', status.promptPath);
    setText('codexIterationLog', payload.iterationLogTail);
    setText('codexWorkerLog', payload.workerLogTail);
    setText('codexLastMessage', payload.lastMessageTail);
  } else {
    setText('minecraftMode', status.mode);
    setText('minecraftRunLog', status.activeRunLogPath);
    setText('minecraftSupervisor', status.supervisorStatusPath);
    setText('minecraftIterationLog', payload.iterationLogTail);
    setText('minecraftWorkerLog', payload.workerLogTail);
  }
}

async function refreshState() {
  const response = await fetch('/api/state', { cache: 'no-store' });
  const state = await response.json();
  setText('updatedAt', 'updated: ' + state.now);
  updateDaemon('codex', state.codex);
  updateDaemon('minecraft', state.minecraft);
}

async function runAction(target, action) {
  const response = await fetch('/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target, action }),
  });
  const payload = await response.json();
  setText('actionMeta', target + '/' + action + ' -> ' + (payload.ok ? 'ok' : 'failed'));
  setText('actionOutput', payload.output || '-');
  await refreshState();
}

refreshState();
refreshTimer = setInterval(refreshState, 2500);
</script>
</body>
</html>`
}

const dashboardHtml = buildHtml()

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(dashboardHtml)
    return
  }

  if (req.method === 'GET' && req.url === '/api/state') {
    const state = await getDashboardState()
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(state))
    return
  }

  if (req.method === 'POST' && req.url === '/api/action') {
    let body = ''
    req.on('data', chunk => body += String(chunk))
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body) as { target?: string, action?: string }
        const result = await handleAction(parsed.target ?? '', parsed.action ?? '')
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(result))
      }
      catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({
          ok: false,
          output: error instanceof Error ? error.message : String(error),
        }))
      }
    })
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('Not Found')
})

server.listen(port, async () => {
  await writeFile(dashboardStatusPath, `${JSON.stringify({
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
    url: `http://localhost:${port}/`,
  }, null, 2)}\n`, 'utf8')
  process.stdout.write(`Codex dashboard listening on http://localhost:${port}/\n`)
})

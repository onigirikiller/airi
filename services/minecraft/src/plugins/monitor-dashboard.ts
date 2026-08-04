import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http'

import type { Mineflayer } from '../libs/mineflayer'
import type { MineflayerPlugin } from '../libs/mineflayer/plugin'
import type { MonitorEvent } from '../libs/monitor-event-bus'

import { readFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { resolve } from 'node:path'

import { getStabilityMetrics } from '../autonomy/metrics'
import { config } from '../composables/config'
import { buildWorldStateSnapshot, refreshWorldStateCaches } from '../libs/llm-agent/world-state'
import { monitorBus } from '../libs/monitor-event-bus'
import { getActiveGameRunner } from '../runner'
import { useLogger } from '../utils/logger'

const MAX_EVENT_HISTORY = 50
const CODEX_WORKER_LOG_LINES = 24
const CODEX_ITERATION_LOG_LINES = 48
const WORKSPACE_ROOT = resolve(import.meta.dirname, '..', '..')
const CODEX_DAEMON_STATUS_PATH = resolve(WORKSPACE_ROOT, 'runtime/codex-daemon/status.json')
const CODEX_DAEMON_WORKER_LOG_PATH = resolve(WORKSPACE_ROOT, 'runtime/codex-daemon/worker.log')

function tailText(text: string, maxLines: number): string {
  return text
    .split(/\r?\n/u)
    .filter(line => line.trim().length > 0)
    .slice(-maxLines)
    .join('\n')
}

async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    const buffer = await readFile(filePath)
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

async function readOptionalJson<T>(filePath: string): Promise<T | null> {
  try {
    const text = await readFile(filePath, 'utf8')
    return JSON.parse(text) as T
  }
  catch {
    return null
  }
}

async function getCodexDaemonState(): Promise<Record<string, unknown>> {
  const status = await readOptionalJson<Record<string, unknown>>(CODEX_DAEMON_STATUS_PATH)
  const workerLog = await readOptionalText(CODEX_DAEMON_WORKER_LOG_PATH)
  const iterationDir = typeof status?.iterationDir === 'string'
    ? status.iterationDir
    : null
  const stderrPath = typeof status?.stderrPath === 'string'
    ? status.stderrPath
    : null
  const stdoutPath = typeof status?.stdoutPath === 'string'
    ? status.stdoutPath
    : null
  const lastMessagePath = typeof status?.lastMessagePath === 'string'
    ? status.lastMessagePath
    : null

  const stderrLog = stderrPath ? await readOptionalText(stderrPath) : null
  const stdoutLog = stdoutPath ? await readOptionalText(stdoutPath) : null
  const lastMessage = lastMessagePath ? await readOptionalText(lastMessagePath) : null

  return {
    available: status != null,
    status,
    iterationDir,
    workerLogTail: workerLog ? tailText(workerLog, CODEX_WORKER_LOG_LINES) : null,
    iterationLogTail: stderrLog
      ? tailText(stderrLog, CODEX_ITERATION_LOG_LINES)
      : (stdoutLog ? tailText(stdoutLog, CODEX_ITERATION_LOG_LINES) : null),
    lastMessageTail: lastMessage ? tailText(lastMessage, CODEX_WORKER_LOG_LINES) : null,
  }
}

export function buildDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AIRI Monitor Dashboard</title>
<style>
:root{
  --eva-bg:#070906;
  --eva-bg-2:#110d09;
  --eva-panel:#141411;
  --eva-panel-2:#1f1b16;
  --eva-line:rgba(255,157,52,.38);
  --eva-line-strong:#ffb058;
  --eva-green:#97ff8c;
  --eva-blue:#79d3ff;
  --eva-cyan:#8cf3ff;
  --eva-red:#ff6d57;
  --eva-purple:#d1a5ff;
  --eva-yellow:#ffd15c;
  --eva-text:#ffd7ab;
  --eva-muted:#b99f7d;
  --eva-shadow:0 0 0 1px rgba(255,196,128,.05),0 16px 32px rgba(0,0,0,.28),0 0 22px rgba(255,120,24,.12);
}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%}
body{
  position:relative;
  background:
    radial-gradient(circle at 14% 18%, rgba(255,130,0,.18), transparent 22%),
    radial-gradient(circle at 82% 78%, rgba(129,255,156,.12), transparent 24%),
    linear-gradient(135deg, var(--eva-bg) 0%, var(--eva-bg-2) 58%, #090b08 100%);
  color:var(--eva-text);
  font-family:'Bahnschrift','Arial Narrow','Segoe UI',system-ui,sans-serif;
  font-size:13px;
  letter-spacing:.03em;
  overflow:hidden;
}
body::before,
body::after{
  content:"";
  position:fixed;
  inset:0;
  pointer-events:none;
}
body::before{
  background-image:
    linear-gradient(to right, rgba(120,255,144,.08) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(120,255,144,.08) 1px, transparent 1px);
  background-size:72px 72px;
  mask-image:radial-gradient(circle at center, #000 38%, transparent 88%);
  opacity:.24;
}
body::after{
  background-image:linear-gradient(to bottom, rgba(255,255,255,.055) 50%, transparent 50%);
  background-size:100% 5px;
  opacity:.08;
}
.toast-stack{
  position:fixed;
  top:68px;
  right:18px;
  z-index:20;
  display:flex;
  flex-direction:column;
  gap:8px;
  width:min(360px, calc(100vw - 36px));
  pointer-events:none;
}
.toast{
  padding:10px 12px;
  border:1px solid rgba(255,109,87,.42);
  background:linear-gradient(135deg, rgba(61,17,12,.96), rgba(28,11,10,.9));
  color:#ffe1d4;
  box-shadow:0 12px 24px rgba(0,0,0,.28), 0 0 20px rgba(255,109,87,.14);
  clip-path:polygon(0 0, calc(100% - 12px) 0, 100% 12px, 100% 100%, 12px 100%, 0 calc(100% - 12px));
}
.toast-title{
  font-size:10px;
  letter-spacing:.14em;
  text-transform:uppercase;
  color:#ffb7aa;
  margin-bottom:4px;
}
.toast-body{
  font-size:12px;
  line-height:1.45;
}
.header{
  position:relative;
  background:linear-gradient(90deg, rgba(18,19,18,.96), rgba(12,12,12,.78));
  border-bottom:1px solid var(--eva-line);
  padding:12px 18px 10px;
  display:flex;
  align-items:center;
  gap:12px;
  min-height:56px;
  clip-path:polygon(0 0, calc(100% - 26px) 0, 100% 26px, 100% 100%, 0 100%);
  box-shadow:0 12px 24px rgba(0,0,0,.24);
}
.header::after{
  content:"";
  position:absolute;
  left:18px;
  right:18px;
  bottom:0;
  height:1px;
  background:linear-gradient(90deg, transparent, var(--eva-line-strong), transparent);
}
.header h1{
  font-size:19px;
  font-weight:700;
  color:var(--eva-line-strong);
  letter-spacing:.12em;
  text-transform:uppercase;
  text-shadow:0 0 14px rgba(255,147,38,.24);
}
.header .status{
  font-size:11px;
  padding:4px 10px;
  border:1px solid rgba(151,255,140,.36);
  clip-path:polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px));
  background:linear-gradient(180deg, rgba(16,55,20,.94), rgba(8,24,11,.86));
  color:#d7ffd0;
  text-shadow:0 0 10px rgba(151,255,140,.16);
}
.header .status.disconnected{
  border-color:rgba(255,109,87,.4);
  background:linear-gradient(180deg, rgba(77,18,13,.94), rgba(34,9,7,.86));
  color:#ffd3cb;
}
.grid{
  position:relative;
  display:grid;
  grid-template-columns:repeat(3, minmax(0, 1fr));
  grid-template-rows:repeat(2, minmax(0, 1fr));
  gap:12px;
  padding:12px;
  height:calc(100vh - 56px);
}
.panel{
  position:relative;
  overflow:hidden;
  display:flex;
  flex-direction:column;
  border:1px solid var(--eva-line);
  background:
    linear-gradient(180deg, rgba(27,23,18,.88), rgba(9,11,10,.86)),
    linear-gradient(135deg, rgba(129,255,156,.04), transparent 34%);
  clip-path:polygon(0 0, calc(100% - 22px) 0, 100% 22px, 100% 100%, 22px 100%, 0 calc(100% - 22px));
  box-shadow:var(--eva-shadow);
}
.panel::before{
  content:"";
  position:absolute;
  inset:0;
  border:1px solid rgba(255,198,133,.05);
  pointer-events:none;
}
.panel::after{
  content:"";
  position:absolute;
  left:16px;
  top:14px;
  width:92px;
  height:6px;
  background:linear-gradient(90deg, transparent, var(--eva-line-strong), transparent);
  filter:drop-shadow(0 0 8px rgba(255,130,22,.3));
  opacity:.72;
  pointer-events:none;
}
.panel-header{
  background:linear-gradient(90deg, rgba(36,29,22,.94), rgba(16,16,15,.82));
  padding:10px 14px 9px;
  font-size:11px;
  font-weight:700;
  color:#ffd09a;
  border-bottom:1px solid rgba(255,157,52,.22);
  display:flex;
  align-items:center;
  gap:8px;
  flex-shrink:0;
  letter-spacing:.16em;
  text-transform:uppercase;
}
.panel-header .dot{
  width:8px;
  height:8px;
  border-radius:50%;
  flex-shrink:0;
  box-shadow:0 0 10px currentColor;
}
.panel-body{
  padding:12px 14px;
  overflow-y:auto;
  flex:1;
  min-height:0;
  scrollbar-width:thin;
  scrollbar-color:rgba(255,176,88,.38) transparent;
}
.panel-body::-webkit-scrollbar{width:8px}
.panel-body::-webkit-scrollbar-thumb{
  background:linear-gradient(180deg, rgba(255,176,88,.38), rgba(151,255,140,.28));
  border-radius:999px;
}
.dot-green{background:var(--eva-green);color:var(--eva-green)}
.dot-yellow{background:var(--eva-yellow);color:var(--eva-yellow)}
.dot-blue{background:var(--eva-blue);color:var(--eva-blue)}
.dot-red{background:var(--eva-red);color:var(--eva-red)}
.dot-purple{background:var(--eva-purple);color:var(--eva-purple)}
.dot-cyan{background:var(--eva-cyan);color:var(--eva-cyan)}
.label{
  font-size:10px;
  color:var(--eva-muted);
  margin-bottom:4px;
  letter-spacing:.14em;
  text-transform:uppercase;
}
.value{
  font-size:14px;
  color:var(--eva-text);
  margin-bottom:10px;
  word-break:break-all;
  line-height:1.45;
}
.value.large{
  font-size:20px;
  font-weight:700;
  color:#fff1d6;
  text-shadow:0 0 18px rgba(255,166,79,.12);
}
.badge{
  display:inline-block;
  font-size:10px;
  padding:2px 8px;
  font-weight:700;
  letter-spacing:.14em;
  text-transform:uppercase;
  clip-path:polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px));
}
.badge-llm{background:rgba(121,211,255,.16);color:var(--eva-blue);border:1px solid rgba(121,211,255,.4)}
.badge-fallback{background:rgba(255,209,92,.14);color:var(--eva-yellow);border:1px solid rgba(255,209,92,.36)}
.badge-success{background:rgba(151,255,140,.14);color:var(--eva-green);border:1px solid rgba(151,255,140,.34)}
.badge-fail{background:rgba(255,109,87,.14);color:var(--eva-red);border:1px solid rgba(255,109,87,.34)}
.badge-running{background:rgba(209,165,255,.14);color:var(--eva-purple);border:1px solid rgba(209,165,255,.32)}
.step{
  padding:7px 10px;
  margin:4px 0;
  font-size:12px;
  border-left:3px solid rgba(255,157,52,.22);
  background:rgba(255,255,255,.018);
  color:var(--eva-muted);
  clip-path:polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 0 100%);
}
.step.active{
  background:linear-gradient(90deg, rgba(121,211,255,.18), rgba(255,255,255,.03));
  border-left-color:var(--eva-blue);
  color:#ecf9ff;
}
.step.done{
  border-left-color:var(--eva-green);
  color:#c9d3c0;
}
.step.failed{
  border-left-color:var(--eva-red);
  color:#ffb7aa;
}
.timeline-item{
  padding:6px 0;
  border-bottom:1px solid rgba(255,157,52,.08);
  font-size:11px;
  display:flex;
  gap:8px;
  align-items:flex-start;
}
.timeline-item:last-child{border-bottom:none}
.timeline-time{
  color:var(--eva-muted);
  flex-shrink:0;
  font-family:'Consolas','DM Mono','Courier New',monospace;
  font-size:10px;
}
.timeline-type{
  flex-shrink:0;
  font-weight:700;
  min-width:140px;
}
.timeline-data{
  color:#d0b899;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
  flex:1;
}
.llm-entry{
  padding:7px 10px;
  margin:4px 0;
  background:linear-gradient(90deg, rgba(255,255,255,.03), rgba(255,157,52,.04));
  border:1px solid rgba(255,157,52,.1);
  font-size:11px;
  line-height:1.4;
  word-break:break-all;
  clip-path:polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px));
}
.fallback-latest{
  padding:8px 10px;
  margin:4px 0 10px;
  background:linear-gradient(90deg, rgba(255,209,92,.12), rgba(255,109,87,.08));
  border:1px solid rgba(255,209,92,.22);
  font-size:11px;
  line-height:1.45;
  clip-path:polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px));
}
.fallback-entry{
  padding:7px 10px;
  margin:4px 0;
  background:linear-gradient(90deg, rgba(255,209,92,.08), rgba(255,255,255,.03));
  border-left:3px solid var(--eva-yellow);
  font-size:11px;
  line-height:1.45;
  color:#ffe6b0;
}
.fallback-meta{
  color:var(--eva-muted);
  font-size:10px;
  margin-top:2px;
}
.llm-entry .llm-dir{
  font-weight:700;
  margin-right:6px;
  letter-spacing:.12em;
}
.llm-dir.req{color:var(--eva-yellow)}
.llm-dir.res{color:var(--eva-green)}
.bot-stat{
  display:flex;
  justify-content:space-between;
  gap:12px;
  padding:4px 0;
}
.bot-stat .stat-label{
  color:var(--eva-muted);
  letter-spacing:.08em;
}
.bot-stat .stat-value{
  color:var(--eva-text);
  font-family:'Consolas','DM Mono','Courier New',monospace;
}
.hp-bar,.food-bar{
  height:6px;
  margin:2px 0 6px;
  box-shadow:0 0 10px rgba(255,176,88,.1);
}
.hp-bar{background:linear-gradient(90deg, var(--eva-red), var(--eva-green))}
.food-bar{background:linear-gradient(90deg, var(--eva-yellow), var(--eva-green))}
.bar-track{
  background:rgba(255,255,255,.05);
  border:1px solid rgba(255,157,52,.12);
  height:8px;
  overflow:hidden;
  clip-path:polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px));
}
.type-orchestrator{color:var(--eva-purple)}
.type-planning{color:var(--eva-blue)}
.type-action{color:var(--eva-green)}
.type-llm{color:var(--eva-yellow)}
.type-fallback{color:var(--eva-red)}
.action-timer{
  font-family:'Consolas','DM Mono','Courier New',monospace;
  color:var(--eva-line-strong);
  font-size:16px;
  text-shadow:0 0 12px rgba(255,176,88,.14);
}
.codex-dock{
  position:fixed;
  right:18px;
  bottom:18px;
  width:min(560px, calc(100vw - 36px));
  max-height:min(56vh, 520px);
  z-index:15;
  border:1px solid rgba(121,211,255,.28);
  background:linear-gradient(180deg, rgba(12,18,18,.96), rgba(8,10,11,.92));
  box-shadow:0 18px 36px rgba(0,0,0,.34), 0 0 24px rgba(121,211,255,.12);
  clip-path:polygon(0 0, calc(100% - 16px) 0, 100% 16px, 100% 100%, 16px 100%, 0 calc(100% - 16px));
  display:flex;
  flex-direction:column;
  overflow:hidden;
}
.codex-header{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:12px;
  padding:10px 12px;
  border-bottom:1px solid rgba(121,211,255,.16);
  background:linear-gradient(90deg, rgba(20,35,37,.96), rgba(13,17,18,.92));
}
.codex-title{
  font-size:11px;
  letter-spacing:.16em;
  text-transform:uppercase;
  color:var(--eva-cyan);
  font-weight:700;
}
.codex-meta{
  display:flex;
  align-items:center;
  gap:8px;
  color:var(--eva-muted);
  font-size:10px;
  white-space:nowrap;
}
.codex-body{
  display:grid;
  grid-template-columns:220px 1fr;
  min-height:0;
  flex:1;
}
.codex-sidebar,
.codex-console{
  min-height:0;
  overflow:auto;
}
.codex-sidebar{
  padding:12px;
  border-right:1px solid rgba(121,211,255,.12);
}
.codex-console{
  padding:12px;
}
.codex-log{
  margin-top:8px;
  padding:10px;
  background:rgba(255,255,255,.025);
  border:1px solid rgba(121,211,255,.12);
  color:#d7eef2;
  font-family:'Consolas','DM Mono','Courier New',monospace;
  font-size:11px;
  line-height:1.45;
  white-space:pre-wrap;
  word-break:break-word;
  max-height:188px;
  overflow:auto;
}
.codex-log-title{
  font-size:10px;
  letter-spacing:.12em;
  text-transform:uppercase;
  color:var(--eva-muted);
  margin:8px 0 4px;
}
@media (max-width: 1180px){
  .grid{
    grid-template-columns:repeat(2, minmax(0, 1fr));
    grid-template-rows:repeat(3, minmax(220px, 1fr));
    height:calc(100vh - 56px);
  }
}
@media (max-width: 720px){
  body{overflow:auto}
  .header{
    padding:12px 14px 10px;
    flex-wrap:wrap;
  }
  .header h1{font-size:16px}
  .grid{
    grid-template-columns:1fr;
    grid-template-rows:none;
    height:auto;
    min-height:calc(100vh - 56px);
  }
  .panel{
    min-height:240px;
  }
  .timeline-type{
    min-width:110px;
  }
  .codex-dock{
    position:static;
    width:auto;
    max-height:none;
    margin:0 12px 12px;
  }
  .codex-body{
    grid-template-columns:1fr;
  }
  .codex-sidebar{
    border-right:none;
    border-bottom:1px solid rgba(121,211,255,.12);
  }
}
</style>
</head>
<body>
<div class="toast-stack" id="fallbackToasts"></div>
<div class="header">
  <h1>AIRI Monitor Dashboard</h1>
  <span class="status" id="wsStatus">接続中...</span>
</div>
<div class="grid">
  <!-- Panel 1: Current Goal -->
  <div class="panel">
    <div class="panel-header"><span class="dot dot-purple"></span>現在のゴール</div>
    <div class="panel-body" id="goalPanel">
      <div class="label">ゴール</div>
      <div class="value large" id="goalText">待機中</div>
      <div class="label">ソース</div>
      <div class="value" id="goalSource">-</div>
      <div class="label">ステータス</div>
      <div class="value" id="goalStatus">-</div>
    </div>
  </div>
  <!-- Panel 2: Plan State -->
  <div class="panel">
    <div class="panel-header"><span class="dot dot-blue"></span>プラン状態</div>
    <div class="panel-body" id="planPanel">
      <div class="label">生成方式</div>
      <div class="value" id="planMethod">-</div>
      <div class="label">ステップ一覧</div>
      <div id="planSteps"></div>
    </div>
  </div>
  <!-- Panel 3: Action Execution -->
  <div class="panel">
    <div class="panel-header"><span class="dot dot-green"></span>アクション実行</div>
    <div class="panel-body" id="actionPanel">
      <div class="label">現在のアクション</div>
      <div class="value large" id="actionName">-</div>
      <div class="label">説明</div>
      <div class="value" id="actionDesc">-</div>
      <div class="label">経過時間</div>
      <div class="action-timer" id="actionTimer">-</div>
      <div class="label" style="margin-top:8px">パラメータ</div>
      <div class="value" id="actionParams" style="font-family:monospace;font-size:11px">-</div>
    </div>
  </div>
  <!-- Panel 4: LLM Communication -->
  <div class="panel">
    <div class="panel-header"><span class="dot dot-yellow"></span>LLM通信</div>
    <div class="panel-body" id="llmPanel">
      <div class="label">最新フォールバック</div>
      <div class="fallback-latest" id="fallbackLatest">-</div>
      <div class="label">フォールバック履歴</div>
      <div id="fallbackPanel"></div>
      <div class="label" style="margin-top:10px">LLM通信履歴</div>
      <div id="llmEntries"></div>
    </div>
  </div>
  <!-- Panel 5: Event Timeline -->
  <div class="panel">
    <div class="panel-header"><span class="dot dot-cyan"></span>イベントタイムライン</div>
    <div class="panel-body" id="timelinePanel"></div>
  </div>
  <!-- Panel 6: Bot State -->
  <div class="panel">
    <div class="panel-header"><span class="dot dot-red"></span>ボット状態</div>
    <div class="panel-body" id="botPanel">
      <div class="label">HP</div>
      <div class="bar-track"><div class="hp-bar" id="hpBar" style="width:100%"></div></div>
      <div class="bot-stat"><span class="stat-label">HP</span><span class="stat-value" id="botHp">-</span></div>
      <div class="label">食料</div>
      <div class="bar-track"><div class="food-bar" id="foodBar" style="width:100%"></div></div>
      <div class="bot-stat"><span class="stat-label">食料</span><span class="stat-value" id="botFood">-</span></div>
      <div class="bot-stat"><span class="stat-label">位置</span><span class="stat-value" id="botPos">-</span></div>
      <div class="bot-stat"><span class="stat-label">ディメンション</span><span class="stat-value" id="botDim">-</span></div>
    </div>
  </div>
</div>
<div class="codex-dock">
  <div class="codex-header">
    <div class="codex-title">Codex Daemon</div>
    <div class="codex-meta">
      <span class="badge badge-running" id="codexStateBadge">starting</span>
      <span id="codexIterationMeta">iteration -</span>
    </div>
  </div>
  <div class="codex-body">
    <div class="codex-sidebar">
      <div class="label">Worker</div>
      <div class="value" id="codexWorkerPid">-</div>
      <div class="label">Updated</div>
      <div class="value" id="codexUpdatedAt">-</div>
      <div class="label">Iteration Dir</div>
      <div class="value" id="codexIterationDir">-</div>
      <div class="label">Last Message</div>
      <div class="codex-log" id="codexLastMessage">-</div>
    </div>
    <div class="codex-console">
      <div class="codex-log-title">Current Activity</div>
      <div class="codex-log" id="codexIterationLog">-</div>
      <div class="codex-log-title">Worker Log</div>
      <div class="codex-log" id="codexWorkerLog">-</div>
    </div>
  </div>
</div>
<script>
(function(){
  const $ = id => document.getElementById(id);
  let ws;
  let actionStartTime = 0;
  let actionTimerInterval = null;
  let planSteps = [];
  let currentStepIndex = -1;
  let fallbackEntries = [];
  let llmEntries = [];
  const MAX_FALLBACK = 20;
  const MAX_LLM = 10;
  const MAX_TIMELINE = 200;
  let timelineItems = [];
  let codexPollTimer = null;
  let monitorStatePollTimer = null;
  let latestRunnerState = null;
  let explicitGoalActive = false;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(proto + '//' + location.host);
    ws.onopen = () => {
      $('wsStatus').textContent = '接続済み';
      $('wsStatus').className = 'status';
    };
    ws.onclose = () => {
      $('wsStatus').textContent = '切断';
      $('wsStatus').className = 'status disconnected';
      setTimeout(connect, 2000);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'history') {
          (msg.events || []).forEach(ev => handleEvent(ev, true));
        } else if (msg.type === 'event') {
          handleEvent(msg.event, false);
        } else if (msg.type === 'botState') {
          updateBotState(msg.state);
        }
      } catch(err) { console.error('WS parse error', err); }
    };
  }

  function handleEvent(ev, fromHistory) {
    addTimeline(ev);
    const d = ev.data || {};
    switch(ev.type) {
      case 'orchestrator:goalSelected':
        explicitGoalActive = true;
        $('goalText').textContent = d.goal || '-';
        $('goalSource').textContent = d.source || d.reason || '-';
        $('goalStatus').innerHTML = '<span class="badge badge-running">実行中</span>';
        planSteps = [];
        currentStepIndex = -1;
        renderPlanSteps();
        $('planMethod').textContent = '-';
        break;
      case 'orchestrator:goalCompleted':
        explicitGoalActive = false;
        $('goalStatus').innerHTML = '<span class="badge badge-success">完了</span>';
        updateGoalFromRunnerState(latestRunnerState);
        break;
      case 'orchestrator:goalFailed':
        explicitGoalActive = false;
        $('goalStatus').innerHTML = '<span class="badge badge-fail">失敗</span> ' + (d.error || '');
        updateGoalFromRunnerState(latestRunnerState);
        break;
      case 'planning:started':
        $('planMethod').textContent = '生成中...';
        planSteps = [];
        currentStepIndex = -1;
        renderPlanSteps();
        break;
      case 'planning:fallback':
        $('planMethod').innerHTML = '<span class="badge badge-fallback">フォールバック</span> ' + (d.reason || '');
        break;
      case 'fallback:used':
        addFallbackEntry(ev, fromHistory);
        break;
      case 'planning:llmGenerated':
        $('planMethod').innerHTML = '<span class="badge badge-llm">LLM生成</span> ' + (d.stepCount || 0) + 'ステップ';
        break;
      case 'planning:stepExecuting':
        currentStepIndex = d.index != null ? d.index : currentStepIndex + 1;
        if (d.step && currentStepIndex >= planSteps.length) {
          planSteps.push(typeof d.step === 'string' ? d.step : (d.step.description || d.step.tool || JSON.stringify(d.step)));
        }
        renderPlanSteps();
        break;
      case 'planning:stepCompleted':
        renderPlanSteps('done', d.index);
        break;
      case 'planning:stepFailed':
        renderPlanSteps('failed', d.index);
        break;
      case 'planning:completed':
        break;
      case 'planning:adjusting':
        $('planMethod').innerHTML = '<span class="badge badge-fallback">調整中</span>';
        break;
      case 'action:started':
        $('actionName').textContent = d.tool || '-';
        $('actionDesc').textContent = d.description || '-';
        $('actionParams').textContent = d.params ? JSON.stringify(d.params, null, 1) : '-';
        actionStartTime = ev.timestamp;
        startActionTimer();
        break;
      case 'action:completed':
        stopActionTimer();
        $('actionName').textContent = (d.tool || '-') + ' (完了)';
        break;
      case 'action:failed':
        stopActionTimer();
        $('actionName').textContent = (d.tool || '-') + ' (失敗)';
        $('actionDesc').textContent = d.error || 'エラー';
        break;
      case 'action:timeout':
        stopActionTimer();
        $('actionName').textContent = (d.tool || '-') + ' (タイムアウト)';
        break;
      case 'llm:requestSent':
        addLlmEntry('req', d);
        break;
      case 'llm:responseReceived':
        addLlmEntry('res', d);
        break;
    }
  }

  function renderPlanSteps(overrideStatus, overrideIndex) {
    const container = $('planSteps');
    container.innerHTML = '';
    planSteps.forEach((step, i) => {
      const div = document.createElement('div');
      div.className = 'step';
      if (overrideStatus && overrideIndex === i) {
        div.classList.add(overrideStatus === 'failed' ? 'failed' : 'done');
      } else if (i === currentStepIndex) {
        div.classList.add('active');
      } else if (i < currentStepIndex) {
        div.classList.add('done');
      }
      div.textContent = (i + 1) + '. ' + step;
      container.appendChild(div);
    });
  }

  function startActionTimer() {
    stopActionTimer();
    actionTimerInterval = setInterval(() => {
      if (!actionStartTime) return;
      const elapsed = (Date.now() - actionStartTime) / 1000;
      $('actionTimer').textContent = elapsed.toFixed(1) + 's';
    }, 100);
  }

  function stopActionTimer() {
    if (actionTimerInterval) {
      clearInterval(actionTimerInterval);
      actionTimerInterval = null;
    }
  }

  function addLlmEntry(dir, data) {
    const text = dir === 'req'
      ? (data.model || '') + ' | ' + (data.prompt || '').slice(0, 200)
      : (data.model || '') + ' | ' + (data.response || '').slice(0, 300);
    llmEntries.unshift({ dir, text, time: Date.now() });
    if (llmEntries.length > MAX_LLM) llmEntries = llmEntries.slice(0, MAX_LLM);
    renderLlm();
  }

  function addFallbackEntry(ev, fromHistory) {
    const data = ev.data || {};
    const entry = {
      scope: data.scope || '-',
      reason: data.reason || '-',
      detail: data.detail || '',
      from: data.from || '',
      to: data.to || '',
      goal: data.goal || '',
      recoverable: data.recoverable,
      timestamp: ev.timestamp,
    };
    fallbackEntries.unshift(entry);
    if (fallbackEntries.length > MAX_FALLBACK) fallbackEntries = fallbackEntries.slice(0, MAX_FALLBACK);
    renderFallbacks();
    if (!fromHistory) {
      notifyFallback(entry);
    }
  }

  function renderFallbacks() {
    const latest = fallbackEntries[0];
    $('fallbackLatest').innerHTML = latest
      ? '<strong>' + escHtml(latest.reason) + '</strong> @ ' + escHtml(latest.scope)
        + (latest.detail ? '<br>' + escHtml(latest.detail) : '')
      : '-';

    const container = $('fallbackPanel');
    container.innerHTML = '';
    fallbackEntries.forEach(entry => {
      const div = document.createElement('div');
      div.className = 'fallback-entry';
      const route = entry.from || entry.to
        ? '<div class="fallback-meta">' + escHtml((entry.from || '?') + ' -> ' + (entry.to || '?')) + '</div>'
        : '';
      const goal = entry.goal
        ? '<div class="fallback-meta">goal=' + escHtml(entry.goal) + '</div>'
        : '';
      const recoverable = '<div class="fallback-meta">recoverable=' + escHtml(String(entry.recoverable !== false)) + '</div>';
      div.innerHTML = '<div><strong>' + escHtml(entry.reason) + '</strong> <span class="fallback-meta">@ ' + escHtml(entry.scope) + '</span></div>'
        + (entry.detail ? '<div>' + escHtml(entry.detail) + '</div>' : '')
        + route
        + goal
        + recoverable;
      container.appendChild(div);
    });
  }

  function renderLlm() {
    const container = $('llmEntries');
    container.innerHTML = '';
    llmEntries.forEach(e => {
      const div = document.createElement('div');
      div.className = 'llm-entry';
      div.innerHTML = '<span class="llm-dir ' + e.dir + '">' + (e.dir === 'req' ? 'REQ' : 'RES') + '</span> ' + escHtml(e.text);
      container.appendChild(div);
    });
  }

  function notifyFallback(entry) {
    const container = $('fallbackToasts');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = '<div class="toast-title">フォールバック検出</div><div class="toast-body"><strong>'
      + escHtml(entry.reason)
      + '</strong> @ '
      + escHtml(entry.scope)
      + (entry.detail ? '<br>' + escHtml(entry.detail) : '')
      + '</div>';
    container.prepend(toast);
    while (container.children.length > 4) {
      container.removeChild(container.lastChild);
    }
    setTimeout(() => {
      if (toast.parentNode === container) {
        container.removeChild(toast);
      }
    }, 8000);
  }

  function addTimeline(ev) {
    timelineItems.unshift(ev);
    if (timelineItems.length > MAX_TIMELINE) timelineItems = timelineItems.slice(0, MAX_TIMELINE);
    renderTimeline();
  }

  function renderTimeline() {
    const container = $('timelinePanel');
    container.innerHTML = '';
    timelineItems.forEach(ev => {
      const div = document.createElement('div');
      div.className = 'timeline-item';
      const t = new Date(ev.timestamp);
      const ts = [t.getHours(), t.getMinutes(), t.getSeconds()].map(v => String(v).padStart(2, '0')).join(':');
      const category = ev.type.split(':')[0];
      const typeClass = 'type-' + category;
      const summary = ev.data ? Object.entries(ev.data).map(([k,v]) => k + '=' + (typeof v === 'string' ? v.slice(0, 60) : JSON.stringify(v))).join(', ') : '';
      div.innerHTML = '<span class="timeline-time">' + ts + '</span><span class="timeline-type ' + typeClass + '">' + escHtml(ev.type) + '</span><span class="timeline-data">' + escHtml(summary) + '</span>';
      container.appendChild(div);
    });
  }

  function updateBotState(s) {
    if (!s) return;
    $('botHp').textContent = (s.health != null ? s.health.toFixed(1) : '-') + ' / 20';
    $('botFood').textContent = (s.food != null ? s.food : '-') + ' / 20';
    $('hpBar').style.width = ((s.health || 0) / 20 * 100) + '%';
    $('foodBar').style.width = ((s.food || 0) / 20 * 100) + '%';
    if (s.position) {
      $('botPos').textContent = Math.floor(s.position.x) + ', ' + Math.floor(s.position.y) + ', ' + Math.floor(s.position.z);
    }
    $('botDim').textContent = s.dimension || '-';
  }

  function describeRunnerStatus(runnerState) {
    if (!runnerState) {
      return null;
    }

    const phase = runnerState.phase ? String(runnerState.phase) : 'UNKNOWN';
    const phaseStep = runnerState.phaseStep != null ? String(runnerState.phaseStep) : '-';
    const attempts = runnerState.attempts != null ? String(runnerState.attempts) : '-';
    const deaths = runnerState.deaths != null ? String(runnerState.deaths) : '-';
    const noProgress = runnerState.noProgressStreak != null ? String(runnerState.noProgressStreak) : '-';
    const blockedReason = typeof runnerState.blockedReason === 'string' ? runnerState.blockedReason.trim() : '';
    const blockedMsRemaining = Number.isFinite(runnerState.blockedMsRemaining) ? Math.max(0, Math.round(runnerState.blockedMsRemaining / 1000)) : 0;

    let goalStatusHtml = '<span class="badge badge-running">進行中</span>';
    if (blockedReason) {
      goalStatusHtml = '<span class="badge badge-fail">ブロック中</span> ' + escHtml(blockedReason)
        + (blockedMsRemaining > 0 ? ' (' + blockedMsRemaining + 's)' : '');
    }
    else if (runnerState.paused) {
      goalStatusHtml = '<span class="badge badge-fallback">一時停止</span>';
    }
    else if (runnerState.pendingDeathRecovery) {
      goalStatusHtml = '<span class="badge badge-fallback">死亡復帰中</span>';
    }

    return {
      goalText: phase,
      goalSource: 'phaseStep=' + phaseStep + ' / attempts=' + attempts + ' / deaths=' + deaths + ' / noProgress=' + noProgress,
      goalStatusHtml,
    };
  }

  function updateGoalFromRunnerState(runnerState) {
    if (!runnerState || explicitGoalActive) {
      return;
    }

    const view = describeRunnerStatus(runnerState);
    if (!view) {
      return;
    }

    $('goalText').textContent = view.goalText;
    $('goalSource').textContent = view.goalSource;
    $('goalStatus').innerHTML = view.goalStatusHtml;
  }

  function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function formatDateTime(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString();
  }

  function setCodexLog(id, text) {
    const el = $(id);
    el.textContent = text && String(text).trim().length > 0 ? String(text) : '-';
  }

  function updateCodexState(payload) {
    const codex = payload && payload.codexState ? payload.codexState : payload;
    const status = codex && codex.status ? codex.status : null;
    const state = status && status.state ? String(status.state) : (codex && codex.available ? 'idle' : 'offline');
    $('codexStateBadge').textContent = state;
    $('codexIterationMeta').textContent = 'iteration ' + ((status && status.iteration != null) ? status.iteration : '-');
    $('codexWorkerPid').textContent = status && status.workerPid != null ? String(status.workerPid) : '-';
    $('codexUpdatedAt').textContent = status ? formatDateTime(status.updatedAt) : '-';
    $('codexIterationDir').textContent = codex && codex.iterationDir ? String(codex.iterationDir) : '-';
    setCodexLog('codexWorkerLog', codex && codex.workerLogTail ? codex.workerLogTail : '');
    setCodexLog('codexIterationLog', codex && codex.iterationLogTail ? codex.iterationLogTail : '');
    setCodexLog('codexLastMessage', codex && codex.lastMessageTail ? codex.lastMessageTail : '');
  }

  async function fetchCodexState() {
    try {
      const response = await fetch('/api/codex', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('HTTP ' + response.status);
      }
      const payload = await response.json();
      updateCodexState(payload);
    } catch (err) {
      $('codexStateBadge').textContent = 'offline';
      $('codexIterationMeta').textContent = String(err && err.message ? err.message : err);
    }
  }

  async function fetchMonitorState() {
    try {
      const response = await fetch('/api/state', { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('HTTP ' + response.status);
      }
      const payload = await response.json();
      updateBotState(payload && payload.botState ? payload.botState : null);
      latestRunnerState = payload && payload.runnerState ? payload.runnerState : null;
      updateGoalFromRunnerState(latestRunnerState);
    } catch (err) {
      console.warn('Failed to fetch monitor state', err);
    }
  }

  connect();
  fetchMonitorState();
  fetchCodexState();
  monitorStatePollTimer = setInterval(fetchMonitorState, 2500);
  codexPollTimer = setInterval(fetchCodexState, 2500);
})();
</script>
</body>
</html>`
}

export function MonitorDashboardPlugin(): MineflayerPlugin {
  const logger = useLogger()
  let server: HttpServer | null = null
  const wsClients: Set<import('ws').WebSocket> = new Set()
  let wss: import('ws').WebSocketServer | null = null
  let eventHistory: MonitorEvent[] = []
  let monitorHandler: ((event: MonitorEvent) => void) | null = null
  let botStateInterval: ReturnType<typeof setInterval> | null = null

  function broadcast(message: string): void {
    for (const client of wsClients) {
      if (client.readyState === 1) {
        client.send(message)
      }
    }
  }

  function getBotState(mineflayer: Mineflayer): Record<string, unknown> {
    try {
      const bot = mineflayer.bot
      return {
        health: bot.health ?? 0,
        food: bot.food ?? 0,
        position: bot.entity?.position
          ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z }
          : null,
        dimension: (bot as any).game?.dimension ?? 'unknown',
      }
    }
    catch {
      return { health: 0, food: 0, position: null, dimension: 'unknown' }
    }
  }

  function getBridgeState(mineflayer: Mineflayer): Record<string, unknown> | null {
    const bridgeStateGetter = (mineflayer as any).getBridgeDebugState
    if (typeof bridgeStateGetter !== 'function') {
      return null
    }

    try {
      return bridgeStateGetter.call(mineflayer) as Record<string, unknown>
    }
    catch {
      return null
    }
  }

  async function getMonitorState(mineflayer: Mineflayer): Promise<Record<string, unknown>> {
    const runnerKeys = [
      mineflayer.username,
      (mineflayer.bot as any).username,
      (mineflayer.bot as any).entity?.username,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0)
    const runnerHandle = (mineflayer as any).__gameRunner
      ?? (mineflayer.bot as any).__gameRunner
      ?? runnerKeys.map(getActiveGameRunner).find(Boolean)
    const runnerState = typeof runnerHandle?.getDebugState === 'function'
      ? runnerHandle.getDebugState()
      : null

    let worldState: Record<string, unknown> | null = null
    try {
      await refreshWorldStateCaches(mineflayer)
      const snapshot = await buildWorldStateSnapshot(mineflayer)
      worldState = {
        biome: snapshot.biome,
        position: snapshot.position,
        skyAccess: snapshot.skyAccess,
        terrainContext: snapshot.terrainContext,
        woodAccess: snapshot.woodAccess,
        surfaceEscapeNeeded: snapshot.surfaceEscapeNeeded,
        pickaxeAccess: snapshot.pickaxeAccess,
        axeAccess: snapshot.axeAccess,
        woodMaterials: snapshot.woodMaterials,
        immediateTerrain: snapshot.immediateTerrain,
        nearbyBlocks: snapshot.nearbyBlocks,
        notableBlocks: snapshot.notableBlocks,
      }
    }
    catch (error) {
      logger.withError(error).warn('Failed to build world-state snapshot for monitor API')
    }

    return {
      eventHistory,
      botState: getBotState(mineflayer),
      bridgeState: getBridgeState(mineflayer),
      runnerState,
      worldState,
      stabilityMetrics: getStabilityMetrics(),
    }
  }

  const dashboardHtml = buildDashboardHtml()

  return {
    created(mineflayer) {
      if (!config.monitor.enabled) {
        logger.log('Monitor dashboard is disabled')
        return
      }

      const port = config.monitor.port

      monitorHandler = (event: MonitorEvent) => {
        eventHistory.push(event)
        if (eventHistory.length > MAX_EVENT_HISTORY) {
          eventHistory = eventHistory.slice(-MAX_EVENT_HISTORY)
        }
        broadcast(JSON.stringify({ type: 'event', event }))
      }
      monitorBus.onMonitor(monitorHandler)

      server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
        if (req.url === '/' || req.url === '') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(dashboardHtml)
        }
        else if (req.url === '/api/state') {
          void getMonitorState(mineflayer)
            .then((state) => {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify(state))
            })
            .catch((error) => {
              logger.withError(error).warn('Failed to serve monitor state')
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({
                eventHistory,
                botState: getBotState(mineflayer),
                bridgeState: getBridgeState(mineflayer),
                runnerState: null,
                worldState: null,
              }))
            })
        }
        else if (req.url === '/api/codex') {
          void getCodexDaemonState()
            .then((state) => {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify(state))
            })
            .catch((error) => {
              logger.withError(error).warn('Failed to serve codex daemon state')
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({
                available: false,
                error: error instanceof Error ? error.message : String(error),
              }))
            })
        }
        else {
          res.writeHead(404)
          res.end('Not Found')
        }
      })

      import('ws').then(({ WebSocketServer }) => {
        wss = new WebSocketServer({ server: server! })
        wss.on('connection', (ws) => {
          wsClients.add(ws)
          ws.send(JSON.stringify({ type: 'history', events: eventHistory }))
          ws.on('close', () => wsClients.delete(ws))
          ws.on('error', () => wsClients.delete(ws))
        })
      }).catch((err) => {
        logger.withError(err).warn('Failed to initialize WebSocket server for monitor dashboard')
      })

      server.listen(port, () => {
        logger.withField('port', port).log('Monitor dashboard started')
      })

      server.on('error', (err) => {
        logger.withError(err).error('Monitor dashboard server error')
      })

      botStateInterval = setInterval(() => {
        if (wsClients.size === 0)
          return
        const state = getBotState(mineflayer)
        broadcast(JSON.stringify({ type: 'botState', state }))
      }, 500)
    },

    async beforeCleanup(_mineflayer) {
      if (botStateInterval) {
        clearInterval(botStateInterval)
        botStateInterval = null
      }

      if (monitorHandler) {
        monitorBus.offMonitor(monitorHandler)
        monitorHandler = null
      }

      for (const client of wsClients) {
        try {
          client.close()
        }
        catch {
          /* noop */
        }
      }
      wsClients.clear()

      if (wss) {
        wss.close()
        wss = null
      }

      if (server) {
        await new Promise<void>((resolve) => {
          server?.close(() => resolve())
        })
        server = null
      }

      eventHistory = []
    },
  }
}

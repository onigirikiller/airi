import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http'

import type { Mineflayer } from '../libs/mineflayer'
import type { MineflayerPlugin } from '../libs/mineflayer/plugin'

import { readFile, stat } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createRequire } from 'node:module'
import { createServer as createNetServer } from 'node:net'
import { dirname, join } from 'node:path'

import { config } from '../composables/config'
import { useLogger } from '../utils/logger'

interface ViewerHudOptions {
  enabled?: boolean
  port?: number
  viewerPort?: number
  viewerPrefix?: string
}

interface HudItem {
  name: string
  displayName: string
  count: number
}

interface ViewerHudState {
  botName: string
  health: number
  food: number
  experienceLevel: number
  experienceProgress: number
  armorValue: number
  position: {
    x: number
    y: number
    z: number
  }
  dimension: string
  timeOfDay: number
  selectedHotbarSlot: number
  heldItem: HudItem | null
  hotbar: Array<HudItem | null>
  inventory: Array<HudItem | null>
  armor: {
    head: HudItem | null
    torso: HudItem | null
    legs: HudItem | null
    feet: HudItem | null
    offhand: HudItem | null
  }
  recentChat: string[]
}

interface HudSprites {
  hotbar: string
  hotbarSelection: string
  crosshair: string
  heartContainer: string
  heartFull: string
  heartHalf: string
  foodEmpty: string
  foodFull: string
  foodHalf: string
  xpBarBackground: string
  xpBarProgress: string
  armorEmpty: string
  armorFull: string
  armorHalf: string
}

interface YouTubeRecentCommentOverlayItem {
  id: string
  author: string
  text: string
  publishedAt: string
}

interface YouTubeRecentCommentsOverlayPayload {
  commentsEnabled: boolean
  speechEnabled: boolean
  updatedAt: string
  comments: YouTubeRecentCommentOverlayItem[]
  speechText: string
  speechUpdatedAt: string
  currentReply: {
    speechText: string
    replyToCommentId: string
    updatedAt: string
  } | null
}

type InventorySlotLike = {
  name?: string
  displayName?: string
  count?: number
} | null | undefined

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim()
  if (!trimmed) {
    return ''
  }

  const withoutTrailing = trimmed.replace(/\/+$/, '')
  return withoutTrailing.startsWith('/') ? withoutTrailing : `/${withoutTrailing}`
}

function toHudItem(slot: InventorySlotLike): HudItem | null {
  if (!slot || !slot.name) {
    return null
  }

  return {
    name: slot.name,
    displayName: slot.displayName || slot.name,
    count: typeof slot.count === 'number' ? slot.count : 1,
  }
}

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

const ARMOR_DEFENSE_VALUES: Record<string, number> = {
  leather_helmet: 1,
  leather_chestplate: 3,
  leather_leggings: 2,
  leather_boots: 1,
  chainmail_helmet: 2,
  chainmail_chestplate: 5,
  chainmail_leggings: 4,
  chainmail_boots: 1,
  iron_helmet: 2,
  iron_chestplate: 6,
  iron_leggings: 5,
  iron_boots: 2,
  golden_helmet: 2,
  golden_chestplate: 5,
  golden_leggings: 3,
  golden_boots: 1,
  diamond_helmet: 3,
  diamond_chestplate: 8,
  diamond_leggings: 6,
  diamond_boots: 3,
  netherite_helmet: 3,
  netherite_chestplate: 8,
  netherite_leggings: 6,
  netherite_boots: 3,
  turtle_helmet: 2,
}

function computeArmorValue(armor: ViewerHudState['armor']): number {
  let total = 0
  for (const piece of [armor.head, armor.torso, armor.legs, armor.feet]) {
    if (piece) {
      total += ARMOR_DEFENSE_VALUES[piece.name] || 0
    }
  }
  return Math.min(20, total)
}

function buildHudState(mineflayer: Mineflayer, recentChat: string[]): ViewerHudState {
  const slots = (mineflayer.bot.inventory?.slots ?? []) as Array<InventorySlotLike>
  const position = mineflayer.bot.entity?.position
  const selectedHotbarSlot = Math.min(
    8,
    Math.max(0, Math.trunc(toNumber((mineflayer.bot as { quickBarSlot?: number }).quickBarSlot))),
  )

  const armor = {
    head: toHudItem(slots[5]),
    torso: toHudItem(slots[6]),
    legs: toHudItem(slots[7]),
    feet: toHudItem(slots[8]),
    offhand: toHudItem(slots[45]),
  }

  return {
    botName: mineflayer.username,
    health: Math.max(0, Math.round(toNumber(mineflayer.bot.health))),
    food: Math.max(0, Math.round(toNumber((mineflayer.bot as { food?: number }).food))),
    experienceLevel: Math.max(0, Math.round(toNumber((mineflayer.bot as { experience?: { level?: number } }).experience?.level))),
    experienceProgress: Math.max(0, Math.min(1, toNumber((mineflayer.bot as { experience?: { progress?: number } }).experience?.progress))),
    armorValue: computeArmorValue(armor),
    position: {
      x: toNumber(position?.x),
      y: toNumber(position?.y),
      z: toNumber(position?.z),
    },
    dimension: String(mineflayer.bot.game?.dimension || 'unknown'),
    timeOfDay: Math.max(0, Math.round(toNumber(mineflayer.bot.time?.timeOfDay))),
    selectedHotbarSlot,
    heldItem: toHudItem(mineflayer.bot.heldItem as InventorySlotLike),
    hotbar: Array.from({ length: 9 }, (_, index) => toHudItem(slots[36 + index])),
    inventory: Array.from({ length: 27 }, (_, index) => toHudItem(slots[9 + index])),
    armor,
    recentChat,
  }
}

// ---------------------------------------------------------------------------
// Texture loading
// ---------------------------------------------------------------------------

function resolveTexturesDir(): string {
  const require = createRequire(import.meta.url)
  const viewerPkgPath = require.resolve('prismarine-viewer/package.json')
  return join(dirname(viewerPkgPath), 'public', 'textures', '1.20.1')
}

async function loadHudSprites(texturesDir: string): Promise<HudSprites> {
  const hudDir = join(texturesDir, 'gui', 'sprites', 'hud')

  async function toDataUri(relativePath: string): Promise<string> {
    const buffer = await readFile(join(hudDir, relativePath))
    return `data:image/png;base64,${buffer.toString('base64')}`
  }

  return {
    hotbar: await toDataUri('hotbar.png'),
    hotbarSelection: await toDataUri('hotbar_selection.png'),
    crosshair: await toDataUri('crosshair.png'),
    heartContainer: await toDataUri('heart/container.png'),
    heartFull: await toDataUri('heart/full.png'),
    heartHalf: await toDataUri('heart/half.png'),
    foodEmpty: await toDataUri('food_empty.png'),
    foodFull: await toDataUri('food_full.png'),
    foodHalf: await toDataUri('food_half.png'),
    xpBarBackground: await toDataUri('experience_bar_background.png'),
    xpBarProgress: await toDataUri('experience_bar_progress.png'),
    armorEmpty: await toDataUri('armor_empty.png'),
    armorFull: await toDataUri('armor_full.png'),
    armorHalf: await toDataUri('armor_half.png'),
  }
}

async function loadItemTextureMap(texturesDir: string): Promise<Record<string, string>> {
  const raw = await readFile(join(texturesDir, 'texture_content.json'), 'utf8')
  const entries = JSON.parse(raw) as Array<{ name: string, texture: string | null }>
  const map: Record<string, string> = {}
  for (const entry of entries) {
    if (entry.texture) {
      map[entry.name] = entry.texture
    }
  }
  return map
}

// ---------------------------------------------------------------------------
// Network / response utilities
// ---------------------------------------------------------------------------

async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createNetServer()
    server.once('error', () => {
      resolve(false)
    })
    server.once('listening', () => {
      server.close(() => {
        resolve(true)
      })
    })
    server.listen(port)
  })
}

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': 'text/html; charset=utf-8',
  })
  response.end(html)
}

function sendJson(response: ServerResponse, payload: unknown): void {
  response.writeHead(200, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

function sendNotFound(response: ServerResponse): void {
  response.writeHead(404, {
    'content-type': 'text/plain; charset=utf-8',
  })
  response.end('Not Found')
}

function sendServerError(response: ServerResponse): void {
  response.writeHead(500, {
    'content-type': 'text/plain; charset=utf-8',
  })
  response.end('Internal Server Error')
}

// ---------------------------------------------------------------------------
// Minecraft-authentic HUD HTML
// ---------------------------------------------------------------------------

function renderHudHtml(viewerPort: number, viewerPrefix: string, sprites: HudSprites): string {
  const dynamicSprites = JSON.stringify({
    heartContainer: sprites.heartContainer,
    heartFull: sprites.heartFull,
    heartHalf: sprites.heartHalf,
    foodEmpty: sprites.foodEmpty,
    foodFull: sprites.foodFull,
    foodHalf: sprites.foodHalf,
    armorEmpty: sprites.armorEmpty,
    armorFull: sprites.armorFull,
    armorHalf: sprites.armorHalf,
  })

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AIRI Minecraft HUD</title>
    <style>
      :root { --s: 3; }

      html, body {
        margin: 0; padding: 0;
        width: 100%; height: 100%;
        background: #000;
        overflow: hidden;
        font-family: monospace;
      }

      img {
        image-rendering: pixelated;
        image-rendering: -moz-crisp-edges;
        image-rendering: crisp-edges;
      }

      #viewer-frame {
        position: fixed; inset: 0;
        width: 100%; height: 100%;
        border: 0; background: #000;
      }

      #hud-root {
        position: fixed; inset: 0;
        pointer-events: none;
        color: #fff;
      }

      /* === CROSSHAIR === */
      #crosshair {
        position: absolute;
        left: 50%; top: 50%;
        transform: translate(-50%, -50%);
        width: calc(15px * var(--s));
        height: calc(15px * var(--s));
        mix-blend-mode: difference;
      }

      /* === CHAT === */
      #chat-area {
        position: absolute;
        left: calc(2px * var(--s));
        bottom: calc(40px * var(--s));
        width: calc(320px * var(--s));
        max-height: calc(100px * var(--s));
        overflow: hidden;
        display: flex;
        flex-direction: column;
        justify-content: flex-end;
      }

      #chat-lines {
        display: flex;
        flex-direction: column;
      }

      #chat-lines > div {
        font-size: calc(7px * var(--s));
        line-height: calc(9px * var(--s));
        padding: calc(1px * var(--s));
        background: rgba(0, 0, 0, 0.35);
        color: #fff;
        text-shadow: calc(1px * var(--s)) calc(1px * var(--s)) 0 #3f3f3f;
        white-space: pre-wrap;
        word-break: break-word;
      }

      /* === HUD BOTTOM === */
      #hud-bottom {
        position: absolute;
        bottom: calc(2px * var(--s));
        left: 50%;
        transform: translateX(-50%);
        display: flex;
        flex-direction: column;
        align-items: center;
      }

      /* === STATS ROW (hearts left, food right) === */
      #stats-row {
        width: calc(182px * var(--s));
        display: flex;
        justify-content: space-between;
        margin-bottom: calc(1px * var(--s));
        position: relative;
      }

      /* === ARMOR ROW === */
      #armor-row {
        position: absolute;
        top: calc(-10px * var(--s));
        left: 0;
        display: none;
      }

      .armor-icon {
        position: relative;
        width: calc(9px * var(--s));
        height: calc(9px * var(--s));
        margin-right: calc(-1px * var(--s));
        display: inline-block;
      }

      .armor-icon img {
        position: absolute;
        top: 0; left: 0;
        width: calc(9px * var(--s));
        height: calc(9px * var(--s));
      }

      /* === HEARTS === */
      #hearts-row {
        display: flex;
        flex-wrap: wrap-reverse;
        width: calc(81px * var(--s));
      }

      .heart {
        position: relative;
        width: calc(9px * var(--s));
        height: calc(9px * var(--s));
        margin-right: calc(-1px * var(--s));
      }

      .heart img {
        position: absolute;
        top: 0; left: 0;
        width: calc(9px * var(--s));
        height: calc(9px * var(--s));
      }

      /* === FOOD === */
      #food-row {
        display: flex;
        flex-direction: row-reverse;
        flex-wrap: wrap;
        width: calc(81px * var(--s));
      }

      .food-icon {
        position: relative;
        width: calc(9px * var(--s));
        height: calc(9px * var(--s));
        margin-left: calc(-1px * var(--s));
      }

      .food-icon img {
        position: absolute;
        top: 0; left: 0;
        width: calc(9px * var(--s));
        height: calc(9px * var(--s));
      }

      /* === XP BAR === */
      #xp-bar {
        position: relative;
        width: calc(182px * var(--s));
        height: calc(5px * var(--s));
        margin-bottom: calc(1px * var(--s));
      }

      #xp-bg, #xp-fill {
        width: calc(182px * var(--s));
        height: calc(5px * var(--s));
      }

      #xp-fill-wrap {
        position: absolute;
        top: 0; left: 0;
        height: calc(5px * var(--s));
        overflow: hidden;
      }

      #xp-level {
        position: absolute;
        top: calc(-7px * var(--s));
        left: 50%;
        transform: translateX(-50%);
        font-size: calc(6px * var(--s));
        line-height: 1;
        color: #80ff20;
        text-shadow:
          calc(1px * var(--s)) 0 0 #2d4a08,
          calc(-1px * var(--s)) 0 0 #2d4a08,
          0 calc(1px * var(--s)) 0 #2d4a08,
          0 calc(-1px * var(--s)) 0 #2d4a08;
        display: none;
      }

      /* === HOTBAR === */
      #hotbar-container {
        position: relative;
        width: calc(182px * var(--s));
        height: calc(22px * var(--s));
      }

      #hotbar-bg {
        width: calc(182px * var(--s));
        height: calc(22px * var(--s));
      }

      #hotbar-sel {
        position: absolute;
        top: calc(-1px * var(--s));
        left: calc(1px * var(--s));
        width: calc(24px * var(--s));
        height: calc(23px * var(--s));
        transition: left 50ms ease;
      }

      #hotbar-items {
        position: absolute;
        top: calc(3px * var(--s));
        left: calc(3px * var(--s));
        display: flex;
        gap: calc(4px * var(--s));
      }

      .hslot {
        position: relative;
        width: calc(16px * var(--s));
        height: calc(16px * var(--s));
      }

      .hslot img {
        width: calc(16px * var(--s));
        height: calc(16px * var(--s));
      }

      .item-count {
        position: absolute;
        bottom: calc(1px * var(--s));
        right: 0;
        font-size: calc(6px * var(--s));
        line-height: 1;
        color: #fff;
        text-shadow: calc(1px * var(--s)) calc(1px * var(--s)) 0 #3f3f3f;
      }
    </style>
  </head>
  <body>
    <iframe id="viewer-frame" title="AIRI Minecraft View"></iframe>
    <div id="hud-root">
      <img id="crosshair" src="${sprites.crosshair}" alt="" />

      <div id="chat-area">
        <div id="chat-lines"></div>
      </div>

      <div id="hud-bottom">
        <div id="stats-row">
          <div id="armor-row"></div>
          <div id="hearts-row"></div>
          <div id="food-row"></div>
        </div>

        <div id="xp-bar">
          <img id="xp-bg" src="${sprites.xpBarBackground}" alt="" />
          <div id="xp-fill-wrap">
            <img id="xp-fill" src="${sprites.xpBarProgress}" alt="" />
          </div>
          <span id="xp-level"></span>
        </div>

        <div id="hotbar-container">
          <img id="hotbar-bg" src="${sprites.hotbar}" alt="" />
          <img id="hotbar-sel" src="${sprites.hotbarSelection}" alt="" />
          <div id="hotbar-items"></div>
        </div>
      </div>
    </div>

    <script>
      var viewerPort = ${viewerPort};
      var viewerPrefix = ${JSON.stringify(viewerPrefix)};
      var viewerPath = viewerPrefix ? (viewerPrefix + '/') : '/';
      var viewerUrl = window.location.protocol + '//' + window.location.hostname + ':' + viewerPort + viewerPath;
      document.getElementById('viewer-frame').src = viewerUrl;

      var SPRITES = ${dynamicSprites};

      var hotbarSel = document.getElementById('hotbar-sel');
      var hotbarItems = document.getElementById('hotbar-items');
      var heartsRow = document.getElementById('hearts-row');
      var foodRow = document.getElementById('food-row');
      var armorRowEl = document.getElementById('armor-row');
      var xpFillWrap = document.getElementById('xp-fill-wrap');
      var xpLevel = document.getElementById('xp-level');
      var chatLines = document.getElementById('chat-lines');

      var itemTextures = {};

      (function loadTextures() {
        fetch('/api/textures').then(function(r) { return r.json(); }).then(function(m) {
          itemTextures = m;
        }).catch(function() {});
      })();

      var prevHealth = -1, prevFood = -1, prevArmor = -1;

      function renderHotbar(hotbar, sel) {
        hotbarSel.style.left = 'calc(' + (1 + sel * 20) + 'px * var(--s))';
        hotbarItems.innerHTML = '';
        for (var i = 0; i < 9; i++) {
          var s = document.createElement('div');
          s.className = 'hslot';
          var item = hotbar[i];
          if (item) {
            var tex = itemTextures[item.name];
            if (tex) {
              var img = document.createElement('img');
              img.src = tex;
              s.appendChild(img);
            }
            if (item.count > 1) {
              var c = document.createElement('span');
              c.className = 'item-count';
              c.textContent = String(item.count);
              s.appendChild(c);
            }
          }
          hotbarItems.appendChild(s);
        }
      }

      function renderHearts(health) {
        if (health === prevHealth) return;
        prevHealth = health;
        heartsRow.innerHTML = '';
        for (var i = 0; i < 10; i++) {
          var h = document.createElement('div');
          h.className = 'heart';
          var bg = document.createElement('img');
          bg.src = SPRITES.heartContainer;
          h.appendChild(bg);
          var pts = Math.max(0, Math.min(2, health - i * 2));
          if (pts >= 2) {
            var f = document.createElement('img');
            f.src = SPRITES.heartFull;
            h.appendChild(f);
          } else if (pts >= 1) {
            var hf = document.createElement('img');
            hf.src = SPRITES.heartHalf;
            h.appendChild(hf);
          }
          heartsRow.appendChild(h);
        }
      }

      function renderFood(food) {
        if (food === prevFood) return;
        prevFood = food;
        foodRow.innerHTML = '';
        for (var i = 0; i < 10; i++) {
          var d = document.createElement('div');
          d.className = 'food-icon';
          var bg = document.createElement('img');
          bg.src = SPRITES.foodEmpty;
          d.appendChild(bg);
          var pts = Math.max(0, Math.min(2, food - i * 2));
          if (pts >= 2) {
            var f = document.createElement('img');
            f.src = SPRITES.foodFull;
            d.appendChild(f);
          } else if (pts >= 1) {
            var hf = document.createElement('img');
            hf.src = SPRITES.foodHalf;
            d.appendChild(hf);
          }
          foodRow.appendChild(d);
        }
      }

      function renderArmor(val) {
        if (val === prevArmor) return;
        prevArmor = val;
        armorRowEl.innerHTML = '';
        if (val <= 0) { armorRowEl.style.display = 'none'; return; }
        armorRowEl.style.display = 'flex';
        for (var i = 0; i < 10; i++) {
          var d = document.createElement('div');
          d.className = 'armor-icon';
          var bg = document.createElement('img');
          bg.src = SPRITES.armorEmpty;
          d.appendChild(bg);
          var pts = Math.max(0, Math.min(2, val - i * 2));
          if (pts >= 2) {
            var f = document.createElement('img');
            f.src = SPRITES.armorFull;
            d.appendChild(f);
          } else if (pts >= 1) {
            var hf = document.createElement('img');
            hf.src = SPRITES.armorHalf;
            d.appendChild(hf);
          }
          armorRowEl.appendChild(d);
        }
      }

      function renderXpBar(level, progress) {
        var w = Math.round(182 * (progress || 0));
        xpFillWrap.style.width = 'calc(' + w + 'px * var(--s))';
        if (level > 0) {
          xpLevel.textContent = String(level);
          xpLevel.style.display = '';
        } else {
          xpLevel.style.display = 'none';
        }
      }

      function renderChat(lines) {
        chatLines.innerHTML = '';
        var visible = lines.slice(-10);
        for (var i = 0; i < visible.length; i++) {
          var row = document.createElement('div');
          row.textContent = visible[i];
          chatLines.appendChild(row);
        }
      }

      var inFlight = false;

      function refreshState() {
        if (inFlight) return;
        inFlight = true;
        fetch('/api/state?t=' + Date.now(), { cache: 'no-store' })
          .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then(function(state) {
            renderHotbar(state.hotbar || [], state.selectedHotbarSlot || 0);
            renderHearts(state.health || 0);
            renderFood(state.food || 0);
            renderArmor(state.armorValue || 0);
            renderXpBar(state.experienceLevel || 0, state.experienceProgress || 0);
            renderChat(state.recentChat || []);
          })
          .catch(function() {})
          .then(function() { inFlight = false; });
      }

      refreshState();
      setInterval(refreshState, 400);
    </script>
  </body>
</html>`
}

// ---------------------------------------------------------------------------
// YouTube comments overlay (unchanged)
// ---------------------------------------------------------------------------

function renderYouTubeCommentsOverlayHtml(): string {
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AIRI YouTube Comments Overlay</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=M+PLUS+Rounded+1c:wght@400;700;800&family=Inter:wght@400;600;700&display=swap" rel="stylesheet" />
    <style>
      :root {
        --fg: #f0eef6;
        --fg-bright: #ffffff;
        --muted: rgba(220, 215, 240, 0.65);
        --accent: #b388ff;
        --accent-dim: rgba(179, 136, 255, 0.25);
        --accent-glow: rgba(179, 136, 255, 0.15);
        --card-bg: rgba(18, 12, 38, 0.78);
        --card-bg-hover: rgba(28, 18, 55, 0.85);
        --card-border: rgba(179, 136, 255, 0.18);
        --speech-bg: rgba(30, 15, 60, 0.88);
        --speech-border: rgba(179, 136, 255, 0.5);
        --panel-bg: rgba(12, 8, 28, 0.72);
        --panel-border: rgba(179, 136, 255, 0.12);
        --font-jp: "M PLUS Rounded 1c", "Yu Gothic UI", "Hiragino Sans", sans-serif;
        --font-ui: "Inter", "M PLUS Rounded 1c", sans-serif;
      }

      html, body {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
        background: transparent;
        color: var(--fg);
        overflow: hidden;
        font-family: var(--font-jp);
        -webkit-font-smoothing: antialiased;
      }

      #root {
        position: fixed;
        top: 0; right: 0; bottom: 0; left: 0;
        pointer-events: none;
      }

      #overlay-left {
        position: fixed !important;
        left: 20px !important;
        right: auto !important;
        bottom: 20px !important;
        width: 640px !important;
        height: 440px !important;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      /* ── AIra Speech Bubble ── */
      #aira-speech-panel {
        box-sizing: border-box;
        background: var(--speech-bg);
        border: 1.5px solid var(--speech-border);
        border-radius: 16px;
        padding: 14px 18px 12px;
        position: relative;
        display: none;
        backdrop-filter: blur(12px);
        box-shadow:
          0 0 20px rgba(179, 136, 255, 0.12),
          inset 0 1px 0 rgba(255, 255, 255, 0.06);
        animation: speechIn 0.3s ease-out;
      }

      #aira-speech-panel.visible { display: block; }

      @keyframes speechIn {
        from { opacity: 0; transform: translateY(6px); }
        to { opacity: 1; transform: translateY(0); }
      }

      #aira-speech-label {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 8px;
        font-family: var(--font-ui);
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--accent);
      }

      #aira-speech-label::before {
        content: "";
        display: inline-block;
        width: 8px; height: 8px;
        border-radius: 50%;
        background: var(--accent);
        box-shadow: 0 0 6px var(--accent);
        animation: pulse 2s ease-in-out infinite;
      }

      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }

      #aira-speech-text {
        font-size: 17px;
        line-height: 1.55;
        font-weight: 700;
        white-space: pre-wrap;
        word-break: break-word;
        color: var(--fg-bright);
        text-shadow: 0 1px 3px rgba(0,0,0,0.3);
      }

      #aira-reply-target {
        font-family: var(--font-ui);
        font-size: 11px;
        color: var(--muted);
        margin-top: 8px;
        padding-top: 7px;
        border-top: 1px solid rgba(179, 136, 255, 0.12);
        display: none;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #aira-reply-target.visible { display: block; }

      /* ── Comments Panel ── */
      #youtube-comments-panel {
        box-sizing: border-box;
        flex: 1;
        min-height: 0;
        background: var(--panel-bg);
        border: 1px solid var(--panel-border);
        border-radius: 16px;
        padding: 14px 14px 10px;
        overflow: hidden;
        backdrop-filter: blur(10px);
        box-shadow: 0 4px 24px rgba(0,0,0,0.25);
      }

      .panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 10px;
        padding-bottom: 8px;
        border-bottom: 1px solid rgba(179, 136, 255, 0.1);
      }

      .panel-title {
        font-family: var(--font-ui);
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        color: var(--accent);
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .panel-title::before {
        content: "💬";
        font-size: 13px;
      }

      .meta {
        font-family: var(--font-ui);
        font-size: 10px;
        color: var(--muted);
        font-weight: 600;
      }

      /* ── Comment Cards ── */
      #youtube-comments-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
        height: calc(100% - 38px);
        overflow: hidden;
      }

      .comment-card {
        min-height: 0;
        box-sizing: border-box;
        background: var(--card-bg);
        border: 1px solid var(--card-border);
        border-radius: 12px;
        padding: 10px 14px;
        overflow: hidden;
        transition: background 0.2s ease, border-color 0.2s ease;
        animation: cardIn 0.35s ease-out both;
      }

      @keyframes cardIn {
        from { opacity: 0; transform: translateX(-12px); }
        to { opacity: 1; transform: translateX(0); }
      }

      .comment-card:nth-child(1) { animation-delay: 0s; }
      .comment-card:nth-child(2) { animation-delay: 0.05s; }
      .comment-card:nth-child(3) { animation-delay: 0.1s; }
      .comment-card:nth-child(4) { animation-delay: 0.15s; }
      .comment-card:nth-child(5) { animation-delay: 0.2s; }

      .comment-card.highlight {
        border-color: var(--accent);
        background: var(--card-bg-hover);
        box-shadow: 0 0 12px var(--accent-glow), inset 0 0 12px var(--accent-glow);
      }

      .author {
        font-family: var(--font-ui);
        font-size: 12px;
        font-weight: 700;
        color: var(--accent);
        margin-bottom: 3px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .author::before {
        content: "@ ";
        opacity: 0.5;
      }

      .text {
        font-size: 14.5px;
        line-height: 1.45;
        white-space: pre-wrap;
        word-break: break-word;
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        color: var(--fg);
      }

      .time-badge {
        font-family: var(--font-ui);
        font-size: 10px;
        color: var(--muted);
        margin-top: 4px;
      }

      #avatar-reserved {
        position: fixed;
        right: 20px; bottom: 20px;
        width: 520px; height: 320px;
        pointer-events: none;
        background: transparent;
      }

      .empty {
        font-size: 13px;
        color: var(--muted);
        text-align: center;
        padding-top: 20px;
      }

      @media (max-width: 980px) {
        #overlay-left {
          left: 12px !important;
          bottom: 12px !important;
          width: 58vw !important;
          height: 360px !important;
        }
        #avatar-reserved {
          right: 12px; bottom: 12px;
          width: 38vw; height: 240px;
        }
      }
    </style>
  </head>
  <body>
    <div id="root">
      <div id="overlay-left">
        <div id="aira-speech-panel">
          <div id="aira-speech-label">AIra</div>
          <div id="aira-speech-text"></div>
          <div id="aira-reply-target"></div>
        </div>
        <div id="youtube-comments-panel">
          <div class="panel-header">
            <div class="panel-title">Live Chat</div>
            <div id="youtube-comments-meta" class="meta">Waiting...</div>
          </div>
          <div id="youtube-comments-list"></div>
        </div>
      </div>
      <div id="avatar-reserved"></div>
    </div>

    <script>
      const commentsMeta = document.getElementById('youtube-comments-meta');
      const commentsList = document.getElementById('youtube-comments-list');
      const airaSpeechPanel = document.getElementById('aira-speech-panel');
      const airaSpeechText = document.getElementById('aira-speech-text');
      const airaReplyTarget = document.getElementById('aira-reply-target');
      let inFlight = false;
      let lastReplyToId = '';

      function timeLabel(input) {
        if (!input) return '';
        const date = new Date(input);
        if (Number.isNaN(date.getTime())) return '';
        const hh = String(date.getHours()).padStart(2, '0');
        const mm = String(date.getMinutes()).padStart(2, '0');
        return hh + ':' + mm;
      }

      let prevSpeechText = '';
      let prevReplyToId = '';

      function renderAiraSpeech(payload) {
        const currentReply = payload.currentReply;
        const speechText = (currentReply && currentReply.speechText) || (payload.speechText || '');
        const comments = Array.isArray(payload.comments) ? payload.comments : [];

        if (!speechText) {
          if (prevSpeechText !== '') {
            airaSpeechPanel.className = '';
            airaSpeechText.textContent = '';
            airaReplyTarget.className = '';
            airaReplyTarget.textContent = '';
            prevSpeechText = '';
            prevReplyToId = '';
            lastReplyToId = '';
          }
          return;
        }

        const replyToId = currentReply ? (currentReply.replyToCommentId || '') : '';

        // Skip DOM updates if nothing changed
        if (speechText === prevSpeechText && replyToId === prevReplyToId) {
          return;
        }

        prevSpeechText = speechText;
        prevReplyToId = replyToId;
        lastReplyToId = replyToId;

        if (!airaSpeechPanel.classList.contains('visible')) {
          airaSpeechPanel.className = 'visible';
        }
        airaSpeechText.textContent = speechText;

        if (replyToId) {
          const targetComment = comments.find(function(c) { return c.id === replyToId; });
          if (targetComment) {
            airaReplyTarget.className = 'visible';
            airaReplyTarget.textContent = '\\u279C @' + (targetComment.author || 'viewer') + ' \\u300C' + (targetComment.text || '').slice(0, 40) + '\\u300D';
          } else {
            airaReplyTarget.className = '';
            airaReplyTarget.textContent = '';
          }
        } else {
          airaReplyTarget.className = '';
          airaReplyTarget.textContent = '';
        }
      }

      let prevVisibleIds = [];

      function renderComments(payload) {
        const commentsEnabled = Boolean(payload.commentsEnabled);
        const comments = Array.isArray(payload.comments) ? payload.comments : [];
        commentsMeta.textContent = commentsEnabled
          ? (comments.length + ' comments')
          : 'Disabled';

        renderAiraSpeech(payload);

        if (!commentsEnabled) {
          if (commentsList.querySelector('.empty-disabled')) return;
          commentsList.innerHTML = '<div class="empty empty-disabled">Comments overlay disabled</div>';
          prevVisibleIds = [];
          return;
        }
        if (comments.length === 0) {
          if (commentsList.querySelector('.empty-waiting')) return;
          commentsList.innerHTML = '<div class="empty empty-waiting">Waiting for comments...</div>';
          prevVisibleIds = [];
          return;
        }

        const visible = comments.slice(-5).reverse();
        const visibleIds = visible.map(function(c) { return c.id; });

        // Check if the list actually changed
        const listChanged = visibleIds.length !== prevVisibleIds.length
          || visibleIds.some(function(id, i) { return id !== prevVisibleIds[i]; });

        // Update highlight state without rebuilding DOM
        if (!listChanged) {
          const cards = commentsList.querySelectorAll('.comment-card');
          cards.forEach(function(card) {
            const cardId = card.getAttribute('data-id');
            if (lastReplyToId && cardId === lastReplyToId) {
              if (!card.classList.contains('highlight')) card.classList.add('highlight');
            } else {
              card.classList.remove('highlight');
            }
          });
          return;
        }

        prevVisibleIds = visibleIds;
        commentsList.innerHTML = '';

        for (const item of visible) {
          const card = document.createElement('div');
          card.className = 'comment-card';
          card.setAttribute('data-id', item.id);
          if (lastReplyToId && item.id === lastReplyToId) {
            card.classList.add('highlight');
          }

          const author = document.createElement('div');
          author.className = 'author';
          author.textContent = (item.author || 'viewer').replace(/^@/, '');
          card.appendChild(author);

          const text = document.createElement('div');
          text.className = 'text';
          text.textContent = item.text || '';
          card.appendChild(text);

          if (item.publishedAt) {
            const time = document.createElement('div');
            time.className = 'time-badge';
            time.textContent = timeLabel(item.publishedAt);
            card.appendChild(time);
          }

          commentsList.appendChild(card);
        }
      }

      async function refresh() {
        if (inFlight) return;
        inFlight = true;
        try {
          const response = await fetch('/api/youtube-comments-overlay?t=' + Date.now(), { cache: 'no-store' });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const payload = await response.json();
          renderComments(payload || {});
        } catch (error) {
          commentsMeta.textContent = 'Error';
          commentsList.innerHTML = '<div class="empty">Failed to load</div>';
        } finally {
          inFlight = false;
        }
      }

      refresh();
      setInterval(refresh, 900);
    </script>
  </body>
</html>`
}

// ---------------------------------------------------------------------------
// YouTube / subtitle loading (unchanged)
// ---------------------------------------------------------------------------

async function loadSubtitleOverlaySnapshot(): Promise<{
  speechEnabled: boolean
  speechText: string
  speechUpdatedAt: string
}> {
  const filePath = config.subtitle.filePath.trim()
  const speechEnabled = config.subtitle.enabled && filePath.length > 0
  if (!speechEnabled) {
    return {
      speechEnabled: false,
      speechText: '',
      speechUpdatedAt: new Date(0).toISOString(),
    }
  }

  try {
    const [raw, fileInfo] = await Promise.all([
      readFile(filePath, 'utf8'),
      stat(filePath),
    ])
    return {
      speechEnabled: true,
      speechText: raw.replace(/\r/g, '').trim(),
      speechUpdatedAt: fileInfo.mtime.toISOString(),
    }
  }
  catch {
    return {
      speechEnabled: true,
      speechText: '',
      speechUpdatedAt: new Date(0).toISOString(),
    }
  }
}

async function loadYouTubeRecentCommentsOverlayPayload(): Promise<YouTubeRecentCommentsOverlayPayload> {
  const commentsEnabled = config.youtube.commentOverlayRecentEnabled
  const filePath = config.youtube.commentOverlayRecentFilePath.trim()
  const speech = await loadSubtitleOverlaySnapshot()

  if (!commentsEnabled || !filePath) {
    return {
      commentsEnabled,
      updatedAt: new Date(0).toISOString(),
      comments: [],
      speechEnabled: speech.speechEnabled,
      speechText: speech.speechText,
      speechUpdatedAt: speech.speechUpdatedAt,
      currentReply: null,
    }
  }

  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as { updatedAt?: unknown, comments?: unknown[], currentReply?: unknown }
    const comments = Array.isArray(parsed.comments)
      ? parsed.comments
          .map((entry) => {
            const value = entry as Partial<YouTubeRecentCommentOverlayItem>
            const id = String(value.id || '').trim()
            const author = String(value.author || '').trim()
            const text = String(value.text || '').trim()
            const publishedAt = String(value.publishedAt || '').trim()
            if (!id || !text) {
              return null
            }
            return {
              id,
              author: author || 'viewer',
              text,
              publishedAt: publishedAt || new Date(0).toISOString(),
            }
          })
          .filter((entry): entry is YouTubeRecentCommentOverlayItem => entry !== null)
      : []

    let currentReply: YouTubeRecentCommentsOverlayPayload['currentReply'] = null
    if (parsed.currentReply && typeof parsed.currentReply === 'object') {
      const cr = parsed.currentReply as Record<string, unknown>
      const speechText = String(cr.speechText || '').trim()
      if (speechText) {
        currentReply = {
          speechText,
          replyToCommentId: String(cr.replyToCommentId || '').trim(),
          updatedAt: String(cr.updatedAt || new Date(0).toISOString()).trim(),
        }
      }
    }

    return {
      commentsEnabled: true,
      updatedAt: typeof parsed.updatedAt === 'string' && parsed.updatedAt.trim()
        ? parsed.updatedAt
        : new Date(0).toISOString(),
      comments,
      speechEnabled: speech.speechEnabled,
      speechText: speech.speechText,
      speechUpdatedAt: speech.speechUpdatedAt,
      currentReply,
    }
  }
  catch {
    return {
      commentsEnabled: true,
      updatedAt: new Date(0).toISOString(),
      comments: [],
      speechEnabled: speech.speechEnabled,
      speechText: speech.speechText,
      speechUpdatedAt: speech.speechUpdatedAt,
      currentReply: null,
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP request handler
// ---------------------------------------------------------------------------

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  mineflayer: Mineflayer,
  recentChat: string[],
  hudHtml: string,
  itemTextureJson: string,
): Promise<void> {
  const host = request.headers.host || 'localhost'
  const requestUrl = new URL(request.url || '/', `http://${host}`)
  const pathname = requestUrl.pathname
  const normalizedPath = pathname.replace(/\/+$/, '') || '/'

  if (normalizedPath === '/' || normalizedPath === '/index.html') {
    sendHtml(response, hudHtml)
    return
  }

  if (
    normalizedPath === '/youtube-comments-overlay'
    || normalizedPath === '/youtube-comments-overlay-v3'
    || normalizedPath === '/youtube-comments-overlay/index.html'
    || normalizedPath === '/youtube-comments-overlay-v3/index.html'
  ) {
    sendHtml(response, renderYouTubeCommentsOverlayHtml())
    return
  }

  if (normalizedPath === '/api/state') {
    sendJson(response, buildHudState(mineflayer, recentChat))
    return
  }

  if (normalizedPath === '/api/textures') {
    response.writeHead(200, {
      'cache-control': 'public, max-age=86400',
      'content-type': 'application/json; charset=utf-8',
    })
    response.end(itemTextureJson)
    return
  }

  if (normalizedPath === '/api/youtube-comments-overlay') {
    sendJson(response, await loadYouTubeRecentCommentsOverlayPayload())
    return
  }

  sendNotFound(response)
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

export function ViewerHudPlugin(overrides?: ViewerHudOptions): MineflayerPlugin {
  const logger = useLogger()

  let server: HttpServer | null = null
  let recentChat: string[] = []
  let onMessageString: ((message: string) => void) | null = null

  return {
    async spawned(mineflayer) {
      const enabled = overrides?.enabled ?? config.viewer.hudEnabled
      if (!enabled || !config.viewer.enabled) {
        return
      }
      if (server) {
        return
      }

      const viewerPort = overrides?.viewerPort ?? config.viewer.port
      const viewerPrefix = normalizePrefix(overrides?.viewerPrefix ?? config.viewer.prefix)
      const hudPort = overrides?.port ?? config.viewer.hudPort

      const available = await isPortAvailable(hudPort)
      if (!available) {
        logger.withField('port', hudPort).warn('HUD viewer port already in use, skipping HUD startup')
        return
      }

      // Load textures from prismarine-viewer
      let sprites: HudSprites
      let itemTextureJson: string
      let hudHtml: string
      try {
        const texturesDir = resolveTexturesDir()
        sprites = await loadHudSprites(texturesDir)
        const itemTextureMap = await loadItemTextureMap(texturesDir)
        itemTextureJson = JSON.stringify(itemTextureMap)
        hudHtml = renderHudHtml(viewerPort, viewerPrefix, sprites)
        logger.log('HUD textures loaded successfully')
      }
      catch (error) {
        logger.withError(error).warn('Failed to load HUD textures, HUD viewer will not start')
        return
      }

      recentChat = []
      onMessageString = (message: string) => {
        const normalized = message.trim()
        if (!normalized) {
          return
        }
        recentChat.push(normalized)
        if (recentChat.length > 16) {
          recentChat = recentChat.slice(-16)
        }
      }

      mineflayer.bot.on('messagestr', onMessageString)

      server = createHttpServer((request, response) => {
        void handleRequest(request, response, mineflayer, recentChat, hudHtml, itemTextureJson)
          .catch((error) => {
            logger.withError(error).warn('HUD viewer request handling failed')
            if (!response.headersSent) {
              sendServerError(response)
            }
          })
      })

      await new Promise<void>((resolve, reject) => {
        server?.once('error', reject)
        server?.listen(hudPort, () => resolve())
      })

      logger.withFields({
        hudPort,
        viewerPort,
        viewerPrefix: viewerPrefix || '/',
      }).log('AI HUD viewer started')
    },

    async beforeCleanup(mineflayer) {
      if (onMessageString) {
        mineflayer.bot.off('messagestr', onMessageString)
        onMessageString = null
      }

      if (!server) {
        return
      }

      await new Promise<void>((resolve) => {
        server?.close(() => resolve())
      })
      server = null
      recentChat = []
    },
  }
}

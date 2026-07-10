# Autonomous VTuber Setup (Minecraft Service)

This document describes the new autonomous streaming features added to `services/minecraft`.

## Features Added

- Structured autonomy decision provider with fallback rule logic
- Optional Gemini Live speech synthesis pass-through (Minecraft -> AIRI Stage)
- YouTube Live Chat polling + optional reply posting
- AI first-person browser viewer via `prismarine-viewer`
- Autonomous orchestration loop with social/comment weighting

## Environment Variables

Add these to `services/minecraft/.env.local` (or `.env`).

```env
# Primary LLM config (for planning/chat agents)
LLM_API_KEY=
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-5.4-mini
LLM_REASONING_MODEL=gpt-5.4-mini

# Minecraft bot connection
BOT_USERNAME=aira
BOT_HOSTNAME=localhost
BOT_PORT=25565
BOT_VERSION=1.20.4

# AIRI server websocket
AIRI_WS_BASEURL=ws://localhost:6121/ws
AIRI_CLIENT_NAME=minecraft-bot

# Autonomous decision LLM
AUTONOMY_LLM_ENABLED=true
AUTONOMY_LLM_API_KEY=
AUTONOMY_LLM_BASE_URL=https://api.openai.com/v1
AUTONOMY_LLM_MODEL=gpt-5.4-mini
AUTONOMY_LLM_LIVE_MODEL=
AUTONOMY_LLM_USE_LIVE_API=false
AUTONOMY_LLM_TEMPERATURE=0.6
AUTONOMY_LLM_MAX_OUTPUT_TOKENS=512

# Gemini Live speech synthesis (optional)
GEMINI_API_KEY=
GEMINI_BASE_URL=https://generativelanguage.googleapis.com
GEMINI_HTTP_MODEL=gemini-2.5-flash
GEMINI_LIVE_MODEL=gemini-2.5-flash-native-audio-preview-12-2025
GEMINI_LIVE_SPEECH_ENABLED=false
# If empty, speech will reuse GEMINI_LIVE_MODEL persistent session.
GEMINI_LIVE_SPEECH_MODEL=
# Optional (recommended for Japanese speech):
GEMINI_LIVE_SPEECH_LANGUAGE_CODE=ja-JP
# Optional prebuilt voice name:
GEMINI_LIVE_SPEECH_VOICE_NAME=

# Autonomy loop tuning
AUTONOMY_ENABLED=false
AUTONOMY_LOOP_INTERVAL_MS=30000
AUTONOMY_MIN_GOAL_INTERVAL_MS=20000
AUTONOMY_GOAL_LOCK_MS=120000
AUTONOMY_MAX_CONTEXT_MESSAGES=12
AUTONOMY_SELF_GOALS=Gather wood and basic resources near spawn,Improve safety around current base area,Explore nearby terrain for useful resources,Collect food and keep survival stable
AUTONOMY_SELF_GOAL_WEIGHT=1.0
AUTONOMY_SOCIAL_WEIGHT=0.7
AUTONOMY_COMMENT_WEIGHT=0.25

# YouTube Data API (read comments)
YOUTUBE_ENABLED=false
YOUTUBE_API_KEY=
YOUTUBE_LIVE_CHAT_ID=
YOUTUBE_POLL_INTERVAL_MS=6000
YOUTUBE_MAX_RESULTS=20
YOUTUBE_MAX_PENDING_MESSAGES=50

# YouTube reply posting (requires OAuth token with write scope)
YOUTUBE_REPLY_ENABLED=false
YOUTUBE_OAUTH_ACCESS_TOKEN=

# AI first-person viewer
VIEWER_ENABLED=false
VIEWER_PORT=3000
VIEWER_HUD_ENABLED=true
VIEWER_HUD_PORT=3001
VIEWER_FIRST_PERSON=true
VIEWER_VIEW_DISTANCE=8
VIEWER_PREFIX=
```

## Start Order

From repository root:

```bash
# 1) AIRI runtime server
pnpm -F @proj-airi/server-runtime dev

# 2) UI
pnpm -F @proj-airi/stage-web dev

# 3) Minecraft bot
pnpm -F @proj-airi/minecraft-bot dev
```

## AI Viewpoint (No Human Player POV Needed)

When `VIEWER_ENABLED=true`, open:

- `http://localhost:<VIEWER_PORT>/`
- `http://localhost:<VIEWER_HUD_PORT>/` (recommended for stream: HUD + inventory overlay)

This provides browser-based bot viewpoint controlled by the AI bot state.

## Notes

- If Minecraft server is not running, the bot process starts but ends with `ECONNREFUSED`.
- Bot `BOT_VERSION` must match actual Minecraft server version.
- YouTube read requires Data API key and `liveChatId`.
- YouTube reply requires OAuth access token; API key alone is not enough for posting.
- Gemini Live speech is attached to `output:gen-ai:chat:message` and played directly by Stage when present.
- Some API keys do not have access to `gemini-live-*` models; in that case the bot now automatically falls back to Gemini HTTP TTS models (for example `gemini-2.5-flash-preview-tts`).

## Local-Only Mode (Qwen + VoiceVox)

For RTX 3060 12GB / Ryzen 5 5500 / RAM 32GB, this profile is recommended:

- LLM: `qwen3:8b` for planner/chat via Ollama (OpenAI-compatible endpoint)
- Optional: `qwen3:8b-no-think` for autonomy decision output stabilization
- TTS: VoiceVox local engine
- STT: disabled (text input only)

### 1) Start local services

```bash
# Ollama (model download once)
ollama pull qwen3:8b
# create non-thinking alias (recommended for stable JSON/tool output)
ollama create qwen3:8b-no-think -f services/minecraft/docs/qwen3-no-think.modelfile
ollama serve

# VoiceVox Engine (run separately)
# default: http://127.0.0.1:50021
```

`start-airi-minecraft-local.bat` can auto-start VoiceVox if one of these is true:

- `VOICEVOX_EXE` env var points to `VOICEVOX.exe`
- VOICEVOX exists in common Windows install paths
- It also checks `http://127.0.0.1:50021/version` health after startup.

The launcher checks whether `LLM_BASE_URL` points at a local Ollama server and starts `ollama serve` when needed.

### 2) `.env.local` example

```env
# Core Minecraft/AIRI
BOT_USERNAME=aira
BOT_HOSTNAME=localhost
BOT_PORT=25565
BOT_VERSION=1.20.4
AIRI_WS_BASEURL=ws://localhost:6121/ws
AIRI_CLIENT_NAME=minecraft-bot

# Main planner/chat LLM -> local Ollama (must support tools)
LLM_BASE_URL=http://127.0.0.1:11434/v1
LLM_API_KEY=local-dev
LLM_MODEL=qwen3:8b
LLM_REASONING_MODEL=qwen3:8b

# Autonomy decision LLM -> local Ollama (OpenAI-compatible mode)
# You can use qwen3:8b-no-think here if you want stricter JSON output.
AUTONOMY_LLM_ENABLED=true
AUTONOMY_LLM_USE_LIVE_API=false
AUTONOMY_LLM_BASE_URL=http://127.0.0.1:11434/v1
AUTONOMY_LLM_API_KEY=local-dev
AUTONOMY_LLM_MODEL=qwen3:8b-no-think
AUTONOMY_LLM_LIVE_MODEL=qwen3:8b-no-think

# Disable cloud speech fallback
GEMINI_LIVE_SPEECH_ENABLED=false

# Local TTS (VoiceVox)
LOCAL_TTS_ENABLED=true
LOCAL_TTS_BASEURL=http://127.0.0.1:50021
LOCAL_TTS_SPEAKER=3
LOCAL_TTS_SPEED_SCALE=1.0
LOCAL_TTS_PITCH_SCALE=0.0
LOCAL_TTS_INTONATION_SCALE=1.0
LOCAL_TTS_VOLUME_SCALE=1.0

# Autonomy / viewer
AUTONOMY_ENABLED=true
VIEWER_ENABLED=true
VIEWER_HUD_ENABLED=true
```

### 3) Expected behavior

- Self-directed gameplay continues without cloud LLM dependency.
- Chat responses use local Qwen.
- Speech output uses local VoiceVox (`output:gen-ai:chat:message.voice`).

## 配信遅延同期（プレゼンテーション・タイムライン）

LLM+TTSの生成遅延（1〜8秒）を視聴者から見えなくするため、ゲーム映像だけを固定遅延させ、
発話をイベント発生時刻+遅延の時点（＝視聴者がその瞬間を見るタイミング）でリリースする。

### 設定

```env
# ゲーム映像の遅延と同じ値（ミリ秒）。0で無効（デフォルト）
STREAM_VIDEO_DELAY_MS=6000
```

### OBS側のセットアップ

1. **ゲーム映像ソースだけ**に遅延をかける（アバター・字幕ソースには掛けない）
   - ウィンドウキャプチャ/ゲームキャプチャ: フィルタ「映像遅延（非同期）」または
     「レンダリング遅延」(1個500ms上限、複数スタックで6秒=12個)
   - ゲーム音声がある場合: 音声の詳細プロパティで同期オフセットを同値に設定
2. 字幕ファイル（OBS_SUBTITLE_FILE）とアバター(stage)はリアルタイムのまま
   → 発話リリース時に字幕が書かれるため、遅延映像と自動的に同期する
3. Minecraft内チャット文字は遅延映像側に映るため、ボットは即時チャット送信でよい
   （音声がD秒後にリリースされる頃、画面にもチャットが映る）

### 動作

- 生成が遅延Dより速い → イベントが画面に映る瞬間に声が出る（体感遅延ゼロ）
- 生成がDより遅い → 即時再生（体感遅延は「実遅延-D」に圧縮）
- 大幅に遅れた実況コメントはドロップ（social replyは常に配信）

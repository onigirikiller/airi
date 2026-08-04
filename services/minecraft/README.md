# ⛏️ Minecraft agent player for [アイリ (AIRI)](https://airi.moeru.ai)

> [!NOTE]
>
> This project is part of the [Project アイリ (AIRI)](https://github.com/moeru-ai/airi), we aim to build a LLM-driven VTuber like [Neuro-sama](https://www.youtube.com/@Neurosama) (subscribe if you didn't!) if you are interested in, please do give it a try on [live demo](https://airi.moeru.ai).

An intelligent Minecraft bot powered by LLM. AIRI can understand natural language commands, interact with the world, and assist players in various tasks.

## 🎥 Preview

![demo](./docs/preview.avif)

## ✨ Features

- 🗣️ Natural language understanding
- 🏃‍♂️ Advanced pathfinding and navigation
- 🛠️ Block breaking and placing
- 🎯 Combat and PvP capabilities
- 🔄 Auto-reconnect on disconnection
- 📦 Inventory management
- 🤝 Player following and interaction
- 🌍 World exploration and mapping

## 🚀 Getting Started

### 📋 Prerequisites

- 📦 Node.js 23+
- 🔧 pnpm
- 🎮 A Minecraft server (1.20+)

### 🔨 Installation

1. Clone the repository:

```bash
# This fork, on the branch that carries the autonomy layer.
# Cloning moeru-ai/airi instead will give you upstream WITHOUT any of it.
git clone -b feat/autonomous-vtuber-overhaul https://github.com/onigirikiller/airi.git
cd airi/services/minecraft
```

2. Install dependencies:

```bash
pnpm install
```

3. Create a `.env.local` file with your configuration:

> [!NOTE]
> For all online accounts, un-comment the following line to toggle Microsoft authentication.
> Link for authentication will popup when the bot starts.
>
> After signed in, according to [how Minecraft protocol was implemented](https://github.com/PrismarineJS/node-minecraft-protocol/blob/bf89f7e86526c54d8c43f555d8f6dfa4948fd2d9/src/client/microsoftAuth.js#L7-L16)
> and also, [authentication flow implemented here](https://github.com/PrismarineJS/prismarine-auth/blob/1aef6e1387d94fca839f2811d17ac6659ae556b4/src/MicrosoftAuthFlow.js#L59-L69),
> the token will be cached with [the cache IDs specified here](https://github.com/PrismarineJS/prismarine-auth/blob/1aef6e1387d94fca839f2811d17ac6659ae556b4/src/MicrosoftAuthFlow.js#L88-L93)
> in split files:
>
> - `${hash}_live-cache.json`
> - `${hash}_mca-cache.json`
> - `${hash}_xbl-cache.json`
>
> inside of the directory provided by [`minecraft-folder-path`](https://github.com/simonmeusel/minecraft-folder-path)
>
> Linux: `~/.minecraft/nmp-cache/`
> macOS: `~/Library/Application Support/minecraft/nmp-cache/`
> Windows: `%appdata%/.minecraft/nmp-cache/`
>
> where `${hash}` is the `sha1` hash of the username you signing in with (as Minecraft username).

```env
LLM_API_KEY=your_openai_api_key
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-5.6-terra
LLM_REASONING_MODEL=gpt-5.6-terra
LLM_PUBLIC_SPEAK_MODEL=gpt-5.6-luna

AUTONOMY_LLM_ENABLED=true
AUTONOMY_LLM_API_KEY=your_autonomy_llm_api_key
AUTONOMY_LLM_BASE_URL=https://api.openai.com/v1
AUTONOMY_LLM_MODEL=gpt-5.6-terra

OPENAI_DAILY_TOKEN_LIMIT=2500000
OPENAI_DAILY_TOKEN_SOFT_STOP_RATIO=0.9
OPENAI_ALLOWED_MODELS=gpt-5.6-terra,gpt-5.6-luna

BOT_USERNAME=your_bot_username
BOT_HOSTNAME=localhost
BOT_PORT=25565
BOT_AUTH='microsoft' # comment if you use offline mode
BOT_VERSION=1.20
```

Official `api.openai.com` requests are rejected unless their model is listed in
`OPENAI_ALLOWED_MODELS`. Usage is persisted by UTC date under the operating
system temporary directory at `airi-minecraft-state/token-usage.json`. Reaching
the soft stop ends the bot with exit code `78`; supervisors must not restart it
until a human starts it after the next UTC daily reset.

### Local speech + external gameplay example

For a split setup where local Gemma + Irodori handle chat/public speech and the gameplay planner/autonomy side uses Gemini or GPT:

```env
AIRA_PERSONA_FILE=G:\airi\prompt.txt
AIRA_PERSONA_MODE=off

LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=gemma4:e4b
LLM_REASONING_MODEL=gemma4:e4b
LLM_PUBLIC_SPEAK_MODEL=gemma4:e2b

# Optional explicit speech-side override. Omit these to reuse LLM_* as-is.
SPEECH_LLM_BASE_URL=http://localhost:11434/v1
SPEECH_LLM_MODEL=gemma4:e4b
SPEECH_LLM_REASONING_MODEL=gemma4:e4b
SPEECH_LLM_PUBLIC_SPEAK_MODEL=gemma4:e2b

PUBLIC_SPEAK_PROVIDER=llm

AUTONOMY_LLM_ENABLED=true
AUTONOMY_LLM_API_KEY=your_gemini_or_openai_key
AUTONOMY_LLM_BASE_URL=https://generativelanguage.googleapis.com
AUTONOMY_LLM_MODEL=gemini-2.5-flash
AUTONOMY_LLM_USE_LIVE_API=false

LOCAL_TTS_ENABLED=true
LOCAL_TTS_PROVIDER=irodori-tts
LOCAL_TTS_BASEURL=http://127.0.0.1:5000
LOCAL_TTS_IRODORI_ENDPOINT_PATH=/voice
LOCAL_TTS_IRODORI_HF_CHECKPOINT=Aratako/Irodori-TTS-500M-v2-VoiceDesign
LOCAL_TTS_IRODORI_CAPTION=高校生くらいの若い声で、テンションは非常に高く、自分の宿命や封印された力を本気で信じている中二病的な話し方。闇、運命、封印、深淵、覚醒、終焉、神域、因果、観測者のような言葉を誇らしげに言う。芝居はかなり強めで、決め台詞ではしっかり勢いを出し、でも音としては明瞭に読んでください。
IRODORI_TTS_SERVER_CMD=G:\airi\tools\sbv2-venv\Scripts\python.exe G:\airi\tools\irodori-tts-server.py --host 127.0.0.1 --port 5000 --model-device cpu --codec-device cpu --hf-checkpoint Aratako/Irodori-TTS-500M-v2-VoiceDesign
```

`LLM_*` remains the shared fallback/default, `SPEECH_LLM_*` can now override only the chat/public-speak side, and `AUTONOMY_LLM_*` drives autonomy decisions plus planner generation. That keeps gameplay/control latency off the local speech queue while still allowing `.env.local`-only model swaps.

1. Start the bot:

```bash
pnpm dev
```

## 🎮 Usage

Once the bot is connected, you can interact with it using chat commands in Minecraft. All commands start with `#`.

### Basic Commands

- `#help` - Show available commands
- `#follow` - Make the bot follow you
- `#stop` - Stop the current action
- `#come` - Make the bot come to your location

### Natural Language Commands

You can also give the bot natural language commands, and it will try to understand and execute them. For example:

- "Build a house"
- "Find some diamonds"
- "Help me fight these zombies"
- "Collect wood from nearby trees"

## 🛠️ Development

### Project Structure

```
src/
├── agents/     # AI agent implementations
├── composables/# Reusable composable functions
├── libs/       # Core library code
├── mineflayer/ # Mineflayer plugin implementations
├── prompts/    # AI prompt templates
├── skills/     # Bot skills and actions
└── utils/      # Utility functions
```

### Commands

- `pnpm dev` - Start the bot in development mode
- `pnpm soak:supervisor` - Start an external supervisor that restarts the bot when it exits or stalls
- `pnpm lint` - Run ESLint
- `pnpm typecheck` - Run TypeScript type checking
- `pnpm test` - Run tests

### Soak Supervision

For long unattended soak tests, use the external supervisor instead of running the bot directly:

```bash
pnpm soak:supervisor
```

The supervisor:

- starts `pnpm start`
- writes per-run logs and supervisor events to `services/minecraft/runtime/soak-supervisor/`
- writes a rolling summary to `services/minecraft/runtime/soak-supervisor/summary.json`
- polls the monitor dashboard at `/api/state`
- restarts the bot when the process exits, monitor stops responding, stdout goes idle for too long, or the reported state stops changing for too long
- prunes old run logs so long soak runs do not grow without bound

Useful environment variables:

```env
SOAK_SUPERVISOR_MONITOR_URL=http://127.0.0.1:3002/api/state
SOAK_SUPERVISOR_POLL_INTERVAL_MS=5000
SOAK_SUPERVISOR_STDOUT_IDLE_TIMEOUT_MS=180000
SOAK_SUPERVISOR_STATE_STALL_TIMEOUT_MS=240000
SOAK_SUPERVISOR_MONITOR_FAILURE_TIMEOUT_MS=90000
SOAK_SUPERVISOR_STARTUP_GRACE_MS=60000
SOAK_SUPERVISOR_RESTART_BASE_DELAY_MS=5000
SOAK_SUPERVISOR_RESTART_MAX_DELAY_MS=60000
SOAK_SUPERVISOR_MAX_RESTARTS_PER_HOUR=20
SOAK_SUPERVISOR_MAX_RUN_LOGS=40
SOAK_SUPERVISOR_MAX_RUN_LOG_AGE_MS=604800000
SOAK_SUPERVISOR_MAX_RUN_LOG_BYTES=536870912
```

Supervisor state is written to:

- `runtime/soak-supervisor/status.json` for the latest live status
- `runtime/soak-supervisor/summary.json` for restart counts and recent failure reasons
- `runtime/soak-supervisor/events.ndjson` for the raw supervisor event stream

Stop it with `Ctrl+C`; the supervisor will terminate the current child process before exiting.

## 🙏 Acknowledgements

- https://github.com/kolbytn/mindcraft

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

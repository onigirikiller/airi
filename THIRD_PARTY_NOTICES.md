# Third-party notices

This repository is a fork of [moeru-ai/airi](https://github.com/moeru-ai/airi). **Except for the
file-level and bundled-tool exceptions documented below, fork-authored source code is distributed
under the MIT Licence** (see [LICENSE](LICENSE)).

Nothing here is legal advice; it is a good-faith record of what this repository contains and depends
on, and under what terms. If something is attributed incorrectly, please open an issue — a correction
is more useful than a takedown.

## Exceptions to MIT inside this repository

| Path | Licence | Why |
|---|---|---|
| [`tools/style-bert-vits2-server.py`](tools/style-bert-vits2-server.py) | **AGPL-3.0-only** | Imports [Style-Bert-VITS2](https://github.com/litagin02/Style-Bert-VITS2) modules directly (`style_bert_vits2.tts_model`, `.models.infer`, `.nlp`, `.constants`). Upstream is AGPL-3.0 without an "or later" grant, so this file is `-only`. Full text: [`LICENSES/AGPL-3.0-only.txt`](LICENSES/AGPL-3.0-only.txt). |
| `services/minecraft-fabric-mod/gradlew`, `gradlew.bat`, `gradle/wrapper/*` | **Apache-2.0** | Generated [Gradle](https://gradle.org/) Wrapper (Gradle 8.12) committed so the Fabric mod builds reproducibly. `gradle-wrapper.jar` carries its own licence metadata. Not fork-authored. |

### On separating from AGPL

Running the **official** Style-Bert-VITS2 server as its own process and pointing
`LOCAL_TTS_BASEURL` at it avoids importing AGPL code into the MIT-licensed agent process — the agent
only ever talks to a TTS backend over HTTP. That is a separation of *processes and code linkage*, and
it is worth being precise about what it does not do:

- **This repository remains mixed-licence** while `tools/style-bert-vits2-server.py` is present. Only
  moving that file out to its own repository would let anyone say AGPL code has been excluded here.
- **The official Style-Bert-VITS2 server remains AGPL-licensed** however you run it, and AGPL section
  13 still applies to a modified version you expose over a network.

## Upstream

| Project | Licence | Relationship |
|---|---|---|
| [moeru-ai/airi](https://github.com/moeru-ai/airi) | MIT | This repository is a fork. Copyright (c) 2024-PRESENT Neko Ayaka. Upstream `LICENSE` and copyright notice preserved unchanged. |

## Imported directly, not vendored

These are imported by code in this repository but installed separately by the user.

| Dependency | Licence | Notes |
|---|---|---|
| [Style-Bert-VITS2](https://github.com/litagin02/Style-Bert-VITS2) | AGPL-3.0 | See the exception above. |
| [Irodori-TTS](https://github.com/Aratako/Irodori-TTS) | MIT | [`tools/irodori-tts-server.py`](tools/irodori-tts-server.py) imports `irodori_tts.inference_runtime` directly inside `load_irodori_symbols`, rather than at module scope, and exposes it through a local HTTP API. Because Irodori-TTS is MIT, this wrapper can remain MIT provided the upstream copyright notice and licence conditions are honoured. Not vendored. |
| [huggingface_hub](https://github.com/huggingface/huggingface_hub) | Apache-2.0 | Used by the Irodori wrapper to fetch model files. |

## Not redistributed here — supply these yourself

| Dependency | Licence | Notes |
|---|---|---|
| [Baritone](https://github.com/cabaletta/baritone) | LGPL-3.0 | The Fabric mod compiles against the Baritone API and calls it reflectively as an optional dependency. The jars are **not** in this repository — see [`services/minecraft-fabric-mod/README.md`](services/minecraft-fabric-mod/README.md). If you ever bundle the jars in a release artefact you take on LGPL obligations: ship the licence text, state how to obtain the source, and keep it replaceable. |
| Style-Bert-VITS2 voice model weights | Per model card | Voice models carry their own corpus licences, frequently more restrictive than the code. Check the specific model card before any public use. |
| Irodori-TTS model weights | Per model card | Same caveat. |
| Minecraft | Mojang / Microsoft EULA | Supplied by the user's own installation. |
| [Fabric Loader](https://github.com/FabricMC/fabric-loader) | Apache-2.0 | User-installed. |
| [Fabric API](https://github.com/FabricMC/fabric) | Apache-2.0 | User-installed. |
| [Yarn mappings](https://github.com/FabricMC/yarn) | CC0-1.0 | Build-time mappings, resolved by Gradle. |
| Language model weights (Gemma, Gemini, Qwen, …) | Per model licence | Nothing bundled. Pulled at runtime from Ollama, LM Studio or a hosted API, and governed by their own terms — including territorial restrictions on some hosted models. |

## Runtime dependencies

Node and Python package dependencies are declared in `package.json` / `pnpm-lock.yaml` and the
requirements of the scripts under `tools/`. They are fetched at install time rather than vendored, and
each remains under its own licence.

## Tracked `.env` files

Several `.env` files are tracked by git — deliberately, because they carry public defaults.
**Tracked `.env` files contain public defaults and placeholders only.** All six carry a warning
header saying so.

Use gitignored `.env.local` files where the relevant app or service supports them, and check that
package's startup script for its exact loading behaviour — it is not uniform across the monorepo:

| Package | Mechanism |
|---|---|
| `services/minecraft`, `services/discord-bot`, `services/satori-bot`, `services/telegram-bot` | Node `--env-file=.env --env-file-if-exists=.env.local`, so `.env.local` overrides |
| `apps/server` | `dotenvx run -f .env -f .env.local --overload` via the `apply:env` script — used by `dev`, `auth:generate` and `db:push`, but **not** by `start`, which runs `tsx src/app.ts` with no env loading |
| `packages/stage-ui` | No env loading in its own scripts |

**Never place real API keys or tokens in a tracked `.env` file.**

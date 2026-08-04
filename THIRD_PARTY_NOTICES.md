# Third-party notices

This repository is a fork of [moeru-ai/airi](https://github.com/moeru-ai/airi) and is distributed
under the **MIT Licence** (see [LICENSE](LICENSE)) — **with one documented exception**, listed first
below. Nothing here is legal advice; it is a good-faith record of what this repository depends on and
under what terms.

## Exception to the MIT licence in this repository

| File | Licence | Why |
|---|---|---|
| [`tools/style-bert-vits2-server.py`](tools/style-bert-vits2-server.py) | **AGPL-3.0-or-later** | It imports [Style-Bert-VITS2](https://github.com/litagin02/Style-Bert-VITS2) modules directly (`style_bert_vits2.tts_model`, `.models.infer`, `.nlp`, `.constants`), and that project is AGPL-3.0. The file carries an `SPDX-License-Identifier` header saying so. |

**If you want to avoid AGPL obligations, do not use that wrapper.** Run the official Style-Bert-VITS2
server as its own process and point `LOCAL_TTS_BASEURL` at it. The agent only ever talks to a TTS
backend over HTTP, so nothing else in this repository links against AGPL code.

Every other file in this repository is MIT.

## Upstream

| Project | Licence | Relationship |
|---|---|---|
| [moeru-ai/airi](https://github.com/moeru-ai/airi) | MIT | This repository is a fork of it. Copyright (c) 2024-PRESENT Neko Ayaka. Upstream `LICENSE` and copyright notice are preserved unchanged. |

## Not redistributed here — you must supply these yourself

These are dependencies the project uses but which this repository deliberately does **not** contain,
so that no file in it is distributed under terms it cannot satisfy.

| Dependency | Licence | Notes |
|---|---|---|
| [Baritone](https://github.com/cabaletta/baritone) | LGPL-3.0 | The Fabric mod compiles against the Baritone API and calls it reflectively as an optional dependency. The jars are **not** in this repository — see [`services/minecraft-fabric-mod/README.md`](services/minecraft-fabric-mod/README.md) for where to get them. If you ever bundle the jars in a release artefact, you take on LGPL obligations: ship the licence text, state how to obtain Baritone's source, and keep it replaceable. |
| [Style-Bert-VITS2](https://github.com/litagin02/Style-Bert-VITS2) | AGPL-3.0 | Not vendored. Installed separately by the user. See the exception above. |
| Style-Bert-VITS2 voice model weights | Per model card | Not in this repository. Voice models carry their own corpus licences, which are frequently more restrictive than the code. Check the specific model card before any public use. |
| [Irodori-TTS](https://github.com/Aratako/Irodori-TTS) | MIT (code) | [`tools/irodori-tts-server.py`](tools/irodori-tts-server.py) is a plain HTTP client using only the Python standard library — it does not import Irodori-TTS, so no licence propagates. Model weights are a separate matter and follow their own model cards. |
| Minecraft, Fabric Loader, Fabric API, Yarn mappings | Mojang EULA / Apache-2.0 | Standard modding dependencies, supplied by the user's own installation. |
| Language model weights (Gemma, Gemini, Qwen, …) | Per model licence | Nothing is bundled. Models are pulled at runtime from Ollama, LM Studio or a hosted API, and remain governed by their own terms — including territorial restrictions on some hosted models. |

## Runtime dependencies

Node and Python package dependencies are declared in `package.json` / `pnpm-lock.yaml` and the
`requirements` of the scripts under `tools/`. They are fetched at install time rather than vendored,
and each remains under its own licence.

## Reporting a problem

If you believe something here is attributed incorrectly or is licensed in a way this file
misrepresents, please open an issue. Licence mistakes are worth fixing quickly, and a correction is
more useful than a takedown.

# AIRI MC Bridge (Fabric mod)

A Fabric mod that exposes the running Minecraft client to the autonomy layer in
[`services/minecraft`](../minecraft) over a local WebSocket. The TypeScript side talks to this mod
instead of driving the game directly, which is what lets the agent read real inventory and block
state rather than guessing from chat output.

## Why this exists

`mineflayer` alone runs a headless bot with its own world model. This bridge runs *inside* the real
client, so the agent sees what a player sees: the actual inventory (including slot indices and
armour), the actual blocks in range, and the actual result of a placement attempt. Several bugs in
[`AUTONOMY_WORKLOG.md`](../../AUTONOMY_WORKLOG.md) were only diagnosable because the bridge could
report ground truth back.

## Requirements

| Component | Version |
|---|---|
| Minecraft | 1.20.4 |
| Fabric Loader | 0.16.10 |
| Fabric API | 0.91.2+1.20.4 |
| Yarn mappings | 1.20.4+build.3 |
| Java | 17+ |
| Baritone | 1.10.4 |

Versions are pinned in [`gradle.properties`](gradle.properties).

## Baritone is not bundled here

The mod compiles against and delegates pathfinding to **[Baritone](https://github.com/cabaletta/baritone)**,
which is licensed under **LGPL-3.0**. This repository is MIT, so the Baritone jars are deliberately
**not** redistributed — you need to fetch them yourself. This is a one-time step:

1. Download the Fabric build of Baritone `1.10.4` for Minecraft 1.20.4 from the
   [Baritone releases page](https://github.com/cabaletta/baritone/releases).
2. Place `baritone-api-fabric-1.10.4.jar` in `libs/` — needed to **compile**.
3. Place `baritone-standalone-fabric-1.10.4.jar` in your Minecraft `mods/` folder — needed to **run**.

`build.gradle.kts` resolves `libs/` through a `flatDir` repository, so no further configuration is
required once the api jar is in place.

## Build

```bash
./gradlew build
```

On Windows, [`setup.bat`](setup.bat) will locate a JDK (falling back to the JBR shipped with Android
Studio if `JAVA_HOME` is unset) and run the build for you.

The built mod lands in `build/libs/airi-mcbridge-<version>.jar`. Copy it into your Minecraft `mods/`
folder alongside Fabric API and the Baritone standalone jar.

## Handlers

`src/main/java/com/airi/mcbridge/` is organised by concern:

| Handler | Responsibility |
|---|---|
| `AiriMcBridge` | Mod entrypoint, WebSocket listener lifecycle |
| `BaritoneHelper` | Delegates goal-based movement to Baritone |
| `BlockHandler` | Block queries, breaking and placement with verified outcomes |
| `ChatHandler` | Chat send and receive |
| `CombatHandler` | Attack and target selection |

## Licence

MIT, as part of this repository — see [LICENSE](LICENSE). Baritone remains LGPL-3.0 and is used as an
unmodified external dependency that you supply yourself; it is not covered by this licence and is not
distributed here.

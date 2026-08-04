# Soak Debug Handoff (2026-03-02)

This memo records the long-running Minecraft bot debugging work completed before a full PC restart.

## Current state before reboot

- The bot is currently running under the soak supervisor.
- The current child run is:
  - `services/minecraft/runtime/soak-supervisor/run-2026-03-02T03-05-54-097Z.log`
- The current supervisor status is tracked in:
  - `services/minecraft/runtime/soak-supervisor/status.json`
- The current run is intentionally blocked with:
  - `Bridge capability blocked craft sync: installed bridge jar is newer than the running Fabric mod build; Minecraft restart required`

This block is expected and correct. The newer `airi-mcbridge` jar has already been built and copied into `.minecraft/mods`, but the currently running Minecraft session has not loaded that new build yet.

## Main fixes completed

### 1. Runner phase safety and cave readiness

Files:
- `services/minecraft/src/runner/phases.ts`
- `services/minecraft/src/runner/phases.test.ts`

Changes:
- Phase progression now uses actual inventory for critical gates.
- The runner no longer treats optimistic craft results as real progression.
- Early game and iron age now avoid cave progression when safe mining kit requirements are not met.
- Underground/bootstrap recovery was improved to prefer surface escape instead of bad cave plans.
- Early game now immediately returns a restart-required failure when the running bridge build is stale and the starter kit is not actually present.

### 2. Environment classification

Files:
- `services/minecraft/src/libs/llm-agent/world-state.ts`
- `services/minecraft/src/libs/llm-agent/world-state.test.ts`

Changes:
- Surface vs underground classification was refined.
- Shallow surface pockets and forest/plains high-Y terrain are less likely to be misclassified as `underground_cave`.
- This improves planning quality, especially when deciding whether to escape to surface or continue resource gathering.

### 3. FabricBridge craft/inventory reconciliation

Files:
- `services/minecraft/src/libs/fabric-bridge/bot-proxy.ts`
- `services/minecraft/src/libs/fabric-bridge/bot-proxy.test.ts`

Changes:
- Craft responses are no longer blindly overwritten by a stale immediate `getInventory` response.
- If the craft response inventory shows progress and the immediate refresh looks older, the bridge keeps the craft response snapshot.
- This specifically targets `birch_planks` / inventory craft sync failures.

### 4. Fabric mod crafting behavior

Files:
- `services/minecraft-fabric-mod/src/main/java/com/airi/mcbridge/handlers/InventoryHandler.java`

Changes:
- `getInventory` now forces `sendContentUpdates()` before serializing inventory.
- Craft output transfer now uses `SlotActionType.QUICK_MOVE` instead of manual cursor pickup/placement.
- Additional diagnostics were added for craft output movement failures:
  - `before=<count>`
  - `after=<count>`
  - `produced=<count>`

This is the main fix that should be validated after the Minecraft restart.

### 5. Bridge stale-build detection

Files:
- `services/minecraft/src/libs/fabric-bridge/index.ts`
- `services/minecraft/src/runner/phases.ts`
- `services/minecraft/src/runner/index.ts`

Changes:
- The bot can now detect when the installed bridge jar on disk is newer than the currently running Fabric mod build.
- That condition is surfaced as a clear restart-required external block instead of letting the bot spam failing craft attempts.

### 6. Supervisor stability

Files:
- `services/minecraft/scripts/soak-supervisor.ts`
- `services/minecraft/src/supervisor/soak.ts`
- `services/minecraft/src/supervisor/soak.test.ts`

Changes:
- `stdout_idle_timeout` no longer fires just because stdout is quiet; it now also requires state inactivity.
- Restart-required blocks are recognized and given long backoff.
- The supervisor now cleans up orphaned bot lock holders before starting a new child.
- This fixed the case where a stale `src/main.ts` grandchild process kept the instance lock and caused repeated `process_exit:1`.

Live evidence:
- `events.ndjson` now contains `orphan_lock_process_detected`, confirming the orphan cleanup worked.

### 7. Viewer/UX preparation

Files:
- `services/minecraft-fabric-mod/src/main/java/com/airi/mcbridge/state/StateEmitter.java`

Changes:
- Position/state emission frequency was increased from about 200ms to about 100ms.
- This should reduce first-person viewer jerkiness after the next Minecraft restart.

## Files already updated in `.minecraft/mods`

These were already copied before the reboot:

- `%APPDATA%\\.minecraft\\mods\\airi-mcbridge-0.1.0.jar`
- `%APPDATA%\\.minecraft\\mods\\baritone-unoptimized-fabric-1.10.4.jar`

## What should be true after reboot

After restarting Minecraft and reopening the world, the following should happen:

1. The bot should connect and report the new bridge build in logs.
2. The previous restart-required block should disappear.
3. `birch_planks` inventory crafting should either:
   - start succeeding, or
   - fail with the new `before/after/produced` diagnostics from the Fabric mod.
4. The supervisor should not thrash due to stale instance locks.
5. First-person viewer movement should look smoother because of the higher position update rate.

## First things to check after reboot

1. Minecraft log:
   - `%APPDATA%\\.minecraft\\logs\\latest.log`
   - Confirm the loaded bridge build matches the newly copied mod jar.

2. Supervisor status:
   - `services/minecraft/runtime/soak-supervisor/status.json`
   - Confirm `blockedReason` is no longer the restart-required craft-sync block.

3. Bot run log:
   - Latest `services/minecraft/runtime/soak-supervisor/run-*.log`
   - Look for:
     - `Successfully crafted ..._planks`
     - or the new inventory movement diagnostic if craft still fails

## Known remaining high-priority issue

The most important unresolved issue is still inventory crafting sync for planks and early bootstrap crafting, but the next reboot is required before the latest mod-side fixes can be verified.

## Validation already completed before reboot

- `pnpm -F @proj-airi/minecraft-bot typecheck`
- `pnpm -F @proj-airi/minecraft-bot exec vitest run src/libs/fabric-bridge/bot-proxy.test.ts`
- `pnpm -F @proj-airi/minecraft-bot exec vitest run src/supervisor/soak.test.ts src/runner/phases.test.ts`
- targeted `eslint` on modified TypeScript files
- Fabric mod builds via:
  - `services/minecraft-fabric-mod/gradlew.bat build`

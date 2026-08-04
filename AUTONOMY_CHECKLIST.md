# AUTONOMY_CHECKLIST

## In Progress

- [ ] Extend evaluator-driven objectives from fallback/prompt into broader planner/base-builder execution.
- [ ] Keep the newly surfaced `wood recovered` state from immediately collapsing into cave-prep / food stall replacements before it reaches a stable surface food+sword buffer.
- [ ] Live-validate that enclosed shaft recovery now uses scaffold pillar escape when vertical pathfinding cannot raise the bot.
- [ ] Live-validate that the live daemon now keeps the Minecraft bot process alive in deferred bridge-wait mode when the game window is already open but the Fabric listener is late.
- [ ] Unblock `Prepare supplies (food, torches, sword) for cave exploration` so the bot can leave the cramped underground state, regain food on the surface, and re-enter iron acquisition.
- [ ] Re-run a longer live soak from the verified crafting-table milestone to confirm surface escape -> food prep -> iron pickaxe -> diamond acquisition end-to-end.
- [ ] Live-extend the recovered wood/bootstrap state from visible `oak_log` inventory into crafting table -> sword -> shelter -> iron progression without regressing on empty bridge inventory snapshots.
- [ ] Run the next live soak in an environment where Node child-process spawn is permitted; the current sandbox still blocks the supervisor child with `spawn EPERM` even after launcher degradation fixes.
- [ ] Stabilize Fabric bridge inventory reads so transient empty `getInventory` snapshots do not erase the last visible non-empty inventory/tool state during live play.
- [ ] Live-validate that the new persisted bridge resume cache reloads the last visible inventory across a bot restart instead of regressing straight back to empty bootstrap facts.
- [ ] Explain or eliminate the remaining mismatch between focused Minecraft window captures and bridge telemetry before using screenshots as the primary state source again; the latest `runtime/minecraft-observation/minecraft-window-20260419-221928.png` still shows an empty hotbar after the runtime log verified `wooden_pickaxe + wooden_sword`.
- [ ] Live-validate that the new surface-first `Collect nearby food` handoff now survives past the first successful surface escape and resumes stable food/wood gathering instead of falling back into cave-prep stalls.
- [ ] Eliminate the remaining near-surface shaft-trap stop where pillar recovery aborts because the headroom probe resolves as `unknown`.
- [ ] Stabilize surfaced food acquisition when only nearby fish are visible; the latest live soak still ends `searchForEntity(animal)` with `search_target_not_locked` and can stall `attack(animal)` on salmon with no combat progress.
- [ ] Finish converting the broader distinct-tree wood relocation strategy into actual reachable trunk acquisition so empty coastal restarts can reach `cobblestone -> stone_pickaxe` live before the food/sword handoff times out.
- [ ] Convert the newly live-verified `wooden_pickaxe + wooden_sword` shoreline state into stable food buffering and a temporary shelter instead of dropping straight back into recovery `searchForBlock(grass_block) -> moveAway` loops.
- [ ] Live-validate that tree-canopy surface scenes no longer misclassify `Collect nearby food` as underground recovery when nearby sky windows are visible.
- [ ] Live-validate that generic temporary-shelter fallback now uses currently held `dirt` / planks / logs instead of blocking immediately on an implicit `cobblestone` requirement.
- [ ] Live-validate the post-pickaxe safety gate so low-hunger stone/iron mining is replaced with food or surface resupply before deeper cave travel.
- [ ] Re-run a longer soak from the newly verified `wooden_pickaxe` checkpoint and require safe surface/food recovery before iron progression.
- [ ] Live-validate that confirmed furnace placement either opens the real GUI or fails fast when the selected hand item is still a different block.
- [ ] Suppress or reroute public speech when the configured LLM provider returns persistent 404s, without affecting gameplay action scheduling.

## Done

- [x] Canonical inventory snapshot, hotbar policy, equip contract, and recovery rails are live in `services/minecraft`.
- [x] Bridge capability handshake and unsupported-command session memory exist for Fabric bridge commands.
- [x] Blocked-step suppression and deterministic stall recovery are wired into planning/orchestration.
- [x] Recovery backpressure suppresses noncritical speech during stalls and capability failures.
- [x] Fixed long-term roadmap fallback in `decision-provider.ts` was replaced with `TargetSpec + GapReport + ObjectiveProposal`.
- [x] Base/interior status is emitted in canonical world-state and decision prompts.
- [x] Objective framework, base evaluation, and prompt injection regressions are covered by tests.
- [x] Repeatable Minecraft screenshot capture utility exists and has been exercised against the live client.
- [x] Focused gameplay/autonomy tests passed after the refactor.
- [x] Combat inventory policy now keeps swords in an immediate hotbar slot and prefers shields in offhand via deterministic organizer/preflight logic.
- [x] Live inventory organization no longer deadlocks on unsupported slot-management commands or lost Fabric bridge method binding.
- [x] Non-oak wood inventories can now satisfy the default plank bootstrap, and the crafting-table milestone has been live-verified after the fix.
- [x] Underground cave-prep failure recovery now has a deterministic surface-escape fast path instead of only local food/combat retries.
- [x] Planner-backed autonomy now has a direct `recoverTowardSurface` action instead of relying only on generic `moveAway` / coordinate hops for shaft escape.
- [x] Surface recovery now has a generic scaffold-based pillar fallback for enclosed shaft traps that cannot climb via pure pathfinding.
- [x] Canonical world-state and objective prompts now expose `shaft_trap` + scaffold availability so surface recovery can be selected from the current terrain instead of a generic underground label alone.
- [x] Fabric bridge startup can now stay alive in deferred-connect mode instead of failing the whole bot when the bridge is late at process start.
- [x] Live daemon startup now degrades through `Win32_Process` access denial and bypasses corepack/pnpm so it can at least reach supervisor launch against an already-open Minecraft client.
- [x] Diamond progression no longer treats generic combat gear as mining readiness; `pickaxeTier` now gates iron/diamond mining decisions.
- [x] Progress snapshots now extend beyond `iron-smelting` into `iron-pickaxe`, `diamond-acquisition`, and `diamond-loadout`.
- [x] Structured planner recipes now cover explicit diamond armor craft goals instead of stopping at `diamond_pickaxe`.
- [x] Surface-recovery fast path now prioritizes `searchForBlock(grass_block)` and `moveAway` before blind local `goToCoordinates` climbs.
- [x] Planner and runner surface recovery now lead with nearby surface-facing cues before the longer escape climb, and the compiled runtime mirror matches that handoff.
- [x] Fabric bridge inventory now keeps the last visible inventory through a short burst of empty `getInventory` / `state:inventory` regressions instead of immediately erasing tool and food awareness.
- [x] Fabric bridge runtime now persists the last visible inventory/armor/offhand snapshot across bot restarts and clears that resume cache on death, so a short process restart no longer has to relearn from an empty bridge snapshot alone.
- [x] Deterministic food recovery now treats fish (`cod`, `salmon`) as generic food animals, matching planner food-search normalization for coastal starts.
- [x] Minecraft window capture now supports a focused `-PreferScreenCopy` mode when `PrintWindow` produces stale frames.
- [x] `collectBlocks(log)` no longer blocks early bootstrap on a missing axe; log gathering can proceed bare-handed while still preferring an axe when one exists.
- [x] Fabric remote-walk fallback now aborts wall-jitter/no-progress loops, handing `searchForBlock` back to planner/action recovery instead of hanging indefinitely.
- [x] Bridge-limited inventory cleanup no longer outranks missing crafting-table / pickaxe bootstrap, and `quick-loot` cleanup goals no longer false-fail verification by matching the generic `loot` gather keyword.
- [x] Planner goal verification now treats canonical inventory, held/offhand/equipped state, nearby crafting access, and recent craft-sync mismatch diagnostics as valid evidence for crafted targets.
- [x] Low-torch states with `furnace + logs + no coal` now rewrite into `Smelt charcoal using logs for torch and furnace fuel`, reusing the structured smelt path instead of the generic fuel-gather fallback.
- [x] The pre-existing `services/minecraft/src/libs/fabric-bridge/pathfinder.test.ts` type error is fixed, so `node_modules\.bin\tsc.CMD -p services\minecraft\tsconfig.json --noEmit` passes again in this sandbox.
- [x] Charcoal smelting no longer dies on the first furnace GUI miss; `smeltItem` now retries from closer interaction range with refreshed furnace targets, and the Fabric bridge no longer hardcodes `Direction.UP` for furnace/block activation hits.
- [x] Underground `Collect nearby food` no longer blindly opens with animal search when the bot is trapped near a surface cue; stone-tier no-food/no-sword/no-torch states now promote surface resupply first in both objectives and deterministic planner recovery.
- [x] Repeated underground cave-prep failures now rewrite into `Escape to the surface to gather wood` during a real live soak.
- [x] Planner-backed `recoverTowardSurface` now frees the current easy-mode shaft deadlock under a live compiled soak instead of losing altitude through immediate cue reorientation.
- [x] Live local-cue-first recovery now continues with a direct ascent onto the observed cue before broader exit search, and the compiled runtime mirrors that behavior.
- [x] Attack inventory preflight now accepts the same fallback combat tools (`pickaxe` / `shovel`) as `skills/combat.ts`, and structured food hunting now opportunistically crafts a sword first when wood is already available.
- [x] Fabric bridge `findBlocksAsync`, confined-shaft relocation, and initial `goto`/`gotoNear` dispatches now obey short recovery-friendly time budgets instead of inheriting 30-120s waits inside `recoverTowardSurface`.
- [x] Near-surface `shaft_trap` states now try scaffold pillar recovery before deeper cue/exit scans, and the runner logs the cue/exit stages so live `recoverTowardSurface` stops are no longer opaque.
- [x] Structured craft planning now reserves shared intermediate ingredients immediately, so `wooden_pickaxe` bootstrap no longer double-spends the same planks via both direct recipe inputs and derived sticks.
- [x] The current resumed surface save now live-verifies `wooden_pickaxe` craft and equip from the compiled runtime, with focused screenshots matching the resulting hotbar state.
- [x] Action verification snapshots now retain both localized nearby entity names and canonical entity types, so generic `searchForEntity(animal)` verification no longer false-fails just because only localized fish labels are visible.
- [x] Generic `attackNearest(animal)` no longer commits to water prey first when land animals are already visible, and aquatic food targets now get a short swim-aware pursuit path instead of relying only on the default PvP chase loop.
- [x] `searchForBlock(log)` now reuses trunk-aware wood targeting, so coastal/bootstrap wood search no longer pathfinds straight to canopy hits before `collectBlocks(log)` begins.
- [x] Surface bootstrap objective selection now delays bridge-limited inventory cleanup and promotes `Mine 16 cobblestone` / `Craft a stone pickaxe` before the old early-cleanup stall can hijack progression.
- [x] Surface-recovery rewrite no longer reopens `Escape to the surface to gather wood` when local wood / crafting / pickaxe facts already show that on-site bootstrap can continue.
- [x] Wood gathering now skips unresolved elevated canopy-only candidates after horizontal approach instead of repeatedly forcing exact vertical ascent toward the same high log.
- [x] Canopy-heavy wood scans now collapse duplicate same-tree observations and retry distinct tree candidates before revisiting the same canopy patch.
- [x] `searchForBlock(log)` now accepts horizontal contact with an elevated wood candidate during the search phase, so coastal/bootstrap wood search can hand off into `collectBlocks(log)` without first demanding an exact canopy Y match.
- [x] `gatherWood` now tries trunk-aware/manual log breaking before generic `baritone mine(log)` recovery, so reachable tree trunks are harvested before Baritone blacklists canopy-only hits.
- [x] Inventory preflight now treats ensure-managed craft targets such as generic `craftRecipe(sword)` as actionable, allowing `ensureSword()` to run instead of failing early with `ingredient_missing`.
- [x] Generic temporary-shelter fallback no longer hardcodes `cobblestone` when the goal text does not specify a material; it can now choose from currently held `dirt`, planks, logs, or cobble-like blocks.
- [x] Surface food recovery no longer treats tree-cover overhead as underground by default when a nearby sky window shows the bot is already on the surface.
- [x] Fabric bridge death handling now clears cached inventory, armor/offhand, canonical inventory, and persisted resume state so post-death restarts cannot inherit stale tools.
- [x] `recoverTowardSurface` now verifies as successful when the bot is already in a surface state instead of forcing a no-op movement failure.
- [x] Wood gathering now preserves farther recovery-range ground-tree candidates after skipping nearer unsupported canopy hits, and species-specific gather loops check the requested wood type before stopping.
- [x] Wood `searchForBlock` can explicitly defer unsafe unresolved wood searches into `collectBlocks` without failing action verification on `search_target_not_locked`.
- [x] Stable-hunger early bootstrap no longer replaces missing wood with `Collect nearby food` solely because carried food count is zero.
- [x] The May 10, 2026 live supervisor run verified `collectBlocks(log) -> oak_planks -> stick -> wooden_pickaxe` from the current Fabric bridge state without regressing into high-canopy pathing.
- [x] Explicit Japanese wood/log acquisition goals no longer verify from downstream craft outcomes such as a nearby crafting table.
- [x] Elevated wood recovery now picks up dropped scaffold items after terrain-support climbs and can relocate from safe elevated-only canopy clusters before rescanning.
- [x] Placement verification now rejects wrong-hand block placement and no longer records a recently placed furnace unless the target block or inventory decrement confirms it.
- [x] BotProxy held-item derivation now prefers the selected raw hotbar slot from canonical inventory state over stale tracked cache and raw armor-slot fallbacks.
- [x] Low-hunger mining goals now fail preconditions and objective ranking before iron/stone pushes when no recovery food is buffered.

## Next Up

- [ ] Feed objective proposals deeper into planner/executor validation so base/home building can run end-to-end.
- [ ] Add food acquisition / cave-prep verification so prerequisite replacement goals can hand off cleanly into iron mining and then diamond mining after surfacing.
- [ ] Keep the current surfaced `wooden_pickaxe + wooden_sword` live state moving into stable food buffering, temporary shelter, and stone progression instead of regressing into repeated recovery or food-failure loops.
- [ ] Keep the current `wooden_pickaxe + crafting_table + low-health/no-food` state from overcommitting to underground stone mining before surface resupply.
- [ ] Re-run charcoal smelting from the current `stone_pickaxe + furnace + logs` state and verify the furnace is real before relying on recent-placement cache.
- [ ] Re-run from the current `stone_pickaxe + torches + low food` state and verify food recovery wins before iron mining.
- [ ] Add build compiler / validator and interior placement loops on top of the new base/interior evaluators.
- [ ] Turn screenshot observations plus runtime failure packets into an automated soak benchmark summary.
- [ ] Remove the remaining sandbox-specific live-test blocker by running the next soak in an environment where Node child-process spawn is permitted end-to-end, including the supervisor child launch.

## OpenAI Budget Safety (2026-07-10)

- [x] Official OpenAI calls are fail-closed behind a UTC daily token budget, soft stop, and model allowlist.
- [x] Budget exhaustion stops autonomy and active execution instead of switching gameplay to a rule-based substitute.
- [x] Exit code 78 suppresses the in-process automatic restart loop and blocks startup while persisted usage remains over the soft stop.

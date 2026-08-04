# AUTONOMY_WORKLOG

## 2026-05-10 - Japanese wood-goal verification, scaffold pickup, and furnace placement truth checks

- Live observations:
  - `services/minecraft/runtime/soak-supervisor/run-2026-05-09T21-06-57-739Z.log`
  - `services/minecraft/runtime/screenshots/monitor-20260510-061326.png`
- Hypothesis:
  The current live run had moved beyond the prior surface/no-op and early wood blockers, but it exposed three production issues before charcoal: Japanese wood acquisition wording could be satisfied by later craft outcomes, high-canopy recovery could leave scaffold blocks behind or keep staring at elevated-only clusters, and `placeHere(furnace)` could be logged/verified from a requested type even when the selected hand item stayed on dirt.
- Changes:
  - Updated `services/minecraft/src/agents/planning/index.ts` so explicit Japanese wood/log acquisition goals remain resource goals and are not satisfied by an already-visible crafting table or downstream craft outcome.
  - Updated `services/minecraft/src/skills/actions/gather-wood.ts` so terrain-support climbs try to pick up dropped scaffold items before retrying, below-surface wood candidates are filtered during surface collection, and safe elevated-only canopy clusters can trigger bounded relocation before the next scan.
  - Updated `services/minecraft/src/skills/actions/world-interactions.ts` so block placement refuses to continue when equip leaves a different held item, confirms the target block or requested inventory decrement after placement, and records recent placed blocks only after that confirmation.
  - Updated `services/minecraft/src/libs/fabric-bridge/bot-proxy.ts` so BotProxy derives its held item from the selected raw hotbar slot using canonical inventory priority instead of stale tracked cache or raw armor-slot fallbacks.
- Validation:
  - `pnpm exec eslint --fix src\libs\fabric-bridge\bot-proxy.ts src\libs\fabric-bridge\bot-proxy.test.ts src\skills\actions\world-interactions.ts src\skills\actions\world-interactions.test.ts`
  - `pnpm exec vitest run src\libs\fabric-bridge\bot-proxy.test.ts src\skills\actions\world-interactions.test.ts --config vitest.config.ts`
  - `pnpm exec vitest run src\agents\planning\index.test.ts src\skills\actions\gather-wood.test.ts src\skills\actions\world-interactions.test.ts src\libs\fabric-bridge\bot-proxy.test.ts src\agents\action\index.test.ts src\skills\crafting.test.ts --config vitest.config.ts`
  - `pnpm run typecheck`
  - After the live low-hunger iron-mining regression: `pnpm exec vitest run src\autonomy\preconditions.test.ts src\autonomy\objectives.test.ts src\autonomy\orchestrator.test.ts --config vitest.config.ts`
  - After the live low-hunger iron-mining regression: `pnpm exec vitest run src\autonomy\preconditions.test.ts src\autonomy\objectives.test.ts src\autonomy\orchestrator.test.ts src\agents\planning\index.test.ts src\skills\actions\gather-wood.test.ts src\skills\actions\world-interactions.test.ts src\libs\fabric-bridge\bot-proxy.test.ts src\agents\action\index.test.ts src\skills\crafting.test.ts --config vitest.config.ts`
  - After the live low-hunger iron-mining regression: `pnpm run typecheck`
- Result:
  - The live run verified the current Fabric state can progress through `collectBlocks(log)`, `oak_planks`, `stick`, `wooden_pickaxe`, `cobblestone x17`, `stone_pickaxe`, and `furnace`.
  - The next live blocker was isolated to placement truth: the log said `Placed furnace at (-392, 64, 215)`, but postflight showed `furnace` count unchanged, `dirt` decreased, and the furnace GUI could not open.
  - After the placement/BotProxy checks, the supervisor restart correctly failed `placeHere(furnace)` instead of recording a false placement, then used a real nearby furnace to complete `smeltItem(oak_log) -> craftRecipe(stick) -> craftRecipe(torch)`. The monitor captured this at `runtime/screenshots/monitor-20260510-062806.png`.
  - The following live blocker was post-pickaxe safety: after surface wood recovery reached `logs=5`, the bot selected `mine iron_ore at (-382, 44, 191)` and moved underground at `health=12`, `food=6`, with no recovery food buffer. Supervisor was stopped before death-risk mining continued.
  - Added the low-hunger mining gate in `services/minecraft/src/autonomy/preconditions.ts` and `services/minecraft/src/autonomy/objectives.ts`; mining goals now redirect to food/surface resupply when food is depleted and no recovery food is buffered.
  - Public speech generation still returned provider 404s and local TTS connection failures, but gameplay continued. This remains a stream-lane issue, not the current gameplay blocker.
- Next hypothesis:
  After restart, the expected behavior is that the current low-food underground iron goal is mechanically replaced with food/surface recovery before any further iron push. Once food is stable, the next safe path is iron ore -> smelt iron -> iron pickaxe, then diamond acquisition.

## 2026-05-10 - Death cache reset, surface no-op recovery, and safe canopy wood handoff

- Live observations:
  - `services/minecraft/runtime/soak-supervisor/run-2026-05-09T16-53-05-278Z.log`
  - `services/minecraft/runtime/soak-supervisor/run-2026-05-09T16-57-32-261Z.log`
  - `services/minecraft/runtime/soak-supervisor/run-2026-05-09T17-07-19-544Z.log`
  - `services/minecraft/runtime/soak-supervisor/run-2026-05-09T17-10-25-883Z.log`
- Hypothesis:
  The current restart was not blocked by the long-horizon diamond planner yet. It was still failing earlier because stale bridge inventory could survive death, surface recovery could false-fail after already reaching surface terrain, and early wood bootstrap could either chase unsupported canopy logs or let `searchForBlock(log)` fail verification before `collectBlocks(log)` got the trunk-aware recovery pass.
- Changes:
  - Added Fabric bridge death inventory clearing in `services/minecraft/src/libs/fabric-bridge/bot-proxy.ts` so strict/raw inventory, armor/offhand, snapshots, canonical inventory, and persisted resume state are cleared on health<=0/death instead of resurrecting stale tools.
  - Updated surface recovery in `services/minecraft/src/runner/phases.ts` and `services/minecraft/src/agents/action/index.ts` so `recoverTowardSurface` can verify as successful when the world snapshot is already a surface state.
  - Hardened surface-first wood planning in `services/minecraft/src/agents/planning/index.ts` and wood collection in `services/minecraft/src/skills/actions/gather-wood.ts`: species-specific log counts are honored, canopy observations are clustered/expanded, unresolved unsupported elevated wood is skipped, recovery-range ground trees are kept after nearby canopy skips, and Baritone wood mining is stopped once the requested inventory count is reached.
  - Updated `services/minecraft/src/agents/action/tools.ts` / `index.ts` so wood `searchForBlock` can explicitly defer unsafe unresolved wood searches to `collectBlocks` without tripping `search_target_not_locked`.
  - Updated `services/minecraft/src/autonomy/progress.ts` so stable hunger with no carried food no longer preempts wood bootstrap with `Collect nearby food`.
- Validation:
  - `..\..\node_modules\.bin\eslint.CMD --fix src\agents\action\index.ts src\agents\action\index.test.ts src\agents\action\tools.ts src\agents\action\tools.test.ts src\skills\actions\gather-wood.ts src\skills\actions\gather-wood.test.ts src\autonomy\progress.ts src\autonomy\progress.test.ts`
  - `..\..\node_modules\.bin\tsc.CMD -p tsconfig.json --noEmit`
  - `..\..\node_modules\.bin\vitest.CMD run src\skills\actions\gather-wood.test.ts src\agents\action\tools.test.ts src\agents\action\index.test.ts src\autonomy\progress.test.ts --config vitest.config.ts`
- Result:
  - The first post-surface-recovery live run verified the old underground recovery false-fail was gone, but exposed the unsafe wood-search handoff: raw high-canopy `searchForBlock(log)` still tried to lock onto elevated wood and later failed verification when safely skipped.
  - After the wood-search defer fix, `run-2026-05-09T17-10-25-883Z.log` live-verified `Craft a wooden pickaxe` end-to-end: `collectBlocks(log)` reached `oak_log x1`, `oak_planks` and `stick` crafted, and `wooden_pickaxe x1` was verified/equipped.
  - The run then selected `Mine 16 cobblestone` and started `collectBlocks(stone)`, but the bot was underground at `y=57` with `health=8.833334`, `food=14`, and no food item buffer. The supervisor was stopped there to avoid turning a successful bootstrap validation into a death-risk soak.
- Next hypothesis:
  The next blocker is now post-pickaxe survival gating, not basic wood bootstrap: before pushing deeper into stone/iron, low-health underground mining should either surface/resupply or mine only with stricter safety rails. Full diamond armor and Ender Dragon remain unverified.

## Iteration 7 - Surface canopy food context and inventory-aware shelter fallback

- Screenshot checkpoints:
  - `runtime/minecraft-observation/minecraft-window-20260419-232550.png`
  - `runtime/minecraft-observation/minecraft-window-20260419-232719.png`
  - `runtime/minecraft-observation/minecraft-window-20260419-232750.png`
- Live observations:
  - `services/minecraft/runtime/manual-compiled-soak/20260419-232519`
  - `services/minecraft/runtime/manual-compiled-soak/20260419-232623`
- Hypothesis:
  The next production blockers after the earlier wood/sword fixes were no longer basic bootstrap. `Collect nearby food` could still misclassify a tree-covered surface scene as an underground escape context, and the shelter fallback still assumed `cobblestone` even when the live inventory only had `dirt` / `logs`.
- Changes:
  - Patched `services/minecraft/src/agents/planning/index.ts` plus the compiled mirror so food recovery treats nearby sky windows under leaf cover as surface context instead of injecting `recoverTowardSurface` merely because the player is standing beneath a tree canopy.
  - Patched `services/minecraft/src/agents/planning/adapter.ts` plus the compiled mirror so generic temporary-shelter fallback selects from currently held structural blocks (`dirt`, planks, logs, cobble-like blocks) instead of hardcoding `cobblestone`.
  - Added focused regressions in `services/minecraft/src/agents/planning/index.test.ts` and `services/minecraft/src/agents/planning/adapter.test.ts` for the new surface-canopy and shelter-material behavior.
- Validation:
  - `node_modules\.bin\eslint.CMD --fix services/minecraft/src/agents/planning/adapter.ts services/minecraft/src/agents/planning/index.ts services/minecraft/src/agents/planning/adapter.test.ts services/minecraft/src/agents/planning/index.test.ts`
  - `node_modules\.bin\tsc.CMD -p services/minecraft/tsconfig.json --noEmit`
  - `node --check services/minecraft/runtime/compiled-run-20260418-2040/src/agents/planning/adapter.js`
  - `node --check services/minecraft/runtime/compiled-run-20260418-2040/src/agents/planning/index.js`
  - `node_modules\.bin\vitest.CMD run services/minecraft/src/agents/planning/adapter.test.ts services/minecraft/src/agents/planning/index.test.ts` remains sandbox-blocked with `spawn EPERM`.
- Result:
  - The short reattach `services/minecraft/runtime/manual-compiled-soak/20260419-232519/minecraft-bot.stdout.log` proves the earlier wood fix still holds in the current save: unresolved elevated canopy hits are skipped without dropping back into the old global `mine(log)` blacklist loop.
  - The longer reattach `services/minecraft/runtime/manual-compiled-soak/20260419-232623/minecraft-bot.stdout.log` live-verified progression from the same restart through `Craft a crafting table -> Craft a wooden pickaxe -> Gather fuel for torches and furnace work`. The focused captures show the bot first digging itself out of a dirt pocket and later sitting at the crafting interface with `wooden_pickaxe + dirt + stick + oak_planks`, so the runtime is again reaching the pre-stone checkpoint needed for the next survival branch.
  - This window still did not reach the new `Collect nearby food` / `temporary shelter` branches directly, so the new canopy-surface and inventory-aware shelter logic is code/test verified but still awaiting the next live branch hit.
- Next hypothesis:
  From the now re-verified `wooden_pickaxe + dirt/oak_planks + placed crafting table` state, the next dominant blocker is not basic wood bootstrap. It is the post-pickaxe survival handoff: fuel/torch work must flow into `food buffer + temporary shelter + stone` without reopening underground recovery or material-mismatch placement failures.

## Iteration 6 - Wood search handoff and ensure-managed sword craft

- Screenshot checkpoints:
  - `runtime/minecraft-observation/minecraft-window-20260419-220140.png`
  - `runtime/minecraft-observation/minecraft-window-20260419-220637.png`
  - `runtime/minecraft-observation/minecraft-window-20260419-221054.png`
  - `runtime/minecraft-observation/minecraft-window-20260419-221604.png`
  - `runtime/minecraft-observation/minecraft-window-20260419-221928.png`
- Live observations:
  - `services/minecraft/runtime/manual-compiled-soak/20260419-220459`
  - `services/minecraft/runtime/manual-compiled-soak/20260419-220917`
  - `services/minecraft/runtime/manual-compiled-soak/20260419-221423`
- Hypothesis:
  Two production blockers were chained together: `searchForBlock(log)` still spent its window forcing exact vertical canopy alignment before `collectBlocks(log)` could run, and later `craftRecipe(sword)` steps were being rejected by inventory preflight even though the action handler would route them through `ensureSword()`.
- Changes:
  - Patched `services/minecraft/src/skills/actions/gather-wood.ts` plus the compiled mirror so wood search now accepts horizontal contact with an elevated tree candidate during the search phase, while collection keeps stricter reachability checks.
  - Reordered wood collection so the trunk-aware manual break path runs before generic `baritone mine(log)` recovery, which stops the coastal/canopy case from burning the whole soak on Baritone blacklisting unreachable canopy hits.
  - Patched `services/minecraft/src/skills/actions/inventory.ts` plus the compiled mirror so craft preflight treats ensure-managed recipes (`crafting_table`, generic tool categories, exact sword/axe/shovel/hoe ensures, starter wooden/stone pickaxe ensures) as actionable instead of failing with `ingredient_missing` before the action reaches `ensure*()`.
- Validation:
  - `node_modules\.bin\eslint.CMD --fix services/minecraft/src/skills/actions/gather-wood.ts services/minecraft/src/skills/actions/gather-wood.test.ts`
  - `node_modules\.bin\eslint.CMD --fix services/minecraft/src/skills/actions/inventory.ts services/minecraft/src/skills/actions/inventory.test.ts`
  - `node_modules\.bin\tsc.CMD -p services/minecraft/tsconfig.json --noEmit`
  - `node --check services/minecraft/runtime/compiled-run-20260418-2040/src/skills/actions/gather-wood.js`
  - `node --check services/minecraft/runtime/compiled-run-20260418-2040/src/skills/actions/inventory.js`
  - `vitest` remains sandbox-blocked here with `spawn EPERM`.
- Result:
  - `services/minecraft/runtime/manual-compiled-soak/20260419-220459/minecraft-bot.stdout.log` live-verified the first half of the fix: `searchForBlock(log)` now logs `Accepting horizontal wood-candidate contact...`, verifies successfully, and hands control forward into `collectBlocks(log)` instead of dying on the search step.
  - `services/minecraft/runtime/manual-compiled-soak/20260419-220917/minecraft-bot.stdout.log` live-verified the second half of the wood fix: the bot now reaches `Craft a crafting table`, completes the craft, then continues onward into `wooden_pickaxe`.
  - `services/minecraft/runtime/manual-compiled-soak/20260419-221423/minecraft-bot.stdout.log` live-verified the ensure-craft preflight fix: `Gather materials and craft a sword` executes end-to-end, `craftRecipe(sword)` passes inventory preflight, `ensureSword()` crafts `wooden_sword`, and the verification snapshot confirms the sword in inventory.
  - The later focused capture `runtime/minecraft-observation/minecraft-window-20260419-221928.png` still shows an empty-hotbar nighttime dirt pocket even though the newest runtime log stopped at `2026-04-19T13:15:52Z` right after verifying `wooden_pickaxe + wooden_sword`. That visual/runtime mismatch remains unresolved and still blocks treating screenshots as the sole source of truth.
- Next hypothesis:
  The new dominant blocker is no longer wood bootstrap or generic sword-preflight rejection. The live state has reached `wooden_pickaxe + wooden_sword + low health/night shoreline`, and the next issue is that `Collect nearby food` can still collapse into recovery `searchForBlock(grass_block) -> moveAway` loops instead of converting the newly safe melee state into actual food recovery and temporary shelter.

## Iteration 1 - Gameplay rails before long-horizon refactor

- Hypothesis:
  Unsupported bridge commands, blocked-step retries, and weak deterministic recovery were the dominant reasons the bot stalled before meaningful progression.
- Changes:
  Added capability handshake, unsupported-command caching, blocked-step suppression, deterministic recovery queue, and speech backpressure.
- Result:
  Targeted regression tests passed and `compactInventory` no longer kills craft paths outright.
- Next hypothesis:
  The remaining hardcoded long-term fallback in `decision-provider.ts` keeps the autonomy layer too close to a scripted roadmap and blocks generic base/home behavior.

## Iteration 2 - Visual observation and target/gap refactor

- Screenshot checkpoint:
  `runtime/minecraft-observation/screen-20260417-184703.png`
- Observation:
  Minecraft was active in-world and visually stalled facing a stone wall with a mixed hotbar, which matches the no-progress / blind wall-following failure class rather than a narration-only issue.
- Hypothesis:
  The decision layer needs `TargetSpec + evaluator gaps + objective proposals` so the bot can choose between recovery, survival, base, mining, and interior work without a fixed dragon roadmap.
- Changes in progress:
  Added `services/minecraft/src/autonomy/objectives.ts`, base/interior world-state facts, and objective-driven fallback prompt wiring.
- Expected validation:
  Rule-based and Gemini decision prompts should now see target gaps and base/interior scores instead of a fixed long-term milestone list.

## Iteration 2 Result

- Validation commands:
  - `pnpm -F @proj-airi/minecraft-bot exec vitest run src/autonomy/objectives.test.ts src/autonomy/decision-provider.rule-based.test.ts src/autonomy/decision-provider.test.ts src/libs/llm-agent/world-state.test.ts`
  - `pnpm -F @proj-airi/minecraft-bot exec vitest run src/autonomy/objectives.test.ts src/autonomy/decision-provider.rule-based.test.ts src/autonomy/decision-provider.test.ts src/libs/llm-agent/world-state.test.ts src/libs/fabric-bridge/bot-proxy.test.ts src/skills/actions/inventory.test.ts src/agents/planning/index.test.ts src/autonomy/orchestrator.test.ts`
  - `pnpm -F @proj-airi/minecraft-bot typecheck`
  - `pnpm -F @proj-airi/minecraft-bot lint:fix`
- Screenshot utility validation:
  - `services/minecraft/scripts/capture-minecraft-window.ps1` was corrected to prefer the `javaw` Minecraft window and to use `PrintWindow`.
  - Verified live capture: `runtime/minecraft-observation/minecraft-window-20260417-190558.png`
- Result:
  The fallback decision path now chooses from evaluator-driven objectives, world-state exposes base/interior facts, and the focused regression suite stayed green.
- Next hypothesis:
  The next bottleneck is no longer the fixed roadmap fallback but the absence of a build compiler / validator that can turn the new base/interior objectives into robust execution.

## Iteration 3 - Live soak truth before more architecture work

- Live observation:
  - `runtime/manual-bot-test/20260417-210625`
  - `runtime/minecraft-observation/minecraft-window-20260417-210325.png`
  - `runtime/minecraft-observation/minecraft-window-20260417-211632.png`
- Hypothesis:
  The next blockers are still in the production gameplay path: recovery lock contention, unsupported hotbar selection, and observation/no-progress loops.
- Changes:
  Tightened plan-lock release semantics, removed no-op `nearbyBlocks` from deterministic recovery, hardened action verification, and added unsupported `selectHotbarSlot` fallback.
- Result:
  Focused regressions covered those fixes, but live truth still showed unresolved inventory-organization churn and critical inference waits.
- Next hypothesis:
  Combat readiness is still weak because shield/sword handling is not deterministic enough in the live inventory policy.

## Iteration 4 - Shield offhand and sword quick-access policy

- Screenshot checkpoint:
  `runtime/minecraft-observation/minecraft-window-20260417-214308.png`
- Hypothesis:
  Combat loadout remains inconsistent because shield is treated like a generic weapon and can crowd the hotbar instead of living in offhand.
- Changes:
  Deterministic inventory policy now prefers swords/axes for the primary weapon slot, prefers shield in offhand, and attack preflight avoids mistaking `pickaxe` for `axe`.
- Validation commands:
  - `pnpm -F @proj-airi/minecraft-bot exec vitest run src/libs/inventory/policy.test.ts src/skills/actions/inventory.test.ts`
  - `pnpm -F @proj-airi/minecraft-bot typecheck`
  - `pnpm -F @proj-airi/minecraft-bot lint:fix`
- Result:
  Focused regressions passed. The organizer can equip shield to offhand and keep the sword immediately available. This improves combat readiness, but does not yet close the remaining live no-progress loops.
- Next hypothesis:
  The next highest invariant is still live inventory-pressure churn plus critical inference waits, not weapon-slotting.

## Iteration 5 - Inventory pressure churn and bridge-capability organizer fix

- Screenshot checkpoints:
  - `runtime/minecraft-observation/minecraft-window-20260418-191023.png`
  - `runtime/minecraft-observation/minecraft-window-20260418-191848.png`
- Hypothesis:
  The remaining live deadlock was not just planner choice. Unsupported slot-management commands plus a lost `compactInventory` method binding kept the organizer oscillating or crashing before the autonomy loop could move back into real progression.
- Changes:
  The inventory organizer now targets at least three free slots when pressure is already at the two-slot quick-loot threshold, skips unsupported slot-shuffle branches capability-aware, surfaces bridge capability facts in world-state/planner prompts, and keeps `compactInventory()` bound to the Fabric bridge bot instance.
- Validation:
  - `node_modules\.bin\tsc.CMD -p services\minecraft\tsconfig.json --noEmit`
  - Live FabricBridge rerun via temporary compiled JS because `tsx` is sandbox-blocked here.
- Result:
  Live execution no longer crashed inside organizer preflight, and the autonomy loop advanced from the old inventory-organize deadlock into real crafting/bootstrap goals.
- Next hypothesis:
  Early wood bootstrap still treats the default `oak_planks` recipe too literally, and action verification still rejects equivalent non-oak plank outputs even when the craft succeeded.

## Iteration 6 - Non-oak wood bootstrap and satisfied-count verification

- Screenshot checkpoints:
  - `runtime/minecraft-observation/minecraft-window-20260418-192149.png`
  - `runtime/minecraft-observation/minecraft-window-20260418-192630.png`
- Hypothesis:
  After the organizer fix, the next blocker was recipe-family rigidity: `birch_log` inventory could not satisfy the planner's default `oak_planks` bootstrap, and `collectBlocks` / craft verification were still producing false negatives when the requested state was already satisfied or satisfied by an equivalent plank family.
- Changes:
  The crafting layer now rewrites the default oak-plank bootstrap to the visible log family in inventory, craft verification treats the generic oak/plank alias as any plank family, and `collectBlocks` verification accepts "already satisfied" inventory counts instead of requiring a fresh delta every time.
- Validation:
  - `node_modules\.bin\tsc.CMD -p services\minecraft\tsconfig.json --noEmit`
  - Live FabricBridge reruns showed:
    - `Craft recipe inputs for birch_planks: birch_log=1 (actual=6, tracked=6)`
    - `Successfully crafted 4 birch_planks (1 craft) using crafting table.`
    - `Successfully crafted 1 crafting_table.`
    - `Goal verification passed: all target items found in inventory`
- Result:
  The bot now bootstraps from non-oak wood, verifies the crafting-table milestone correctly, and mechanically promotes the next prerequisite goal (`Prepare supplies (food, torches, sword) for cave exploration`) instead of falling back into the old wood/bootstrap loop.
- Next hypothesis:
  The next practical blocker on the diamond path is food/supply prep and escaping the cramped underground state reliably enough to re-enter the iron -> diamond trajectory.

## Iteration 7 - Underground cave-prep recovery toward surface escape

- Screenshot checkpoint:
  `runtime/minecraft-observation/minecraft-window-20260418-201407.png`
- Observation:
  The live client was still stuck in a cramped stone shaft looking upward with a pickaxe, which matches the exact failure class from Iteration 6: cave-prep supply gathering kept firing while the bot remained underground instead of first regaining surface access.
- Hypothesis:
  The diamond path is currently blocked less by missing recipes and more by objective/planner recovery shape. When hunger or cave-prep failures happen underground, the autonomy layer needs to mechanically pivot into a canonical surface-recovery objective instead of retrying local food/combat loops in the same bad terrain.
- Changes:
  Added a deterministic structured surface-recovery fast path in `services/minecraft/src/agents/planning/index.ts`, taught structured planning to gather `food` and craft a generic `sword`, and updated objective/orchestrator rewrites so repeated underground cave-prep food/combat failures become `Escape to the surface to gather wood`.
- Validation:
  - `node_modules\.bin\tsc.CMD -p services\minecraft\tsconfig.json --noEmit`
  - `node_modules\.bin\eslint.CMD --fix services/minecraft/src/agents/planning/index.ts services/minecraft/src/autonomy/objectives.ts services/minecraft/src/autonomy/orchestrator.ts services/minecraft/src/agents/planning/index.test.ts services/minecraft/src/autonomy/objectives.test.ts services/minecraft/src/autonomy/orchestrator.goal-recovery.test.ts`
  - `node_modules\.bin\vitest.CMD run services/minecraft/src/agents/planning/index.test.ts services/minecraft/src/autonomy/objectives.test.ts services/minecraft/src/autonomy/orchestrator.goal-recovery.test.ts` still could not execute in this sandbox because Vite/esbuild child-process startup fails with `spawn EPERM`.
  - Repeated attempts to relaunch the live bot from this sandbox also remained blocked by `spawn EPERM` and local pnpm-link runtime constraints, so this iteration could only re-check the live Minecraft client visually rather than run a fresh post-patch soak here.
- Result:
  The autonomy code now has an explicit non-scripted recovery lane from underground cave-prep failure into surface escape, plus focused regressions for that rewrite. A fresh live soak is still required outside this sandbox to confirm the bot actually climbs out, replenishes food, and hands back into iron progression.
- Next hypothesis:
  Once the relaunch environment is available again, the next real question is whether the new surface-recovery lane is sufficient on its own or whether the bot still needs stronger post-surface food buffering and cave re-entry validation before the iron -> diamond chain becomes stable.

## Iteration 8 - Real mining-tier gating and diamond-loadout progression

- Screenshot checkpoints:
  `runtime/minecraft-observation/minecraft-window-20260418-210126.png`
  `runtime/minecraft-observation/minecraft-window-20260418-211920.png`
- Observation:
  The live client was still sitting underground in the same dark inventory view with a stone pickaxe equipped, an iron sword/shield available, no armor worn, and no visible progress between the two captures. That made a hidden logic problem worth fixing first: some autonomy code still treated generic iron combat gear as if it implied iron-tier mining readiness.
- Hypothesis:
  The diamond objective cannot become reliable while progression and preconditions conflate combat tier with pickaxe tier, or while the structured planner only knows `diamond_pickaxe` and not the actual armor-piece recipes needed for the target spec.
- Changes:
  Added explicit `pickaxeTier`, iron/diamond pickaxe flags, and diamond-armor-piece facts in `services/minecraft/src/autonomy/preconditions.ts`; extended progression milestones in `services/minecraft/src/autonomy/progress.ts` through `iron-pickaxe`, `diamond-acquisition`, and `diamond-loadout`; updated `services/minecraft/src/autonomy/objectives.ts` so diamond mining/crafting decisions key off mining capability instead of an iron sword false positive; and added diamond armor recipes plus goal extraction in `services/minecraft/src/autonomy/knowledge/recipes.json`, `services/minecraft/src/autonomy/knowledge-retriever.ts`, and `services/minecraft/src/agents/planning/index.ts`.
- Validation:
  - `node_modules\.bin\tsc.CMD -p services\minecraft\tsconfig.json --noEmit`
  - `node_modules\.bin\eslint.CMD services/minecraft/src/autonomy/preconditions.ts services/minecraft/src/autonomy/progress.ts services/minecraft/src/autonomy/objectives.ts services/minecraft/src/autonomy/knowledge-retriever.ts services/minecraft/src/autonomy/preconditions.test.ts services/minecraft/src/autonomy/progress.test.ts services/minecraft/src/autonomy/objectives.test.ts services/minecraft/src/autonomy/knowledge-retriever.test.ts services/minecraft/src/autonomy/decision-provider.test.ts services/minecraft/src/autonomy/decision-provider.rule-based.test.ts services/minecraft/src/agents/planning/index.ts services/minecraft/src/agents/planning/index.test.ts --fix`
  - `pnpm -F @proj-airi/minecraft-bot typecheck` could not run in this sandbox because corepack/pnpm access hit `EPERM`.
  - `node_modules\.bin\vitest.CMD run ...` still could not execute in this sandbox because Vite/esbuild startup fails with `spawn EPERM`.
- Result:
  The autonomy stack now has an internally consistent diamond path: mining unlocks depend on the actual pickaxe tier, the progression snapshot no longer stops at `iron-smelting`, and the structured planner can express full diamond armor craft goals instead of only `diamond_pickaxe`. Live gameplay has not changed yet because this environment still cannot relaunch the bot process for a post-patch soak.
- Next hypothesis:
  Once relaunch is available, the next real bottleneck will be whether the recovered surface loop can turn these new milestones into concrete behavior: surface escape -> food buffer -> iron pickaxe -> diamond mining -> diamond armor craft.

## Iteration 9 - Direct planner surface-recovery action for shaft stalls

- Screenshot checkpoint:
  `runtime/minecraft-observation/minecraft-window-20260418-230315.png`
- Observation:
  After switching the live world from peaceful to easy, the client was still frozen in the exact same one-block stone shaft view with shield + furnace/bootstrap items visible. That raised the cost of the existing stall sharply: a passive underground deadlock can now turn into real hostile pressure instead of just wasted time.
- Hypothesis:
  The autonomy stack already knows how to recover toward the surface in the runner path, but the LLM planner still mostly expresses underground escape as generic `moveAway` / `goToCoordinates` steps. Exposing the stronger `recoverTowardSurface` capability directly to planner-backed execution should make underground shaft recovery materially more reliable without hardcoding a milestone script.
- Changes:
  Added a planner/action-level `recoverTowardSurface` tool wired to the existing runner recovery routine, taught both planning fast paths to prefer it for direct surface-recovery goals and underground bootstrap deadlocks, and extended action verification so upward escape progress counts as a valid recovery result.
- Validation:
  - Pending after code patch: `node_modules\.bin\tsc.CMD -p services\minecraft\tsconfig.json --noEmit`
  - Pending after code patch: targeted ESLint on touched Minecraft autonomy/action/planning files
  - Pending after code patch: targeted Vitest remains expected to stay blocked here by `spawn EPERM`, but the new regressions cover action wiring plus planner preference.
- Result:
  The LLM path now has access to the same stronger surface-escape primitive that the deterministic runner path already used. The next live rerun should no longer rely on generic horizontal relocation alone when the bot is visibly trapped in a vertical stone shaft.
- Next hypothesis:
  If the next soak still wedges in easy mode, the remaining gap will likely be post-surface handoff quality: shield/food/shelter buffering after escape rather than the escape action itself.

## Iteration 10 - Generic scaffold pillar escape for enclosed shaft traps

- Screenshot checkpoint:
  `runtime/minecraft-observation/minecraft-window-20260419-000140.png`
- Observation:
  The live Minecraft window still shows the avatar hard-stuck in a one-block-wide stone shaft with a pickaxe equipped, full hunger, a shield on hotbar, birch logs/crafting table/furnace/cobblestone available, and the crosshair pressed into a stone wall. That means the latest recovery gap is not food or combat readiness first; it is mechanical vertical extraction from a closed shaft where generic `goToPosition(... higher Y ...)` does not create a climb on its own.
- Hypothesis:
  `recoverTowardSurface` needs a general, non-scripted closed-shaft escape fallback that can consume arbitrary scaffold blocks from current inventory and raise the bot upward after clearing headroom, instead of depending only on horizontal relocation or pure pathfinding to a higher Y in the same column.
- Changes:
  Added a generic scaffold-based pillar fallback in `services/minecraft/src/runner/phases.ts` that detects enclosed shaft traps from immediate terrain, clears headroom blocks in the current column, chooses disposable scaffold blocks from live inventory, and uses `pillarUp` as a final surface-recovery fallback when vertical probes cannot move the bot. Added a focused regression in `services/minecraft/src/runner/phases.test.ts` covering the exact failure class: enclosed shaft + failed vertical pathfinding -> break headroom -> pillar escape.
- Validation:
  - Pending after code patch: `node_modules\.bin\tsc.CMD -p services\minecraft\tsconfig.json --noEmit`
  - Pending after code patch: targeted ESLint on touched Minecraft runner/docs files
  - Pending after code patch: targeted Vitest is still expected to be blocked here by `spawn EPERM`, but the new runner regression captures the shaft-pillaring fallback behavior.
- Result:
  The runner recovery path no longer depends solely on horizontal relocation or blind high-Y pathfinding when the bot is trapped in an enclosed stone shaft with usable scaffold inventory. The next live soak should now have a mechanical way to convert the observed shaft trap into upward progress.
- Next hypothesis:
  If the next soak still stalls after pillar escape is available, the next bottleneck is likely the post-escape handoff: surface food buffering, torch/sword prep completion, or cave re-entry validation rather than raw shaft extraction.

## Iteration 11 - Deferred Fabric bridge attach and non-destructive daemon restart

- Screenshot checkpoint:
  `runtime/minecraft-observation/minecraft-window-20260419-010148.png`
- Observation:
  The live client was still sitting in the same one-block stone shaft with a stone pickaxe, full hunger, and bootstrap items visible, but this run also showed a runtime-level blocker: only the Minecraft window was alive, while the bot/supervisor processes were gone and the live daemon was stuck at `bridge_preflight_failed` because no cached launch info existed.
- Hypothesis:
  The next diamond-path iteration will keep stalling if the bot process cannot survive a late or temporarily missing Fabric bridge. Startup needs to tolerate a bridge that appears after process boot, and the daemon should prefer keeping an already-open Minecraft gameplay window intact over forcing relaunch logic that depends on command-line introspection.
- Changes:
  Updated `services/minecraft/src/libs/fabric-bridge/index.ts` so `FabricBridge.asyncBuild()` no longer aborts the whole bot after a 90s initial websocket timeout; it now continues in deferred-connect mode and hydrates the session when the bridge appears later. Added focused regressions in `services/minecraft/src/libs/fabric-bridge/index.test.ts` for delayed initial attach and late spawn-hook activation. Updated `services/minecraft/scripts/stream-gemma-daemon-worker.ps1` so the live daemon:
  - treats an already-listening Fabric bridge as sufficient startup evidence even when Fabric client command-line inspection is unavailable,
  - prefers an already-open Minecraft gameplay window over a forced relaunch when the bridge listener is late,
  - uses a dynamic `FABRIC_BRIDGE_PORT` lookup instead of hardcoding `8089`,
  - relaxes Fabric client detection so it no longer depends on one exact `--gameDir` layout.
- Validation:
  - Pending after code patch: `node_modules\.bin\tsc.CMD -p services\minecraft\tsconfig.json --noEmit`
  - Pending after code patch: targeted ESLint on touched Fabric bridge / daemon / autonomy docs files
  - Pending after code patch: targeted Vitest on `services/minecraft/src/libs/fabric-bridge/index.test.ts` is expected to remain vulnerable to the sandbox `spawn EPERM` issue.
  - Pending after code patch: PowerShell parser check on `services/minecraft/scripts/stream-gemma-daemon-worker.ps1`
- Result:
  The Minecraft bot can now stay alive while waiting for the Fabric websocket to appear, and the live daemon no longer has to relaunch or discard an already-open Minecraft client just because it cannot reconstruct launch info safely from this environment.
- Next hypothesis:
  If the next live soak still shows the same shaft after the bot survives startup again, the remaining blocker returns to gameplay handoff quality: convert surface escape into food/torch/sword prep, then re-enter iron and diamond mining without regressing into another underground stall.

## Iteration 12 - Launcher degraded-mode progress under sandbox process restrictions

- Screenshot checkpoint:
  `runtime/minecraft-observation/minecraft-window-20260419-021242.png`
- Observation:
  The live Minecraft window still showed the exact same one-block stone shaft with a stone pickaxe, shield, birch logs, crafting table, furnace, sapling, and stacked cobblestone, but the launcher path itself advanced materially further this run. The daemon now clears startup past the old `bridge_preflight_failed` dead-end, recognizes the already-open Minecraft gameplay window, and reaches supervisor launch before the sandbox blocks the next child process.
- Hypothesis:
  The current blocker is no longer only autonomy logic inside Minecraft. To keep the bot alive across unattended runs as requested, the live daemon needs to degrade cleanly through local process-inspection and package-manager restrictions, so the remaining irreducible failure is the outer environment's child-process policy rather than launcher fragility.
- Changes:
  Updated `services/minecraft/scripts/stream-gemma-daemon-worker.ps1` so the launcher:
  - falls back cleanly when `Win32_Process` inspection is denied instead of stalling before preflight,
  - uses a direct TCP socket probe for Fabric bridge readiness instead of `Get-NetTCPConnection`,
  - logs explicit startup checkpoints around legacy-runtime cleanup and preflight,
  - bypasses `pnpm` / corepack entirely when launching the soak supervisor,
  - prefers the latest compiled runtime for supervisor startup and sets absolute `--env-file` paths plus a direct compiled bot command for the child process.
  Updated `services/minecraft/scripts/start-stream-gemma-daemon.ps1` and `services/minecraft/scripts/stop-stream-gemma-daemon.ps1` so daemon PID matching also degrades safely when `Win32_Process` command-line inspection is unavailable.
- Validation:
  - PowerShell parser checks passed for:
    - `services/minecraft/scripts/stream-gemma-daemon-worker.ps1`
    - `services/minecraft/scripts/start-stream-gemma-daemon.ps1`
    - `services/minecraft/scripts/stop-stream-gemma-daemon.ps1`
  - Live daemon rerun evidence:
    - `services/minecraft/runtime/live-daemon/launcher-session.log` now shows `legacy_runtime_cleanup_finished -> preflight_started -> starting_soak_supervisor -> Launching compiled soak supervisor ...`
    - `services/minecraft/runtime/live-daemon/soak-supervisor-2026-04-19T02-12-28.log` now fails at `spawn EPERM` from the compiled supervisor child launch, which is further downstream than the previous `bridge_preflight_failed` and `corepack ... pnpm` failures.
- Result:
  The unattended launcher path is now materially stronger: it can keep an already-open Minecraft client, bypass WMI/corepack-specific startup failures, and reach compiled supervisor launch. The remaining live blocker in this sandbox is the outer child-process permission boundary (`spawn EPERM`), not the daemon's bridge/window detection path.
- Next hypothesis:
  Run the next soak from an unsandboxed shell or OS-level launcher that permits Node child-process spawn. If the bot still remains in the same shaft after that, the next blocker returns to gameplay: validate the existing `recoverTowardSurface` + pillar escape chain and then debug post-surface food/torch/sword handoff toward iron and diamond progression.

## Iteration 13 - Shaft-trap prompt facts for surface recovery selection

- Screenshot checkpoint:
  `runtime/minecraft-observation/minecraft-window-20260419-030139.png`
- Observation:
  A fresh direct window capture still showed the avatar inside the same enclosed stone shaft with a pickaxe equipped, shield/log/crafting-table/furnace/cobblestone visible, and full hunger. That confirms the current live issue is still "recognize and escape the shaft trap" rather than generic low-survival ambiguity.
- Hypothesis:
  The runner already has a generic pillar-based escape fallback, but the planner / decision prompt still only sees `underground_cave` plus `surface_escape_needed`. Exposing a sharper canonical fact set like `mobility_state=shaft_trap` and scaffold availability should make LLM-side objective selection choose surface recovery from the actual observed terrain instead of treating the state like any other cave.
- Changes:
  Added shared surface-recovery prompt helpers in `services/minecraft/src/utils/surface-recovery.ts`, wired `services/minecraft/src/libs/llm-agent/world-state.ts` to emit `mobility_state` and `surface_escape_scaffold`, updated `services/minecraft/src/autonomy/objectives.ts` so recovery gaps can promote a shaft-specific surface objective, and taught `services/minecraft/src/agents/planning/adapter.ts` to keep those facts in planner context. Added focused regressions in `services/minecraft/src/libs/llm-agent/world-state.test.ts` and `services/minecraft/src/autonomy/objectives.test.ts`.
- Validation:
  - Pending after code patch: `pnpm -F @proj-airi/minecraft-bot exec vitest run src/libs/llm-agent/world-state.test.ts src/autonomy/objectives.test.ts`
  - Pending after code patch: `pnpm -F @proj-airi/minecraft-bot typecheck`
  - Pending after code patch: `pnpm -F @proj-airi/minecraft-bot lint:fix`
  - Live relaunch is still expected to remain blocked in this sandbox by supervisor child `spawn EPERM`, so post-patch gameplay validation likely still requires an unsandboxed next run.
- Result:
  The autonomy prompt stack now distinguishes a closed shaft trap from a generic underground cave and carries scaffold readiness forward into evaluator-driven recovery selection. The next live rerun should be able to choose surface escape from the observed trap state immediately instead of relying on broader cave recovery heuristics alone.
- Next hypothesis:
  Once child-process spawn is available again, verify that the planner actually selects `recoverTowardSurface` from the new shaft facts and then inspect whether the next failure shifts from shaft escape to post-surface food/torch buffering.

## Iteration 14 - Surface-recovery goal alignment plus faster first-step escape

- Screenshot checkpoints:
  - `runtime/minecraft-observation/minecraft-window-20260419-042231.png`
  - `runtime/minecraft-observation/minecraft-window-20260419-042528.png`
  - `runtime/minecraft-observation/minecraft-window-20260419-043209.png`
- Observation:
  Direct compiled-runtime live runs are now possible in this sandbox even though the supervisor path still dies at `spawn EPERM`. Those live runs proved two distinct facts:
  - the autonomy stack now rewrites the current underground bootstrap state into `Escape to the surface to gather wood` during real gameplay, and
  - the Fabric bridge still intermittently reports `getInventory -> { items: [] }`, which collapses tool / supply awareness and remains the biggest blocker to true iron -> diamond progression.
  A direct websocket probe against `ws://127.0.0.1:8089` returned `{"status":"ok","items":[],"selectedSlot":0}` even while live recovery logs later observed transient local inventory like `dirt x2`. That makes the next root issue "stale empty inventory pulls clobbering visible state", not only surface-goal selection.
- Hypothesis:
  Objective selection was still too willing to fall back into generic underground progression, and the direct surface-recovery fast path wasted too much time on an immediate blind `goToCoordinates(y+12)` climb before trying observation-driven surface cues. Tightening the objective/orchestrator alignment and reordering the first recovery steps should increase real upward progress even before the inventory-sync bug is fixed.
- Changes:
  Updated `services/minecraft/src/autonomy/objectives.ts` and `services/minecraft/src/autonomy/decision-provider.ts` so evaluator output now exposes a recommended objective, and generic underground iron-ready intent can be realigned to `Escape to the surface to resupply food and torches for deeper mining`.
  Updated `services/minecraft/src/autonomy/orchestrator.ts` so generic underground progression goals are replaced with that new surface-resupply objective when the bot is iron-ready but cave supplies are thin or hostile pressure is high. Added matching regression coverage in `services/minecraft/src/autonomy/objectives.test.ts`, `services/minecraft/src/autonomy/decision-provider.test.ts`, and `services/minecraft/src/autonomy/orchestrator.goal-recovery.test.ts`.
  Updated `services/minecraft/src/agents/planning/index.ts` so the structured surface-recovery fast path now tries `searchForBlock(grass_block)` and `moveAway` before the blind local `goToCoordinates` climb. Added regression coverage in `services/minecraft/src/agents/planning/index.test.ts`.
  Mirrored the live-runtime behavior into the compiled files used by direct foreground runs:
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/autonomy/objectives.js`
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/autonomy/decision-provider.js`
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/autonomy/orchestrator.js`
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/agents/planning/index.js`
- Validation:
  - `node_modules\.bin\tsc.CMD -p services\minecraft\tsconfig.json --noEmit`
  - `node_modules\.bin\eslint.CMD ... --fix` on the touched Minecraft autonomy / planning files
  - `node_modules\.bin\vitest.CMD run ...` is still blocked here because Vite/esbuild startup hits `spawn EPERM`
  - Live foreground run log:
    - `services/minecraft/runtime/live-daemon/manual-foreground-2026-04-19T04-22-53.log`
    showed the old ordering: surface recovery selected correctly, but `goToCoordinates` burned ~30s before `searchForBlock` / `moveAway` produced motion.
  - Live foreground run log after the fast-path reorder:
    - `services/minecraft/runtime/live-daemon/manual-foreground-2026-04-19T04-30-23.log`
    shows the new ordering immediately:
    - `searchForBlock(grass_block)` first,
    - then `moveAway(32)`,
    - then the higher-Y `goToCoordinates` fallback only after those observed-surface steps.
    That rerun moved the bot ~18m before the fallback climb stalled, which is materially better than spending the first ~30s on the failed climb.
  - Direct bridge probe:
    - `getInventory` still returns an empty item list from the live Fabric websocket even after movement.
- Result:
  The live autonomy stack now starts surface escape from observation-driven actions immediately instead of wasting its first recovery window on a blind vertical coordinate hop. Goal alignment toward surface resupply is also in place in source and compiled runtime. The remaining major blocker to diamond-path autonomy is now the bridge inventory desync: empty inventory pulls still erase the bot's real tool / food / torch context and cause progression logic to underestimate what the player already has.
- Next hypothesis:
  Stabilize Fabric bridge inventory reads so transient empty `getInventory` responses do not clobber the last visible non-empty state. Once inventory facts stop collapsing to empty, rerun the same live recovery path and validate the full handoff: surface escape -> food / torch buffer -> iron pickaxe -> diamond acquisition.

## Iteration 15 - Empty-inventory guard plus coastal food fallback

- Screenshot checkpoints:
  - `runtime/minecraft-observation/minecraft-window-20260419-050148.png`
  - `runtime/minecraft-observation/minecraft-window-20260419-051322.png`
- Observation:
  Direct bridge telemetry no longer matches the old shaft-focused picture from earlier runs. During this iteration:
  - a direct websocket probe first returned `getStatus -> health=17.833336, food=17`, `getBiome -> minecraft:beach`, nearby `cod`, and `getInventory -> rotten_flesh x1`,
  - a short compiled foreground soak (`runtime/manual-bot-start/20260419-051337/minecraft-bot.stdout.log`) showed the live autonomy stack selecting `Gather wood and craft a crafting table` and finding `minecraft:oak_log` at `(-321, 73, 138)`, and
  - a later direct probe returned `getStatus -> health=5.833335, food=20` with `getInventory -> items=[]`.
  That means the current live blocker is no longer only underground shaft recovery. The bot is back in a fragile coastal/bootstrap state, and empty bridge inventory snapshots can still wipe out the visible tool/food context right when recovery becomes critical.
  Visual capture also remains imperfect: the new focused screen-copy capture is cleaner than the older `PrintWindow` path, but this run's image still did not line up with bridge telemetry, so bridge logs remain the more trustworthy state source for now.
- Hypothesis:
  The LLM/runtime stack needs two generic survival improvements before the next diamond push is meaningful:
  - preserve the last visible inventory across short bursts of empty Fabric bridge snapshots, and
  - treat fish as first-class generic food targets so beach/ocean starts do not wait on land animals before survival stabilizes.
- Changes:
  Updated `services/minecraft/src/libs/fabric-bridge/bot-proxy.ts` so `getInventory` pulls and `state:inventory` pushes preserve the last visible inventory for a short grace window when the bridge regresses to an empty item list, and reset that preservation on death/spawn. Added focused regressions in `services/minecraft/src/libs/fabric-bridge/bot-proxy.test.ts`.
  Updated `services/minecraft/src/runner/phases.ts` so deterministic food supply can hunt `rabbit`, `cod`, and `salmon` instead of depending only on larger land animals.
  Updated `services/minecraft/src/agents/planning/index.ts` and `services/minecraft/src/agents/planning/index.test.ts` so fish searches normalize into the same `food-animal` suppression family as generic animal food retries.
  Updated `services/minecraft/scripts/capture-minecraft-window.ps1` with `-PreferScreenCopy`, allowing future runs to bypass stale `PrintWindow` captures when focused foreground copying is preferable.
  Mirrored the live-runtime gameplay changes into the compiled files used by direct foreground runs:
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/libs/fabric-bridge/bot-proxy.js`
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/runner/phases.js`
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/agents/planning/index.js`
- Validation:
  - `node_modules\.bin\tsc.CMD -p services\minecraft\tsconfig.json --noEmit`
  - `node_modules\.bin\eslint.CMD --fix` on the touched Minecraft TypeScript files
  - PowerShell parser check passed for `services/minecraft/scripts/capture-minecraft-window.ps1`
  - `node --check` passed for:
    - `services/minecraft/runtime/compiled-run-20260418-2040/src/libs/fabric-bridge/bot-proxy.js`
    - `services/minecraft/runtime/compiled-run-20260418-2040/src/runner/phases.js`
    - `services/minecraft/runtime/compiled-run-20260418-2040/src/agents/planning/index.js`
  - Direct bridge probes:
    - initial probe confirmed `minecraft:beach` plus nearby fish and a partial `rotten_flesh x1` inventory snapshot,
    - later probe confirmed a fully empty inventory snapshot while health had dropped to `5.833335`.
  - Live foreground soak:
    - `runtime/manual-bot-start/20260419-051337/minecraft-bot.stdout.log`
    - the bot started successfully against the patched compiled runtime, selected `Gather wood and craft a crafting table`, and found a reachable oak log before the short observation run ended.
- Result:
  The runtime now has a concrete guard against the exact empty-inventory regression that has been hiding tools and food from the LLM layer, and the generic food-recovery path no longer assumes the world must provide cows/pigs/sheep/chickens before survival can continue. This is still not enough to claim diamond-path stability, but it directly improves the current live state instead of only the older shaft scenario.
- Next hypothesis:
  Run the next live soak long enough to confirm the empty-snapshot guard keeps wood/food visibility stable while the bot transitions from `Gather wood and craft a crafting table` into `Gather materials and craft a sword` / food recovery in the current beach state. If bridge telemetry and focused captures still disagree, continue treating bridge logs as primary until a more trustworthy visual capture path is available.

## Iteration 16 - Restart-time inventory resume cache

- Screenshot checkpoints:
  - `runtime/minecraft-observation/minecraft-window-20260419-060209.png`
  - `runtime/minecraft-observation/minecraft-window-20260419-061605.png`
- Observation:
  The live state has shifted again from the older beach bootstrap. A fresh direct bridge probe before the patch reported:
  - `getStatus -> health=20, food=20`
  - `getBiome -> minecraft:forest`
  - `getInventory -> items=[]`
  - nearby underground hostiles still visible through `getEntities`
  while the focused Minecraft tab capture still showed the same blank stone-wall first-person frame.
  A short post-patch foreground soak in `runtime/manual-bot-start/20260419-061510/minecraft-bot.stdout.log` confirmed the runtime is still making real planner-backed progress despite that visual mismatch:
  - selected `Escape to the surface to gather wood`,
  - pathfound to `grass_block` at `(-293, 64, 188)`,
  - then moved away successfully to roughly `(-296, 64, 180)`,
  - but action verification still observed `inventory: {}` and no equipped/offhand facts.
  That means the next blocker is no longer route selection in this run; it is continuity of inventory knowledge across bot restarts and the continuing bridge/screenshot mismatch.
- Hypothesis:
  The current empty-inventory guard only helps after the same bot process has already seen a non-empty inventory snapshot. If the runtime restarts while the Fabric bridge is still stuck returning `items=[]`, the autonomy stack regresses back to early bootstrap assumptions even when the previous process already had better tool/armor context. Persisting the last visible inventory snapshot across process restarts should let the LLM resume from the last known progression state instead of re-deriving from an empty bridge pull every time.
- Changes:
  Added restart-time bridge resume storage in:
  - `services/minecraft/src/libs/fabric-bridge/session-resume.ts`
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/libs/fabric-bridge/session-resume.js`
  Updated `services/minecraft/src/libs/fabric-bridge/bot-proxy.ts` and the compiled runtime mirror so `BotProxy`:
  - loads a recent persisted inventory/armor/offhand snapshot on startup,
  - reuses that state when the first live bridge refresh is still empty,
  - persists newly visible inventory snapshots after bridge refreshes/equip/slot updates, and
  - clears the persisted resume state on death so stale gear does not leak across a real loss event.
  Added focused regressions in `services/minecraft/src/libs/fabric-bridge/bot-proxy.test.ts` covering startup restore, persistence after refresh, and death-time cleanup.
- Validation:
  - `node_modules\.bin\tsc.CMD -p services\minecraft\tsconfig.json --noEmit`
  - `node_modules\.bin\eslint.CMD --fix services/minecraft/src/libs/fabric-bridge/bot-proxy.ts services/minecraft/src/libs/fabric-bridge/session-resume.ts services/minecraft/src/libs/fabric-bridge/bot-proxy.test.ts`
  - `node --check services/minecraft/runtime/compiled-run-20260418-2040/src/libs/fabric-bridge/bot-proxy.js`
  - `node --check services/minecraft/runtime/compiled-run-20260418-2040/src/libs/fabric-bridge/session-resume.js`
  - `node_modules\.bin\vitest.CMD run services/minecraft/src/libs/fabric-bridge/bot-proxy.test.ts` is still blocked here because Vite/esbuild startup hits `spawn EPERM`.
  - `pnpm -F @proj-airi/minecraft-bot typecheck` and `pnpm lint:fix` are still blocked here because corepack/pnpm access hits `EPERM`.
- Result:
  The runtime no longer depends solely on same-process memory to survive transient bridge inventory collapse. Once the bridge emits any real inventory again, later restarts can keep that context instead of falling straight back to empty-bootstrap planning. The live soak also reconfirmed that planner-side surface recovery is working, while the remaining evidence gap is now primarily telemetry trust: bridge inventory stayed empty and focused captures still looked stale even while the bot physically moved.
- Next hypothesis:
  Let the patched runtime encounter at least one non-empty bridge inventory snapshot, then restart it and confirm the new resume cache keeps progression facts alive across the restart. In parallel, keep treating bridge movement logs as the primary truth source until the Minecraft tab capture path can reflect the same state changes.

## Iteration 17 - Wood bootstrap unblocked in the live compiled runtime

- Screenshot checkpoints:
  - `runtime/minecraft-observation/minecraft-window-20260419-071249.png`
  - `runtime/minecraft-observation/minecraft-window-20260419-071826.png`
  - `runtime/minecraft-observation/minecraft-window-20260419-072259.png`
  - `runtime/minecraft-observation/minecraft-window-20260419-072412.png`
- Observation:
  At the start of this run the live compiled runtime was out of sync with source in two critical places:
  - the compiled planner/action bundle still lacked the newer `recoverTowardSurface` fast path even though source already had it, and
  - `collectBlocks(log)` was still being rejected by inventory preflight because no axe/pickaxe was visible, which hard-blocked the first wood bootstrap step.
  Live soaks also exposed a second runtime-only blocker: `searchForBlock(log)` could reach Baritone fallback and then sit in a remote-walk loop while the focused window capture still showed a stone wall, because tiny wall-contact jitter counted as "movement" and never tripped the existing stuck watchdog.
  After the patch sequence, the direct compiled soak in `runtime/manual-bot-start/20260419-072233/minecraft-bot.stdout.log` finally progressed through the old deadlock:
  - `searchForBlock(log)` found `minecraft:oak_log` and, after Baritone falsely reported completion, the new remote-walk watchdog logged `Remote movement made no meaningful progress, giving up`,
  - action verification then completed instead of hanging,
  - `collectBlocks(log)` preflight reported `inventory_task_readiness: mine=ready`,
  - `gatherWood` started and invoked `baritone_mine`, and
  - a follow-up bridge probe reported `oak_log x3` in slot 0.
  The visual mismatch is still real: all focused screenshots in this run continued to show the old stone-wall frame even after bridge telemetry confirmed movement and visible logs in inventory.
- Hypothesis:
  The next blocker is no longer "cannot start wood collection." The runtime can now bootstrap logs again, so the next live target should be extending that recovered state through `crafting_table -> sword -> shelter -> iron` while separately explaining why focused window captures remain stale even when bridge telemetry is coherent.
- Changes:
  Updated `runtime/manual-bot-start/launch-local-compiled-bot.ps1` so it:
  - resolves the latest `compiled-run-*` directory dynamically instead of pinning one hard-coded build,
  - sets `MINECRAFT_SESSION_RESUME_DIR` for the persisted bridge-resume cache, and
  - launches the compiled runtime via detached `Start-Process` with run metadata/pid capture instead of treating child `stderr` as a fatal PowerShell error.
  Restored live compiled-runtime parity for the surface-recovery path in:
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/agents/action/tools.js`
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/agents/planning/index.js`
  so the launcher now runs the same `recoverTowardSurface`-aware planner/action behavior already present in source.
  Updated early mining inventory policy in:
  - `services/minecraft/src/libs/inventory/policy.ts`
  - `services/minecraft/src/skills/actions/inventory.ts`
  - `services/minecraft/src/skills/actions/inventory.test.ts`
  and mirrored the runtime behavior in:
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/libs/inventory/policy.js`
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/skills/actions/inventory.js`
  so `collectBlocks(log)` can proceed bare-handed when no axe exists, while still preferring an axe whenever one is visible.
  Updated Fabric remote-walk recovery in:
  - `services/minecraft/src/libs/fabric-bridge/pathfinder.ts`
  - `services/minecraft/src/libs/fabric-bridge/pathfinder.test.ts`
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/libs/fabric-bridge/pathfinder.js`
  so remote movement now aborts when the bot jitters without meaningful distance/elevation improvement, instead of only when coordinates are almost perfectly static.
- Validation:
  - PowerShell parser check passed for `runtime/manual-bot-start/launch-local-compiled-bot.ps1`.
  - `TS_PARSE_OK` via `typescript.transpileModule` for:
    - `services/minecraft/src/libs/inventory/policy.ts`
    - `services/minecraft/src/skills/actions/inventory.ts`
    - `services/minecraft/src/skills/actions/inventory.test.ts`
    - `services/minecraft/src/libs/fabric-bridge/pathfinder.ts`
    - `services/minecraft/src/libs/fabric-bridge/pathfinder.test.ts`
  - `node --check` passed for:
    - `services/minecraft/runtime/compiled-run-20260418-2040/src/agents/action/tools.js`
    - `services/minecraft/runtime/compiled-run-20260418-2040/src/agents/planning/index.js`
    - `services/minecraft/runtime/compiled-run-20260418-2040/src/libs/inventory/policy.js`
    - `services/minecraft/runtime/compiled-run-20260418-2040/src/skills/actions/inventory.js`
    - `services/minecraft/runtime/compiled-run-20260418-2040/src/libs/fabric-bridge/pathfinder.js`
  - Live bridge probes:
    - before the movement watchdog fix, `getInventory -> items=[]` and screenshots still showed the stone-wall frame,
    - after the final soak, `getInventory -> oak_log x3` and nearby dropped `oak_log` / `apple` entities were visible through the bridge.
  - Live compiled soaks:
    - `runtime/manual-bot-start/20260419-071807/minecraft-bot.stdout.log` confirmed `collectBlocks(log)` no longer failed inventory preflight immediately,
    - `runtime/manual-bot-start/20260419-072233/minecraft-bot.stdout.log` confirmed the new remote no-progress watchdog, successful hand-ready preflight, and entry into `gatherWood`.
  - `node_modules\\.bin\\vitest.CMD run ...` is still blocked here because Vite/esbuild startup hits `spawn EPERM`.
  - `pnpm ... typecheck` / `pnpm lint:fix` are still blocked here because corepack/pnpm access hits `EPERM`.
- Result:
  The live compiled runtime can bootstrap wood again under LLM control without a hard-coded script: it now exits the remote-move wall stall, allows bare-handed log collection, and repopulates bridge inventory with real logs. This is not yet a diamond-capable run, but it clears the current first-step blocker that was preventing any progression toward tools, shelter, and iron.
- Next hypothesis:
  Run the next long soak from the recovered `oak_log x3` state and verify that the planner converts it into `crafting_table -> wooden/stone tools -> furnace/food -> iron` without bridge inventory collapsing again. In parallel, keep treating bridge telemetry as primary truth until the focused Minecraft tab capture path can explain why it still renders the same stone-wall frame after confirmed movement and item gains.

## Iteration 18 - Unsupported inventory cleanup no longer hijacks bootstrap

- Screenshot checkpoints:
  - `runtime/minecraft-observation/minecraft-window-20260419-082320.png`
- Observation:
  The live foreground soak no longer reproduced the previous `Organize inventory and keep a quick-loot slot open` failure. Instead, the run immediately replaced the underground crafting-table bootstrap with `Escape to the surface to gather wood`, and when `recoverTowardSurface` timed out after 90s the planner recovered into `collectBlocks(log) -> searchForBlock(grass_block) -> moveAway` rather than stalling on inventory-goal verification. During that recovery the bridge mod finally exposed its real unsupported inventory capabilities (`compactInventory`, `swapInventorySlots`), but preflight stayed `ready` and no quick-loot goal verification failure appeared.
  The focused screenshot also changed meaningfully in this run: `runtime/minecraft-observation/minecraft-window-20260419-082320.png` shows the current dirt-wall/hotbar scene instead of the older frozen stone-wall frame, so direct tab capture is no longer obviously stuck on the same stale image even though bridge telemetry still remains the more reliable source.
- Changes:
  Updated source and the live compiled runtime in:
  - `services/minecraft/src/autonomy/objectives.ts`
  - `services/minecraft/src/agents/planning/index.ts`
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/autonomy/objectives.js`
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/agents/planning/index.js`
  so capability-limited inventory cleanup gets deprioritized during missing crafting-table / pickaxe bootstrap, and goal parsing now treats `quick-loot` as a compound token instead of accidentally firing the generic `loot` item-collection path.
  Added source regressions in:
  - `services/minecraft/src/autonomy/objectives.test.ts`
  - `services/minecraft/src/agents/planning/index.test.ts`
  to pin the new bootstrap-priority and quick-loot verification behavior.
- Validation:
  - Manual compiled-runtime assertions passed via direct `node --input-type=module` import:
    - capability-limited inventory cleanup now falls below `Craft a crafting table`
    - `verifyGoalCompletion('Organize inventory and keep a quick-loot slot open')` now returns `true` instead of treating `loot` as an item target
  - `node --check` passed for:
    - `services/minecraft/runtime/compiled-run-20260418-2040/src/autonomy/objectives.js`
    - `services/minecraft/runtime/compiled-run-20260418-2040/src/agents/planning/index.js`
  - `node_modules\.bin\eslint.CMD --fix` passed for the touched source files.
  - `node_modules\.bin\tsc.CMD -p services\minecraft\tsconfig.json --noEmit` is still blocked by a pre-existing unrelated error in `services/minecraft/src/libs/fabric-bridge/pathfinder.test.ts(207,61)`.
  - `node_modules\.bin\vitest.CMD run ...` is still blocked here because Vite/esbuild startup hits `spawn EPERM`.
  - Live foreground soak (`node --env-file=... services/minecraft/runtime/compiled-run-20260418-2040/src/main.js`) confirmed:
    - no recurrence of the quick-loot goal verification failure,
    - inventory organizer warnings for unsupported slot-management commands without aborting preflight,
    - bridge inventory after the soak at `oak_log x63`, `dirt x6`, `oak_log x30`, `cobblestone x34`, `oak_planks x1`,
    - the active blocker has shifted to `recoverTowardSurface` timing out before the replan can finish the handoff to open terrain.
- Result:
  The autonomy stack is no longer wasting bootstrap loops on a bridge-limited inventory cleanup goal or falsely failing that goal because of the `quick-loot` wording. The next live blocker toward iron/diamond progression is surface-recovery handoff reliability, not inventory objective selection.
- Next hypothesis:
  Tighten the surface-recovery handoff so once nearby `grass_block` / open-terrain cues are visible, the bot abandons the long `recoverTowardSurface` attempt sooner and promotes the already-working `searchForBlock(grass_block) -> moveAway` recovery path before burning the full 90s timeout.

## Iteration 19 - Local surface cues now preempt the long recovery climb

- Screenshot checkpoints:
  - `runtime/minecraft-observation/minecraft-window-20260419-091423.png`
  - `runtime/minecraft-observation/minecraft-window-20260419-091910.png`
- Observation:
  The current live world no longer starts in the old enclosed shaft branch. A direct compiled foreground soak on April 19, 2026 reattached to the already-open client immediately, used the nearby crafting table around `(-387, 63, 276)`, crafted planks/table successfully, later showed `stone_pickaxe` and `stick` in inventory, and then pivoted into `Collect nearby food` with a real `moveAway(24)` step. The focused capture at `runtime/minecraft-observation/minecraft-window-20260419-091910.png` also confirmed the client is no longer stuck on the older stone-wall frame: it showed the crafting UI open with cobblestone, logs, planks, sticks, and a stone pickaxe visible in the hotbar.
  That means the surface-handoff code path was not naturally exercised in this specific live state, but the next blocker that surfaced is still useful: sandboxed `fetch` calls now force the autonomy provider and public-speech lanes into `EACCES`, and crafted-item goal verification still sometimes fails even after the bridge/runtime clearly crafted the table/pickaxe successfully.
- Hypothesis:
  The surface-handoff fix should still land now because the previous live blocker was a deterministic planner/runtime handoff problem, not a state-specific artifact. Once the bot returns to an underground recovery branch, it should no longer spend the first 90 seconds inside `recoverTowardSurface` if local `grass_block` / open-terrain cues are already visible. The next separate blocker to address after that is crafted-item verification lag after successful crafting.
- Changes:
  Updated source planner fast-path recovery in:
  - `services/minecraft/src/agents/planning/index.ts`
  so local surface-facing cue detection (`grass_block`, dirt/sand/moss, logs/leaves) now prepends `searchForBlock(grass_block) -> moveAway(24)` before `recoverTowardSurface` whenever the current cache already shows an immediate surface cue.
  Updated source runner recovery in:
  - `services/minecraft/src/runner/phases.ts`
  so `recoverTowardSurface` itself now checks for nearby surface-facing blocks and tries a short `goToPosition(..., closeness=4)` plus reorientation move before falling back to the longer local-exit / climb logic.
  Added focused regressions in:
  - `services/minecraft/src/agents/planning/index.test.ts`
  - `services/minecraft/src/runner/phases.test.ts`
  to pin the cue-first recovery ordering.
  Mirrored the live-runtime planner and runner changes into:
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/agents/planning/index.js`
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/runner/phases.js`
  so direct compiled foreground runs and the daemon bundle see the same cue-first recovery behavior.
- Validation:
  - `node_modules\.bin\eslint.CMD --fix services/minecraft/src/agents/planning/index.ts services/minecraft/src/agents/planning/index.test.ts services/minecraft/src/runner/phases.ts services/minecraft/src/runner/phases.test.ts`
  - `node_modules\.bin\tsc.CMD -p services\minecraft\tsconfig.json --noEmit` still fails on the pre-existing unrelated error in `services/minecraft/src/libs/fabric-bridge/pathfinder.test.ts(207,61)`.
  - `node_modules\.bin\vitest.CMD run services/minecraft/src/agents/planning/index.test.ts services/minecraft/src/runner/phases.test.ts` is still blocked here because Vite/esbuild startup hits `spawn EPERM`.
  - `TS_PARSE_OK` via `typescript.transpileModule` for:
    - `services/minecraft/src/agents/planning/index.ts`
    - `services/minecraft/src/agents/planning/index.test.ts`
    - `services/minecraft/src/runner/phases.ts`
    - `services/minecraft/src/runner/phases.test.ts`
  - `node --check` passed for:
    - `services/minecraft/runtime/compiled-run-20260418-2040/src/agents/planning/index.js`
    - `services/minecraft/runtime/compiled-run-20260418-2040/src/runner/phases.js`
  - Manual compiled planner assertion via `node --input-type=module` confirmed the new surface-recovery ordering:
    - `searchForBlock(grass_block) -> moveAway(24) -> recoverTowardSurface -> collectBlocks(log)`
    - when local grass was already visible in the fake bridge cache.
  - Live compiled foreground soak:
    - `node --env-file=services/minecraft/.env --env-file-if-exists=services/minecraft/.env.local services/minecraft/runtime/compiled-run-20260418-2040/src/main.js`
    - confirmed direct attach to the running client, crafting-table usage, visible crafting UI capture, inventory progression into `stone_pickaxe`, and a later `Collect nearby food` recovery move.
- Result:
  The code and live runtime bundle no longer require the long `recoverTowardSurface` attempt to be the first move whenever local surface cues are already visible. The direct compiled soak also reconfirmed the bot can resume the current world state and keep progressing under LLM/rule-based control. The most important live blocker has shifted again: sandbox `fetch EACCES` forces autonomy/public-speech fallbacks, and crafted-item goal verification still misses successful craft results often enough to churn on bootstrap goals.
- Next hypothesis:
  Stabilize goal verification for freshly crafted tools/tables using the same canonical inventory / bridge-lag protections already added elsewhere. After that, rerun from the current live state and wait for the next underground recovery branch to confirm the new local-cue-first surface handoff fires in-world without the old 90s burn.

## Iteration 20 - Crafted-goal verification survives bridge lag and charcoal routing is live

- Screenshot checkpoints:
  - `runtime/minecraft-observation/minecraft-window-20260419-101633.png`
  - `runtime/minecraft-observation/minecraft-window-20260419-102019.png`
  - `runtime/minecraft-observation/minecraft-window-20260419-102202.png`
- Observation:
  A direct compiled foreground soak on April 19, 2026 confirmed that the live runtime now keeps moving past a successful crafted milestone instead of immediately invalidating it. In `runtime/manual-bot-test/20260419-1018-objective-check/minecraft-bot.stdout.log`, the bot verified furnace placement/search successfully and then selected the new `Smelt charcoal using logs for torch and furnace fuel` objective under rule-based fallback after sandboxed `fetch` failed.
  The next blocker is downstream rather than bootstrap verification: `smeltItem(oak_logx1)` still reports `Furnace screen did not open`, then the run falls into `Collect nearby food` and later replaces into `Escape to the surface to gather wood`. Focused captures at `runtime/minecraft-observation/minecraft-window-20260419-102019.png` and `runtime/minecraft-observation/minecraft-window-20260419-102202.png` still show the current vertical shaft view with a stone pickaxe selected and a crafting table in hotbar. That means direct tab capture is useful as a checkpoint, but it is still not reliable enough to override bridge/runtime logs on its own when the two disagree.
- Hypothesis:
  Crafted-item verification lag was still a real planner blocker, so goal verification needs to treat canonical inventory, held/equipped state, nearby crafting access, and recent craft-sync diagnostics as valid evidence before retrying the same crafted goal. Once that churn is removed, the remaining live blockers should isolate cleanly to furnace GUI interaction and food acquisition instead of relapsing into craft/bootstrap retries.
- Changes:
  Updated source planner verification in:
  - `services/minecraft/src/agents/planning/index.ts`
  so crafted-goal verification now checks canonical inventory snapshots, held/offhand/equipped state, nearby crafting-table / furnace access, and recent `inventory_sync_mismatch` craft diagnostics before declaring the target missing.
  Added focused regressions in:
  - `services/minecraft/src/agents/planning/index.test.ts`
  for held crafted tools, recent craft-sync mismatches, equipped diamond armor, and nearby crafting-table access.
  Fixed the pre-existing package typecheck blocker in:
  - `services/minecraft/src/libs/fabric-bridge/pathfinder.test.ts`
  so the current sandbox can run `tsc --noEmit` successfully again.
  Updated objective wording in:
  - `services/minecraft/src/autonomy/objectives.ts`
  so low-torch states with `furnace + logs + no coal` now emit `Smelt charcoal using logs for torch and furnace fuel` and reuse the existing structured smelt path instead of falling back to the weaker generic fuel-gather objective.
  Added a regression in:
  - `services/minecraft/src/autonomy/objectives.test.ts`
  for the new charcoal-preferring objective selection.
  Mirrored the planner/objective changes into the live compiled runtime:
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/agents/planning/index.js`
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/autonomy/objectives.js`
- Validation:
  - `node_modules\.bin\eslint.CMD --fix` passed for the touched source files.
  - `node_modules\.bin\tsc.CMD -p services\minecraft\tsconfig.json --noEmit` now passes.
  - `node --check` passed for:
    - `services/minecraft/runtime/compiled-run-20260418-2040/src/agents/planning/index.js`
    - `services/minecraft/runtime/compiled-run-20260418-2040/src/autonomy/objectives.js`
  - Manual compiled-runtime assertions passed for:
    - held crafted tool verification,
    - recent `inventory_sync_mismatch` craft verification,
    - equipped diamond armor satisfying `Craft full diamond armor`,
    - nearby crafting-table access satisfying the bootstrap craft-table goal,
    - charcoal-smelting objective selection when `logs + furnace + no coal` are visible.
  - `node_modules\.bin\vitest.CMD run ...` is still blocked here because Vite/esbuild startup hits `spawn EPERM`.
  - Live compiled foreground soaks confirmed:
    - `Craft a furnace` now verifies live after placement/search instead of re-looping on a missing crafted item,
    - `Smelt charcoal using logs for torch and furnace fuel` is now emitted and executed as the next autonomy goal,
    - the immediate next failure is `smeltItem(oak_logx1) failed: Furnace screen did not open`,
    - the next follow-on blocker is `Collect nearby food` stalling before a clean handoff into iron prep.
- Result:
  The live autonomy stack is materially closer to unscripted diamond progression: it no longer wastes the current recovery loop on the old crafted-item verification churn, and the torch/fuel branch now routes into a real structured charcoal-smelting goal. The top blocker has shifted to furnace interaction and food recovery rather than planner milestone recognition.
- Next hypothesis:
  Harden furnace interaction so `smeltItem` can reliably open and use the placed furnace from this current shaft/surface-adjacent state, then broaden food-recovery follow-through so the run can turn `stone_pickaxe + furnace + logs` into stable prep for iron without bouncing back into generic surface escape.

## Iteration 21 - Furnace-open retries now recover into live charcoal success

- Screenshot checkpoints:
  - `runtime/minecraft-observation/minecraft-window-20260419-110136.png`
  - `runtime/minecraft-observation/minecraft-window-20260419-111104.png`
- Observation:
  Before the patch, the focused capture still showed the bot staring at a stone shaft wall with a stone pickaxe, crafting table, and wood/bootstrap supplies. After the patch and a fresh compiled foreground soak (`services/minecraft/runtime/manual-compiled-soak/20260419-110938/minecraft-bot.stdout.log`), the live runtime reattached, crafted a furnace again from the current resumed state, placed it, retried two transient `Furnace screen did not open` failures at `(-388, 68, 251)`, and still verified `charcoal x1` in inventory on the same goal. The post-soak capture shifted to a dirt ceiling / gravel-in-hand view with the furnace now pinned in hotbar, so the state changed materially even though the bot remained underground.
- Hypothesis:
  The furnace path was failing too early because the bot opened furnaces from a loose pathing distance and the Fabric bridge still interacted with furnace / block screens using a fixed `UP` face. Smelting needs both a closer interaction distance with local retarget retries in `services/minecraft` and directional hit selection in `services/minecraft-fabric-mod`.
- Changes:
  Hardened `services/minecraft/src/skills/crafting.ts` so `smeltItem` now approaches furnaces at interaction range, retries `openFurnace` after refreshing the nearby furnace target, and mirrors the same behavior into `services/minecraft/runtime/compiled-run-20260418-2040/src/skills/crafting.js`.
  Updated `services/minecraft-fabric-mod/src/main/java/com/airi/mcbridge/handlers/InventoryHandler.java` so `handleOpenFurnace` now uses the same ordered directional hit results already used by crafting-table opening, instead of a single hardcoded `Direction.UP` click.
  Updated `services/minecraft-fabric-mod/src/main/java/com/airi/mcbridge/handlers/BlockHandler.java` so generic `activateBlock` also uses the preferred interaction face rather than always clicking block tops.
  Added/extended focused regressions in:
  - `services/minecraft/src/skills/crafting.test.ts`
  - `services/minecraft-fabric-mod/src/test/java/com/airi/mcbridge/handlers/InventoryHandlerTest.java`
- Validation:
  - `node_modules\.bin\eslint.CMD --fix services/minecraft/src/skills/crafting.ts services/minecraft/src/skills/crafting.test.ts`
  - `node_modules\.bin\tsc.CMD -p services/minecraft/tsconfig.json --noEmit`
  - `node --check services/minecraft/runtime/compiled-run-20260418-2040/src/skills/crafting.js`
  - `node_modules\.bin\vitest.CMD run services/minecraft/src/skills/crafting.test.ts` is still blocked here because Vite/esbuild startup hits `spawn EPERM`.
  - `services/minecraft-fabric-mod/gradlew.bat test --tests com.airi.mcbridge.handlers.InventoryHandlerTest` is blocked here because the wrapper needs to download Gradle and this sandbox denies outbound socket access.
  - Live compiled foreground soak:
    - `services/minecraft/runtime/manual-compiled-soak/20260419-110938/minecraft-bot.stdout.log`
    - confirmed `Craft a furnace` verification from the resumed live state,
    - logged two retryable `Furnace screen did not open at (-388, 68, 251); refreshing the target and retrying.`,
    - then verified `smeltItem(oak_logx1)` with `charcoal` increasing from `0 -> 1`.
- Result:
  Furnace GUI interaction is no longer the top live blocker on the diamond path. The runtime can now absorb transient furnace-open misses and still complete the charcoal bootstrap goal under the current LLM/rule-based control loop.
- Next hypothesis:
  The next bottleneck is the post-charcoal survival handoff: food acquisition and surface/scouting continuity still collapse into blocked cave-prep / deterministic recovery, so the next change should keep the current `stone_pickaxe + furnace + charcoal` state moving into food buffer and safer surface progression instead of dropping back into underground churn.

## Iteration 22 - Underground food fallback now retargets into surface recovery first

- Screenshot checkpoints:
  - `runtime/minecraft-observation/minecraft-window-20260419-120208.png`
  - `runtime/minecraft-observation/minecraft-window-20260419-121208.png`
- Observation:
  The pre-patch focused capture at `runtime/minecraft-observation/minecraft-window-20260419-120208.png` still showed the bot wedged underground with no food in hotbar, a furnace/crafting-table bootstrap kit, and the camera pressed into a dirt ceiling. A fresh detached compiled soak from the same resumed world state (`services/minecraft/runtime/manual-compiled-soak/20260419-121038/minecraft-bot.stdout.log`) immediately chose `Escape to the surface to gather wood` under rule-based fallback instead of drifting back through `Craft torches... -> Collect nearby food -> animal search`. The first live step was `recoverTowardSurface`, and `runner/phases` then used the nearby `grass_block` cue at `(-404, 71, 250)` before a reorientation move. The later focused capture at `runtime/minecraft-observation/minecraft-window-20260419-121208.png` shows the camera and inventory state changed again (coal visible below, cobblestone count increased), so the bot did move materially even though it had not escaped the shaft yet.
- Hypothesis:
  The remaining food blocker was not only lack of animals; the planner and recovery logic still treated generic food shortage as an animal-search problem even when the bot was trapped underground beside a visible surface cue. That needs to become a surface-resupply problem first, especially for the current `stone_pickaxe + furnace + charcoal + no sword + no food + no torches` state.
- Changes:
  Updated `services/minecraft/src/agents/planning/index.ts` so generic `food` gathering now checks for an underground, cue-adjacent trap shape and rewrites deterministic food collection/recovery into `searchForBlock(grass_block) -> moveAway -> recoverTowardSurface -> searchForEntity(animal) -> attack(animal)` instead of opening with blind animal search. Added focused regressions in `services/minecraft/src/agents/planning/index.test.ts` for both the initial `Collect nearby food` plan and the `searchForEntity(animal) failed` recovery case.
  Updated `services/minecraft/src/autonomy/objectives.ts` so stone-tier underground states with `foodItemCount=0`, `torchCount<4`, and no sword now promote `Escape to the surface to gather wood` above in-place cave prep. Added the matching regression in `services/minecraft/src/autonomy/objectives.test.ts`.
  Mirrored the planner/objective changes into the live compiled runtime:
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/agents/planning/index.js`
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/autonomy/objectives.js`
- Validation:
  - `node_modules\.bin\eslint.CMD --fix services/minecraft/src/agents/planning/index.ts services/minecraft/src/agents/planning/index.test.ts services/minecraft/src/autonomy/objectives.ts services/minecraft/src/autonomy/objectives.test.ts`
  - `node_modules\.bin\tsc.CMD -p services/minecraft/tsconfig.json --noEmit`
  - `node --check services/minecraft/runtime/compiled-run-20260418-2040/src/agents/planning/index.js`
  - `node --check services/minecraft/runtime/compiled-run-20260418-2040/src/autonomy/objectives.js`
  - `node_modules\.bin\vitest.CMD run services/minecraft/src/agents/planning/index.test.ts services/minecraft/src/autonomy/objectives.test.ts` is still blocked here because Vite/esbuild startup hits `spawn EPERM`.
  - Live compiled soak:
    - `services/minecraft/runtime/manual-compiled-soak/20260419-121038/minecraft-bot.stdout.log`
    - immediately selected `Escape to the surface to gather wood`,
    - entered `recoverTowardSurface`,
    - used the nearby `grass_block` cue before longer recovery movement,
    - and changed the focused visual state by the follow-up capture.
- Result:
  The autonomy stack no longer starts underground food recovery with the wrong survival primitive. From the current resumed shaft state, it now retargets into surface recovery first, which is a necessary precondition for unscripted iron and diamond progression.
- Next hypothesis:
  The next real blocker is no longer whether the bot understands that it should surface first; it is whether the first cue-driven recovery move can be carried through into a persistent surface-food/wood handoff under a longer soak. That needs either an unsandboxed longer run or a more persistent launcher path than this sandbox currently allows.

## Iteration 23 - Surface-cue ascent now preserves altitude and exits the shaft

- Screenshot checkpoints:
  - `runtime/minecraft-observation/minecraft-window-20260419-130158.png`
  - `runtime/minecraft-observation/minecraft-window-20260419-130909.png`
- Observation:
  Before the patch, the focused capture at `runtime/minecraft-observation/minecraft-window-20260419-130158.png` still showed the familiar coal-lined shaft floor from the underground deadlock branch. The latest live compiled foreground soak on April 19, 2026 reattached at `(-407.38, 64, 235.62)`, selected `Escape to the surface to gather wood`, touched a nearby `grass_block` cue at `(-406, 68, 236)`, but only rose `+1.25Y` on that first pathfinder step. That reproduces the concrete failure class from the prior log: cue contact was real, but the old recovery shape could still burn that progress by immediately randomizing with `moveAway`.
  With the patch in place, the same soak then issued a second exact ascent onto the cue top at `(-406, 69, 236)`, verified `terrainContext=surface_forest`, and continued directly into `collectBlocks(log)`, where Baritone finished with `oak_log x4`. The later capture at `runtime/minecraft-observation/minecraft-window-20260419-130909.png` is darker and no longer trustworthy as primary truth on its own, but it at least confirms the camera state changed materially away from the earlier coal-floor view.
- Hypothesis:
  The live shaft escape problem was no longer lack of cue detection. It was loss of gained altitude after a loose `GoalNear(..., range=4)` contact. Recovery should first try to climb exactly onto the observed cue and preserve any real upward progress before broader exit search or random reorientation.
- Changes:
  Updated `services/minecraft/src/runner/phases.ts` so nearby surface-cue recovery now:
  - attempts an exact ascent onto the cue top (`cue.y + 1`, `range=1`) when the first cue contact got close but did not yet verify escape,
  - preserves gained altitude instead of immediately calling `moveAway` when the bot has already risen meaningfully,
  - still falls back to the old reorientation branch when cue contact produced no usable vertical progress.
  Added focused regressions in:
  - `services/minecraft/src/runner/phases.test.ts`
  covering both the new exact cue-top ascent path and the retained `moveAway` fallback when ascent stays blocked.
  Mirrored the runtime change into:
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/runner/phases.js`
  so the live compiled soak uses the same cue-preserving recovery behavior.
- Validation:
  - `node_modules\.bin\eslint.CMD --fix services/minecraft/src/runner/phases.ts services/minecraft/src/runner/phases.test.ts`
  - `node_modules\.bin\tsc.CMD -p services/minecraft/tsconfig.json --noEmit`
  - `node --check services/minecraft/runtime/compiled-run-20260418-2040/src/runner/phases.js`
  - `node_modules\.bin\vitest.CMD run services/minecraft/src/runner/phases.test.ts` is still blocked here because Vite/esbuild startup hits `spawn EPERM`.
  - Live compiled foreground soak:
    - `node --env-file=services/minecraft/.env --env-file-if-exists=services/minecraft/.env.local services/minecraft/runtime/compiled-run-20260418-2040/src/main.js`
    - confirmed `local_surface_cue` rose only `+1.252Y`,
    - then triggered the new `local_surface_cue_ascent`,
    - verified `terrainContext=surface_forest` with `roseBy=5`,
    - and continued into `collectBlocks(log)` where wood gathering finished with `Total logs now: 4`.
- Result:
  The current live shaft branch no longer throws away the first successful surface-cue climb. The autonomy stack can now convert the cue contact into an actual surface escape and immediate wood recovery under the existing LLM/rule-based objective loop.
- Next hypothesis:
  The top blocker has shifted one step later again: after the bot resurfaces and recovers wood, autonomy still churns back into cave-prep / food replacement goals instead of stabilizing a surface food+sword buffer and then re-entering iron prep. That post-surface survival handoff is the next place to harden.

## Iteration 24 - Food-hunt combat fallback now matches the actual combat skill

- Screenshot checkpoints:
  - `runtime/minecraft-observation/minecraft-window-20260419-140240.png`
  - `runtime/minecraft-observation/minecraft-window-20260419-141230.png`
  - `runtime/minecraft-observation/minecraft-window-20260419-141409.png`
- Observation:
  The direct focused capture at `runtime/minecraft-observation/minecraft-window-20260419-140240.png` still showed the player underground with `stone_pickaxe + furnace + crafting_table + logs/planks`, reduced health, and no visible surface progress. The concrete code/log mismatch behind the next survival handoff was that `services/minecraft/src/skills/combat.ts` already falls back to `pickaxe` / `shovel` when no sword or axe exists, but `skills/actions/inventory` and canonical inventory readiness still treated `attack` as sword-or-axe only. That means a real `Collect nearby food` hunt can false-fail at inventory preflight with `ingredient_missing` even though the combat layer would have attacked successfully.
  A fresh compiled foreground reattach (`services/minecraft/runtime/manual-compiled-soak/20260419-141315/minecraft-bot.stdout.log`) confirmed the current resumed world state still immediately chooses `Escape to the surface to gather wood` and enters `recoverTowardSurface` from `(-437.75, 64, 254.50)`. In this sandbox the foreground soak again stopped before later progress logs arrived, and the follow-up focused captures at `...141230.png` and `...141409.png` remained visually unchanged, so the live blocker is still the current surface-recovery hang / sandbox persistence boundary rather than the newly patched food-hunt branch.
- Hypothesis:
  The next autonomous survival branch needs two generic guarantees before it can carry the bot toward iron and diamond gear without hardcoded scripts:
  1. `attack` preflight must accept the same fallback tools the combat executor already uses, so emergency food hunts do not fail before the action starts.
  2. When wood is already present, the structured `Collect nearby food` plan should prepare a sword before hunting instead of assuming combat starts immediately with no weapon upgrade opportunity.
- Changes:
  Updated `services/minecraft/src/skills/actions/inventory.ts` and `services/minecraft/src/libs/inventory/policy.ts` so attack readiness now accepts the same fallback tools as the combat skill (`sword`, `axe`, `pickaxe`, `shovel`) instead of rejecting valid no-sword combat states.
  Updated `services/minecraft/src/agents/planning/index.ts` so the structured `Collect nearby food` fast path now prepends `craftRecipe(sword)` when wood/crafting access already makes that upgrade plausible, before it falls through to animal search/attack.
  Added focused regressions in:
  - `services/minecraft/src/skills/actions/inventory.test.ts`
  - `services/minecraft/src/agents/planning/index.test.ts`
  Mirrored the runtime changes into:
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/skills/actions/inventory.js`
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/libs/inventory/policy.js`
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/agents/planning/index.js`
- Validation:
  - `node_modules\.bin\eslint.CMD --fix services/minecraft/src/skills/actions/inventory.ts services/minecraft/src/libs/inventory/policy.ts services/minecraft/src/agents/planning/index.ts services/minecraft/src/skills/actions/inventory.test.ts services/minecraft/src/agents/planning/index.test.ts`
  - `node_modules\.bin\tsc.CMD -p services/minecraft/tsconfig.json --noEmit`
  - `node --check services/minecraft/runtime/compiled-run-20260418-2040/src/skills/actions/inventory.js`
  - `node --check services/minecraft/runtime/compiled-run-20260418-2040/src/libs/inventory/policy.js`
  - `node --check services/minecraft/runtime/compiled-run-20260418-2040/src/agents/planning/index.js`
  - `node_modules\.bin\vitest.CMD run services/minecraft/src/skills/actions/inventory.test.ts services/minecraft/src/agents/planning/index.test.ts` is still blocked here because Vite/esbuild startup hits `spawn EPERM`.
  - Live compiled reattach:
    - `services/minecraft/runtime/manual-compiled-soak/20260419-141122/minecraft-bot.stdout.log`
    - `services/minecraft/runtime/manual-compiled-soak/20260419-141315/minecraft-bot.stdout.log`
    - both reattached to the current underground save state and entered `recoverTowardSurface`, but sandboxed foreground/background execution still did not stay alive long enough to reach the later food-hunt branch.
- Result:
  The food-hunt path is now mechanically less brittle: no-sword combat can proceed with the same fallback tools the executor already knows how to use, and structured food recovery will opportunistically prepare a sword when wood is already available. This is a generic autonomy improvement toward unscripted iron/diamond progression, not a milestone hardcode.
- Next hypothesis:
  The top live blocker remains one step earlier in the current save state: the resumed underground position still stalls inside `recoverTowardSurface` before the new `food/attack` branch can be exercised live. The next run should either harden that recovery hang directly or move testing into an environment where the bot process can stay attached long enough to observe the surface-to-food handoff.

## Iteration 25 - Surface-recovery bridge waits now obey interactive time budgets

- Screenshot checkpoints:
  - `runtime/minecraft-observation/minecraft-window-20260419-150236.png`
  - `runtime/minecraft-observation/minecraft-window-20260419-150514.png`
  - `runtime/minecraft-observation/minecraft-window-20260419-151322.png`
  - `runtime/minecraft-observation/minecraft-window-20260419-151953.png`
- Observation:
  Fresh focused captures across the latest April 19, 2026 foreground reattach attempts still show the same dark enclosed shaft view with no armor equipped, a selected pickaxe, a furnace/crafting-table/bootstrap hotbar, and no visible surface transition. The corresponding live compiled reattach logs (`services/minecraft/runtime/manual-compiled-soak/20260419-150421`, `...150821`, `...151231`, `...151641`, `...151911`) all stop after `Attempting surface recovery from runner recovery flow` while the process remains alive long enough for periodic speech fallback logs to continue. That means the stall is now inside the bridge/pathfinding lookup chain beneath `escapeTowardSurface`, before any runner-level cue/local-exit/vertical-probe verification logs can fire.
- Hypothesis:
  The current enclosed `y=64` shaft deadlock is not only a gameplay problem; it is also an infrastructure budget problem. Several recovery substeps were still allowed to wait far longer than the action-level budget:
  1. Fabric bridge `findBlocksAsync` fanout could spend the default WebSocket timeout on each queried block type.
  2. Confined relocation at `y>=60` was treated as an unbounded normal walk even when the bot was obviously trapped in stone.
  3. The initial Fabric bridge `goto` / `gotoNear` request still waited a fixed 120 seconds even when the caller set a shorter goal timeout.
  Those waits need to collapse to short interactive budgets so planner/action recovery can continue instead of burning the whole loop inside one bridge request.
- Changes:
  Updated `services/minecraft/src/libs/fabric-bridge/bot-proxy.ts` so `findBlocksAsync` now:
  - caps each direct `findBlocks` WebSocket request to `1500ms`,
  - keeps later block queries alive after one query stalls,
  - stops once the requested count is satisfied,
  - and logs the skipped stalled query for diagnosis.
  Added the matching regression coverage in `services/minecraft/src/libs/fabric-bridge/bot-proxy.test.ts`.

  Updated `services/minecraft/src/skills/movement.ts` so enclosed above-`y60` shaft movement now reuses the underground relocation timeout budget instead of waiting indefinitely just because the bot is near sea level. `goToPosition`, `moveAway`, and `moveToHorizontalTarget` now treat a mostly solid local probe as confined terrain and cap those walks at the same `UNDERGROUND_RELOCATION_TIMEOUT_MS`; added the focused regressions in `services/minecraft/src/skills/movement.test.ts`.

  Updated `services/minecraft/src/libs/fabric-bridge/pathfinder.ts` so the initial `goto` / `gotoNear` WebSocket request now honors `goal.timeoutMs` (bounded to a sane minimum/maximum) instead of always waiting 120 seconds before any fallback can happen. Added the corresponding regression in `services/minecraft/src/libs/fabric-bridge/pathfinder.test.ts`.

  Updated `services/minecraft/src/runner/phases.ts` so nearby surface-cue discovery now checks the synchronous cached block map first via `bot.findBlocks(...)` / `blockAt(...)`, and only falls back to a smaller prioritized async cue query set if the cache is empty. This avoids needlessly opening the slow bridge fanout path before the already-populated local scan data is considered.

  Mirrored the runtime changes into:
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/libs/fabric-bridge/bot-proxy.js`
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/libs/fabric-bridge/pathfinder.js`
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/skills/movement.js`
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/runner/phases.js`
- Validation:
  - `node_modules\.bin\eslint.CMD --fix services/minecraft/src/libs/fabric-bridge/bot-proxy.ts services/minecraft/src/libs/fabric-bridge/bot-proxy.test.ts services/minecraft/src/libs/fabric-bridge/pathfinder.ts services/minecraft/src/libs/fabric-bridge/pathfinder.test.ts services/minecraft/src/skills/movement.ts services/minecraft/src/skills/movement.test.ts services/minecraft/src/runner/phases.ts`
  - `node_modules\.bin\tsc.CMD -p services/minecraft/tsconfig.json --noEmit`
  - `node --check services/minecraft/runtime/compiled-run-20260418-2040/src/libs/fabric-bridge/bot-proxy.js`
  - `node --check services/minecraft/runtime/compiled-run-20260418-2040/src/libs/fabric-bridge/pathfinder.js`
  - `node --check services/minecraft/runtime/compiled-run-20260418-2040/src/skills/movement.js`
  - `node --check services/minecraft/runtime/compiled-run-20260418-2040/src/runner/phases.js`
  - `node_modules\.bin\vitest.CMD run services/minecraft/src/libs/fabric-bridge/bot-proxy.test.ts services/minecraft/src/libs/fabric-bridge/pathfinder.test.ts services/minecraft/src/skills/movement.test.ts` is still blocked here because Vite/esbuild startup hits `spawn EPERM`.
  - Live compiled foreground reattachs:
    - `services/minecraft/runtime/manual-compiled-soak/20260419-150421`
    - `services/minecraft/runtime/manual-compiled-soak/20260419-150821`
    - `services/minecraft/runtime/manual-compiled-soak/20260419-151231`
    - `services/minecraft/runtime/manual-compiled-soak/20260419-151641`
    - `services/minecraft/runtime/manual-compiled-soak/20260419-151911`
    - all still reattached to the same underground shaft state and stopped making observable progress after `Attempting surface recovery from runner recovery flow`, while the focused screenshots remained visually unchanged.
- Result:
  The bridge/runtime stack no longer forces `recoverTowardSurface` to inherit obvious 30-120 second waits for block lookup and initial `goto` dispatch. That hardens the generic autonomy infrastructure for confined-shaft recovery and future mining loops, even though this sandboxed live state still appears to stall deeper in the current `escapeTowardSurface` path.
- Next hypothesis:
  The remaining live blocker is now narrow enough to instrument directly: add stage-level trace points around cue scan, local-exit scan, and the first pathfinder dispatch inside `escapeTowardSurface`, or move the same reattach test into an environment where the full process can stay alive past the current sandbox limits. Only after that stall is characterized can the bot reliably hand off from this resumed shaft into surface food buffering and the iron/diamond path again.

## Iteration 26 - Near-surface shaft traps now hit an immediate pillar fast path

- Screenshot checkpoints:
  - `runtime/minecraft-observation/minecraft-window-20260419-160536.png`
  - `runtime/minecraft-observation/minecraft-window-20260419-161040.png`
- Observation:
  The fresh focused captures still show the live client in a dark enclosed shaft with a stone pickaxe equipped, furnace/crafting bootstrap items on hotbar, and no armor or food visible. The first post-patch compiled reattach exposed a runtime-mirror drift instead of a gameplay result: `services/minecraft/runtime/manual-compiled-soak/20260419-160608/minecraft-bot.stdout.log` failed immediately inside `recoverTowardSurface` because the compiled mirror was missing the new `looksLikeVerticalEscapeTrap` / `surface-recovery.js` wiring. After syncing the mirror, the next compiled foreground soak at `services/minecraft/runtime/manual-compiled-soak/20260419-160939/minecraft-bot.stdout.log` no longer stalled opaquely. It logged `Trying immediate shaft-trap pillar recovery before deeper surface scanning`, then stopped that pillar attempt because the head block at `(-457, 65, 211)` resolved as `unknown`, and then continued into the newly added cue/exit scan logs.
- Hypothesis:
  The current live blocker is no longer an unexplained deep `escapeTowardSurface` hang. Near-surface shaft traps need the generic scaffold pillar escape to run before expensive cue/exit scanning, but that path also needs more robust headroom reads so transient bridge `unknown` responses do not get treated like confirmed hazards.
- Changes:
  Updated `services/minecraft/src/runner/phases.ts` so near-surface `shaft_trap` states now attempt `tryPillarSurfaceEscape(...)` immediately before deeper cue/exit scanning, and added stage logs for cue scan, nearby exit scan, and current-column exit scan.
  Added a focused regression in `services/minecraft/src/runner/phases.test.ts` covering the new near-surface fast path.
  Synced the live compiled runtime mirror:
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/runner/phases.js`
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/utils/surface-recovery.js`
- Validation:
  - `node_modules\.bin\eslint.CMD --fix services/minecraft/src/runner/phases.ts services/minecraft/src/runner/phases.test.ts`
  - `node_modules\.bin\tsc.CMD -p services/minecraft/tsconfig.json --noEmit`
  - `node --check services/minecraft/runtime/compiled-run-20260418-2040/src/runner/phases.js`
  - `node --check services/minecraft/runtime/compiled-run-20260418-2040/src/utils/surface-recovery.js`
  - `node_modules\.bin\vitest.CMD run services/minecraft/src/runner/phases.test.ts` is still blocked here because Vite/esbuild startup hits `spawn EPERM`.
  - Live compiled reattachs:
    - `services/minecraft/runtime/manual-compiled-soak/20260419-160608`
    - `services/minecraft/runtime/manual-compiled-soak/20260419-160939`
- Result:
  The live shaft-recovery path is now observable again. The runner immediately enters the intended shaft-trap fast path and reports why it refuses to pillar, instead of disappearing into a silent stall. In the current resumed save, the blocker is specifically `head=unknown` in the pillar safety gate, not an unlocalized recovery hang.
- Next hypothesis:
  The next patch should make near-surface pillar headroom reads resilient to transient `unknown` bridge results, likely by retrying/cross-checking the current column before treating `unknown` as unsafe. Once that is stable, the same fast path should be able to convert the current enclosed shaft state into real upward progress before the food and iron handoff.

## Iteration 27 - Structured tool crafting now reserves shared ingredients correctly

- Screenshot checkpoints:
  - `runtime/minecraft-observation/minecraft-window-20260419-172046.png`
  - `runtime/minecraft-observation/minecraft-window-20260419-172227.png`
  - `runtime/minecraft-observation/minecraft-window-20260419-172807.png`
- Observation:
  The first fresh focused capture at `runtime/minecraft-observation/minecraft-window-20260419-172046.png` showed the live client back on the surface at dusk with full health/food, confirming the earlier underground shaft trap is no longer the immediate resumed-world blocker. A short compiled reattach at `services/minecraft/runtime/manual-compiled-soak/20260419-172106/minecraft-bot.stdout.log` then exposed the next concrete autonomy bug: the structured `Craft a wooden pickaxe` fast path could reach `crafting_table + stick + oak_planks`, but it still failed inventory preflight for `wooden_pickaxe` because the planner shadow counted the same plank pool once for direct pickaxe planks and again for stick crafting. After patching that reservation bug and re-syncing the compiled mirror, the next compiled soak at `services/minecraft/runtime/manual-compiled-soak/20260419-172645/minecraft-bot.stdout.log` live-verified `Craft a wooden pickaxe`; the final capture at `runtime/minecraft-observation/minecraft-window-20260419-172807.png` shows the wooden pickaxe equipped with `oak_log x61`, planks, sticks, and a crafting table still on hotbar.
- Hypothesis:
  The structured planner must reserve shared intermediate ingredients as soon as they are claimed by the parent recipe, otherwise tools that depend on both direct planks and derived sticks undercount their real wood budget and stall before stone progression. Once that bootstrap is fixed, the next autonomous blocker is no longer wood/tool bootstrap; it is food acquisition from the surfaced save, where nearby salmon are visible but `searchForEntity(animal)` still ends in `search_target_not_locked` and `attack(animal)` can stall with no combat progress.
- Changes:
  Updated `services/minecraft/src/agents/planning/index.ts` so structured recipe expansion now consumes each ensured ingredient immediately inside the parent craft-resolution pass, which prevents sibling ingredients from double-spending the same shadow resources.
  Adjusted the structured-plan step appender so repeated `craftRecipe` / `collectBlocks` steps can remain explicit when the same action or recipe must run more than once, while duplicate `searchForBlock` steps still collapse to the widest search range.
  Added a focused regression in `services/minecraft/src/agents/planning/index.test.ts` covering the surfaced `crafting_table -> wooden_pickaxe` case, asserting the planner now budgets two logs / two plank crafts instead of one.
  Synced the live compiled runtime mirror:
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/agents/planning/index.js`
- Validation:
  - `node_modules\.bin\eslint.CMD --fix services/minecraft/src/agents/planning/index.ts services/minecraft/src/agents/planning/index.test.ts`
  - `node_modules\.bin\tsc.CMD -p services/minecraft/tsconfig.json --noEmit`
  - `node --check services/minecraft/runtime/compiled-run-20260418-2040/src/agents/planning/index.js`
  - `node_modules\.bin\vitest.CMD run services/minecraft/src/agents/planning/index.test.ts` is still blocked here because Vite/esbuild startup hits `spawn EPERM`.
  - `pnpm -F @proj-airi/minecraft-bot typecheck` and `pnpm lint:fix` are still blocked in this sandbox by corepack `EPERM` under `%LOCALAPPDATA%\node\corepack\v1\pnpm`.
  - Live compiled reattachs:
    - `services/minecraft/runtime/manual-compiled-soak/20260419-172106`
    - `services/minecraft/runtime/manual-compiled-soak/20260419-172645`
- Result:
  The autonomy stack now gets past the surfaced wood bootstrap again: `crafting_table` and then `wooden_pickaxe` are both live-verified from the current resumed save, and the screenshot truth now matches the runtime logs closely enough to trust this checkpoint. The next blocker has moved forward into surface food acquisition rather than underground escape or wooden-tool bootstrap.
- Next hypothesis:
  The next patch should focus on the surfaced `Collect nearby food` handoff. The current live evidence shows nearby salmon recognized in canonical observations, but `searchForEntity(animal)` still fails to lock onto them and `attack(animal)` can stall without combat progress. That likely needs fish-specific target-lock/combat reach handling or a surface food fallback that prefers easier non-aquatic food when the only visible animals are in water.

## Iteration 28 - Localized food-target snapshots and aquatic pursuit no longer dead-end the food branch

- Screenshot checkpoints:
  - `runtime/minecraft-observation/minecraft-window-20260419-180429.png`
  - `runtime/minecraft-observation/minecraft-window-20260419-181152.png`
- Observation:
  The new focused capture at `runtime/minecraft-observation/minecraft-window-20260419-180429.png` showed the resumed live client back on the rainy coast with an empty hotbar and no visible tools, not the earlier `wooden_pickaxe + oak_log` checkpoint. A fresh compiled foreground reattach at `services/minecraft/runtime/manual-compiled-soak/20260419-181016/minecraft-bot.stdout.log` confirmed the same reset-like coastal state: empty inventory, nearby `cod`, and a first autonomy goal of `Craft a crafting table`. The first verified action snapshot in that soak now records nearby fish as both localized names (`タラ`) and canonical types (`minecraft:cod`), which is exactly the observation gap that previously caused generic `searchForEntity(animal)` verification to false-fail under localized fish-only scenes.
- Hypothesis:
  The food branch had two generic reliability bugs that needed to be removed before longer bootstrap or diamond loops could trust coastal recovery:
  1. Action verification only stored `entity.name || entity.type`, so Japanese fish names erased the canonical type and generic `animal` searches could fail verification even while food targets were visible.
  2. Generic `attack(animal)` always took the nearest match and then relied on bare `pvp.attack`, which makes coastal fish hunts disproportionately fragile when the nearest visible food is in water.
- Changes:
  Updated `services/minecraft/src/agents/action/index.ts` so action snapshots now retain both localized nearby entity names and canonical types, and `searchForEntity` verification now uses `matchesEntityQuery(...)` against those expanded observations instead of string-includes against the literal query token.
  Added a focused regression in `services/minecraft/src/agents/action/index.test.ts` covering the exact live failure class: generic `animal` search verification now passes when the visible target is a localized `サケ` with canonical type `minecraft:salmon`.

  Updated `services/minecraft/src/skills/combat.ts` so generic `attackNearest('animal')` prefers nearby non-aquatic prey before fish when both are visible, and aquatic food targets (`cod`, `salmon`, `tropical_fish`) now get a short swim-aware pursuit path plus direct swing retries instead of relying only on the default PvP chase loop.
  Added focused regressions in `services/minecraft/src/skills/combat.test.ts` for both behaviors:
  - generic `animal` attack prefers rabbit over a nearer salmon,
  - direct aquatic fish attacks now request swim-mode pursuit before landing the kill.

  Synced the live compiled runtime mirror:
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/agents/action/index.js`
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/skills/combat.js`
- Validation:
  - `node_modules\.bin\eslint.CMD --fix services/minecraft/src/agents/action/index.ts services/minecraft/src/agents/action/index.test.ts services/minecraft/src/skills/combat.ts services/minecraft/src/skills/combat.test.ts`
  - `node_modules\.bin\tsc.CMD -p services/minecraft/tsconfig.json --noEmit`
  - `node --check services/minecraft/runtime/compiled-run-20260418-2040/src/agents/action/index.js`
  - `node --check services/minecraft/runtime/compiled-run-20260418-2040/src/skills/combat.js`
  - `node_modules\.bin\vitest.CMD run services/minecraft/src/agents/action/index.test.ts services/minecraft/src/skills/combat.test.ts` is still blocked here because Vite/esbuild startup hits `spawn EPERM`.
  - Live compiled foreground reattach:
    - `services/minecraft/runtime/manual-compiled-soak/20260419-181016`
    - confirmed the snapshot-side fix in runtime logs: nearby fish now appear as both localized and canonical entity observations (`タラ`, `minecraft:cod`) during action verification.
- Result:
  The generic food branch is mechanically less brittle now. Localized fish-only scenes no longer erase the canonical entity type during action verification, and generic food combat has a non-scripted path that either prefers easier land prey first or explicitly switches into swim-mode pursuit when fish are the only visible food targets. The current live save did not reach the later `Collect nearby food` branch inside the foreground soak because it spent the entire window rebuilding from an empty coastal inventory and failing the first elevated log approach.
- Next hypothesis:
  The next practical blocker has moved again: keep the current empty coastal restart from burning the whole foreground soak on the first shoreline tree/log path before it can rebuild `crafting_table -> food buffer -> stone`. Once that bootstrap is stable again, re-run the same coast state to live-confirm the new fish search/attack path instead of only verifying it in unit tests and snapshot logs.

## Iteration 29 - Wood search now approaches trunk bases instead of branch/canopy coordinates

- Screenshot checkpoints:
  - `runtime/minecraft-observation/minecraft-window-20260419-190153.png`
  - `runtime/minecraft-observation/minecraft-window-20260419-190808.png`
  - `runtime/minecraft-observation/minecraft-window-20260419-190827.png`
- Observation:
  The fresh focused capture at `runtime/minecraft-observation/minecraft-window-20260419-190153.png` still showed the live client tangled in leaves with `oak_log x14`, low health, and the camera pointed into a tree canopy, which matched the outstanding suspicion that the coastal wood bootstrap was pathing to branch hits instead of a stable trunk break position. In the previous problematic surfaced soak (`services/minecraft/runtime/manual-compiled-soak/20260419-172106/minecraft-bot.stdout.log`), `searchForBlock(log)` had already shown the same pattern by pathfinding to a detected high log coordinate. After patching the search path, the new compiled foreground reattach at `services/minecraft/runtime/manual-compiled-soak/20260419-190750/minecraft-bot.stdout.log` showed the corrected behavior live: the later `searchForBlock(log)` step pathfound to `(-316, 64, 359), range=2` from a surface position instead of climbing to a canopy Y target, and the paired screenshot `runtime/minecraft-observation/minecraft-window-20260419-190808.png` shows the bot still in surface foliage with full health rather than marooned in a high branch/fall-damage state. The same soak then continued through `crafting_table` placement and verified `wooden_pickaxe x1`; `runtime/minecraft-observation/minecraft-window-20260419-190827.png` captures that crafting-table stage directly.
- Hypothesis:
  The coastal/bootstrap stall was partly self-inflicted before any digging started: generic `searchForBlock(log)` reused the broad nearest-block search and could path directly to a canopy observation, which raised the bot into unstable foliage and wasted the narrow live test window before `collectBlocks(log)` even had a chance to run. Wood search needs to share the same trunk-resolution logic that `gatherWood` already uses for collection, or the action planner keeps feeding later bootstrap steps from a bad spatial anchor.
- Changes:
  Updated `services/minecraft/src/skills/actions/gather-wood.ts` to factor shared wood-candidate selection into `getWoodRecoveryCandidates(...)` and export `approachNearestWoodTarget(...)`, which resolves branch hits onto a nearby trunk base / breakable column before moving.
  Added a focused regression in `services/minecraft/src/skills/actions/gather-wood.test.ts` that starts from a canopy-only hit and now asserts the approach lands on the trunk base instead of the canopy coordinate.

  Updated `services/minecraft/src/agents/action/tools.ts` so `searchForBlock(log)` and other wood-like block searches now route through `approachNearestWoodTarget(...)` instead of the generic nearest-block path.
  Added the matching focused regression in `services/minecraft/src/agents/action/tools.test.ts`.

  Synced the live compiled runtime mirror:
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/skills/actions/gather-wood.js`
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/agents/action/tools.js`
- Validation:
  - `node_modules\.bin\eslint.CMD --fix services/minecraft/src/skills/actions/gather-wood.ts services/minecraft/src/skills/actions/gather-wood.test.ts services/minecraft/src/agents/action/tools.ts services/minecraft/src/agents/action/tools.test.ts`
  - `node_modules\.bin\tsc.CMD -p services/minecraft/tsconfig.json --noEmit`
  - `node --check services/minecraft/runtime/compiled-run-20260418-2040/src/skills/actions/gather-wood.js`
  - `node --check services/minecraft/runtime/compiled-run-20260418-2040/src/agents/action/tools.js`
  - `node_modules\.bin\vitest.CMD run services/minecraft/src/skills/actions/gather-wood.test.ts services/minecraft/src/agents/action/tools.test.ts` is still blocked here because Vite/esbuild startup hits `spawn EPERM`.
  - `pnpm -F @proj-airi/minecraft-bot typecheck` and `pnpm lint:fix` are still blocked in this sandbox by corepack `EPERM` under `%LOCALAPPDATA%\node\corepack\v1\pnpm`.
  - Live compiled foreground reattach:
    - `services/minecraft/runtime/manual-compiled-soak/20260419-190750`
- Result:
  The first shoreline/tree bootstrap is materially less brittle now. In the latest live compiled soak, `searchForBlock(log)` no longer climbed toward a canopy coordinate; it approached a ground-level trunk break position, stayed healthy in the foliage screenshot checkpoint, and the same short window still progressed all the way through `crafting_table` placement to a verified `wooden_pickaxe x1`. That removes the previously dominant `first log search climbs the tree and burns the soak` failure class from the critical path.
- Next hypothesis:
  The next blocker has shifted from raw wood-search pathing to state/objective continuity after the improved bootstrap. The same `20260419-190750` soak still opened with a stale rule-based `Escape to the surface to gather wood` goal even though the bot was already on the surface with `oak_log x82`, and it still has not carried the now-stable `wooden_pickaxe` state into a reliable `food + sword + stone` buffer. The next patch should therefore tighten surfaced-state classification / objective selection so the bot stops wasting a recovery cycle on already-surfaced wood-rich saves and moves directly into survival supply prep.

## Iteration 30 - Surface bootstrap now prefers stone progress and skips canopy-only ascent traps

- Screenshot checkpoints:
  - `runtime/minecraft-observation/minecraft-window-20260419-200201.png`
  - `runtime/minecraft-observation/minecraft-window-20260419-201355.png`
- Observation:
  Fresh focused captures were taken again during this run to keep a visual checkpoint for the resumed Minecraft tab, but the more reliable state truth came from the new compiled foreground reattachs. The first reattach at `services/minecraft/runtime/manual-compiled-soak/20260419-201218/minecraft-bot.stdout.log` resumed from an empty/danger surface bootstrap instead of the earlier wood-rich checkpoint and, importantly, no longer reopened `Escape to the surface to gather wood` or `Organize inventory...`; it selected `Craft a crafting table` and then `Craft a wooden pickaxe`. That means the stale surfaced-recovery / cleanup churn is no longer dominating the bootstrap path when local progress is possible. The next reattach at `services/minecraft/runtime/manual-compiled-soak/20260419-201402/minecraft-bot.stdout.log` narrowed the remaining stall further: once the bot tried to recover wood for the wooden-pickaxe plan, `gatherWood` still bounced among elevated canopy-only candidates and retried local vertical ascent. After adding a skip guard, the next live reattach at `services/minecraft/runtime/manual-compiled-soak/20260419-201728/minecraft-bot.stdout.log` repeatedly logged `Skipping unresolved elevated wood candidate after horizontal approach`, proving that the old exact-Y canopy climb loop is now being cut short in the live runtime even though this specific coastal terrain still did not yield a reachable trunk inside the short soak window.
- Hypothesis:
  Three generic bootstrap issues were still obscuring real autonomous progression:
  1. Early surfaced bootstrap still allowed bridge-limited inventory cleanup to compete with stone-tier progression even when the next real milestone should be `cobblestone -> stone_pickaxe`.
  2. Stale surface-recovery rewrite logic could still replace the active bootstrap goal even when local facts already showed that wood/crafting/pickaxe progress was possible on-site.
  3. Wood gathering still treated some canopy-only detections as valid local ascent targets after horizontal approach, which wasted the short live reattach window on unrecoverable Y climbs.
- Changes:
  Updated `services/minecraft/src/autonomy/objectives.ts` to add `shouldDelayInventoryCleanupForBootstrap(...)`, lower cleanup urgency during early bootstrap, and explicitly propose `Mine 16 cobblestone` plus `Craft a stone pickaxe` once the surfaced bootstrap reaches wooden tools.
  Added focused regressions in `services/minecraft/src/autonomy/objectives.test.ts` and `services/minecraft/src/autonomy/decision-provider.rule-based.test.ts` asserting that a surfaced wooden-pickaxe state prefers stone bootstrap over inventory cleanup.

  Updated `services/minecraft/src/autonomy/orchestrator.ts` so mechanical replacement goals now pass current facts into `shouldOverrideToSurfaceRecovery(...)`, and that override now refuses to reopen surface recovery when local bootstrap inventory already provides wood, crafting access, or an existing pickaxe.
  Added the matching regression in `services/minecraft/src/autonomy/orchestrator.goal-recovery.test.ts`.

  Updated `services/minecraft/src/skills/actions/gather-wood.ts` so `moveIntoWoodColumnRange(...)` skips a still-unresolved single elevated log candidate when it remains more than four blocks above the current Y after horizontal approach, instead of forcing another exact vertical ascent attempt.
  Added the matching regression in `services/minecraft/src/skills/actions/gather-wood.test.ts`.

  Synced the live compiled runtime mirror:
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/autonomy/objectives.js`
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/autonomy/orchestrator.js`
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/skills/actions/gather-wood.js`
- Validation:
  - `node_modules\.bin\eslint.CMD --fix services/minecraft/src/autonomy/objectives.ts services/minecraft/src/autonomy/objectives.test.ts services/minecraft/src/autonomy/decision-provider.rule-based.test.ts services/minecraft/src/autonomy/orchestrator.ts services/minecraft/src/autonomy/orchestrator.goal-recovery.test.ts services/minecraft/src/skills/actions/gather-wood.ts services/minecraft/src/skills/actions/gather-wood.test.ts`
  - `node_modules\.bin\tsc.CMD -p services/minecraft/tsconfig.json --noEmit`
  - `node --check services/minecraft/runtime/compiled-run-20260418-2040/src/autonomy/objectives.js`
  - `node --check services/minecraft/runtime/compiled-run-20260418-2040/src/autonomy/orchestrator.js`
  - `node --check services/minecraft/runtime/compiled-run-20260418-2040/src/skills/actions/gather-wood.js`
  - `node_modules\.bin\vitest.CMD run services/minecraft/src/autonomy/objectives.test.ts services/minecraft/src/autonomy/decision-provider.rule-based.test.ts services/minecraft/src/autonomy/orchestrator.goal-recovery.test.ts services/minecraft/src/skills/actions/gather-wood.test.ts` is still blocked here because Vite/esbuild startup hits `spawn EPERM`.
  - Live compiled reattachs:
    - `services/minecraft/runtime/manual-compiled-soak/20260419-201218`
    - `services/minecraft/runtime/manual-compiled-soak/20260419-201402`
    - `services/minecraft/runtime/manual-compiled-soak/20260419-201728`
- Result:
  The autonomy stack is past the previous surfaced objective churn. In the current resumed save, local bootstrap can continue directly into `crafting_table -> wooden_pickaxe`, and the live runtime now refuses the old canopy-only vertical ascent loop instead of burning the whole foreground soak on the same unreachable log column. The remaining blocker is more specific: the current coastal terrain still feeds too many elevated canopy-only candidates, so the new skip behavior avoids the old trap but does not yet convert the search into a fast reachable-trunk acquisition and the later `cobblestone -> stone_pickaxe -> food/sword` handoff.
- Next hypothesis:
  The next patch should turn repeated canopy skips into a broader wood-target diversification strategy: widen relocation after consecutive elevated skips, down-rank single high-canopy hits in favor of low-Y trunks, and preserve enough local state to hand off from the first reachable log directly into the new stone-tier objectives.

## Iteration 31 - Canopy-heavy wood scans now retry distinct tree candidates before revisiting the same canopy patch

- Screenshot checkpoints:
  - `runtime/minecraft-observation/minecraft-window-20260419-210839.png`
  - `runtime/minecraft-observation/minecraft-window-20260419-210942.png`
  - `runtime/minecraft-observation/minecraft-window-20260419-211017.png`
- Observation:
  The next live check started from a stale-but-dead instance lock rather than a healthy running bot: `%LOCALAPPDATA%\Temp\airi-minecraft-locks\port-55844.lock` still pointed at pid `26304`, but the process was gone and the monitor dashboard was not listening on `127.0.0.1:3002`. A fresh compiled reattach at `services/minecraft/runtime/manual-compiled-soak/20260419-210921/minecraft-bot.stdout.log` auto-reclaimed that stale lock and resumed the same coastal `Craft a wooden pickaxe` bootstrap. The old critical smell was still visible in the historical logs from `...201728`: the bot burned multiple retries on near-duplicate canopy targets (`(-321, 73, 138)` / `(-322, 74, 140)` and later `(-297, 73, 188)` / `(-296, 73, 189)`). After the new scan patch, the fresh live run still skipped two elevated candidates, but it only hit one representative per canopy cluster (`(-297, 73, 188)` then `(-321, 73, 138)`) before widening to a third target `(-324, 64, 178)` and entering a new vertical approach instead of immediately revisiting the previous canopy pair.
- Hypothesis:
  The previous skip guard removed the exact-Y canopy ascent loop, but it still let the wood search waste retries on multiple observations from the same tree. The next autonomy gain needed to happen earlier in candidate selection: collapse dense canopy observations into distinct tree retries, widen the scan when the first query budget only sees a few unique trees, and avoid revisiting the same resolved tree base within one gather/search pass. That keeps the action space LLM-driven while improving the observation-to-action substrate the model depends on.
- Changes:
  Updated `services/minecraft/src/skills/actions/gather-wood.ts` so wood search now:
  - clusters nearby raw wood observations into distinct tree candidates before ranking them,
  - expands the block scan from `24` to `64` observations when the initial result collapses into too few distinct trees,
  - and tracks failed retries by resolved tree base rather than raw canopy hit, which prevents one gather/search pass from rewalking the same tree through slightly different branch coordinates.

  Added a focused regression in `services/minecraft/src/skills/actions/gather-wood.test.ts` that feeds 24 near-duplicate canopy hits plus a farther ground-level tree and now asserts the runtime expands the scan, touches the canopy cluster once, and then reaches the distinct ground target instead of retrying the same canopy patch repeatedly.

  Synced the live compiled runtime mirror:
  - `services/minecraft/runtime/compiled-run-20260418-2040/src/skills/actions/gather-wood.js`
- Validation:
  - `node_modules\.bin\eslint.CMD --fix services/minecraft/src/skills/actions/gather-wood.ts services/minecraft/src/skills/actions/gather-wood.test.ts`
  - `node_modules\.bin\tsc.CMD -p services/minecraft/tsconfig.json --noEmit`
  - `node --check services/minecraft/runtime/compiled-run-20260418-2040/src/skills/actions/gather-wood.js`
  - `node_modules\.bin\vitest.CMD run services/minecraft/src/skills/actions/gather-wood.test.ts` is still blocked here because Vite/esbuild startup hits `spawn EPERM`.
  - Live compiled foreground reattach:
    - `services/minecraft/runtime/manual-compiled-soak/20260419-210921`
    - auto-reclaimed the stale lock from the dead prior process, reattached successfully, and showed the new relocation pattern in runtime logs.
- Result:
  The coastal wood bootstrap still has not reached a confirmed reachable trunk in this terrain, so the end-to-end `wood -> stone -> food/sword` chain is not live-green yet. But the search substrate is materially better: the fresh run stopped revisiting near-duplicate canopy coordinates from the same tree cluster and widened into a third distinct candidate in the same short window. That moves the blocker forward from “same tree retried via slightly different canopy hits” to the narrower problem of turning the broadened tree diversification into an actual reachable trunk.
- Next hypothesis:
  Keep the new distinct-tree search substrate, then bias the next patch toward the first candidate that combines low base Y, breakable nearby footing, and a short post-relocation vertical step. Once that turns into one live reachable trunk, the autonomy stack should be able to resume the already-fixed stone-tier objectives and push toward the later `food + sword + iron + diamond` path.

## 2026-07-10 - Official OpenAI token budget guard

- Added official-OpenAI-only accounting for Neuri routing, gameplay planning, autonomy decisions, and public speech.
- Added persisted UTC usage, conservative missing-usage estimation (including non-success responses), allowlist enforcement, monitor thresholds, and graceful exit code 78 after stopping pathfinding/execution/autonomy at the soft stop.
- Response accounting now records an already-arrived official OpenAI response before rejecting its use, including when another in-flight response has already triggered the soft stop.
- Removed the orchestrator's `RuleBasedAutonomyDecisionProvider` fallback path. LLM failure now emits an error and returns a no-op intent so goal selection is skipped instead of simulating continued autonomous play.
- Startup and the in-process restart scheduler now both refuse to relaunch while the persisted current-UTC-day state is blocked.
- No Minecraft screenshot was taken because this change is transport/process safety and visual state did not affect the implementation hypothesis.

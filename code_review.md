# code_review

## Hardcode Audit

- [x] No fixed `wood -> stone -> iron -> diamond` production fallback script remains in the autonomy decision path of `decision-provider.ts`.
- [x] No fixed coordinates or seed-specific behaviors were added.
- [x] No single house blueprint is required to satisfy base/home logic.
- [x] No benchmark-only branch leaked into the production runtime path.

## Retry / Recovery Audit

- [x] Same unsupported bridge capability is not retried blindly in one session.
- [x] Same blocked step is suppressed until world/capability state changes.
- [x] Deterministic recovery is chosen within one loop after stall detection.
- [x] Underground cave-prep failure can now pivot into a canonical surface-recovery objective instead of repeating the same local underground food/combat loop.
- [x] Planner-backed autonomy can invoke the existing runner `recoverTowardSurface` routine directly instead of relying only on generic `moveAway` / `goToCoordinates` escape hops.
- [x] Enclosed shaft recovery now has a generic scaffold pillar fallback instead of relying only on pure higher-Y pathfinding in the same column.
- [x] Canonical world-state and objective prompts now surface `shaft_trap` plus scaffold readiness, so the LLM can choose recovery from the observed terrain rather than a generic underground label alone.
- [x] Direct surface-recovery fast paths now try observed surface cues (`grass_block`, relocation) before blind higher-Y coordinate climbs, reducing wasted stall time in live runs.
- [x] Structured planner surface recovery now also probes nearby surface-facing cues before `recoverTowardSurface`, so the live runtime can take the short `searchForBlock -> moveAway` handoff without waiting for a 90s recovery timeout first.
- [x] Fabric bridge startup no longer hard-fails just because the bridge websocket is late during initial attach or because the daemon cannot introspect an already-open gameplay window well enough to relaunch it safely.
- [x] Live daemon startup now degrades through `Win32_Process` access denial and bypasses corepack/pnpm so the remaining failure is the outer child-process sandbox boundary rather than launcher preflight logic.
- [x] Diamond-path gating now depends on real `pickaxeTier` facts instead of generic combat-tier false positives.
- [x] Short bursts of empty Fabric bridge inventory snapshots now preserve the last visible inventory instead of immediately erasing tool/food context.
- [x] A short bot restart no longer has to start from an empty bridge inventory if the runtime already saw a recent visible inventory snapshot; the bridge proxy now persists and reloads that resume state, and it clears it on death.
- [x] Deterministic food recovery no longer assumes land animals only; fish now count as generic food animals in the current coastal/bootstrap state.
- [ ] Recovery is verified by stable inventory/progress deltas instead of narration or stale bridge/screenshot disagreements.
- [x] Bridge-limited inventory cleanup no longer preempts missing crafting-table / pickaxe bootstrap, and `quick-loot` cleanup goals no longer trip item-verification through the generic `loot` gather keyword.
- [x] Surface bootstrap no longer rewrites back into `Escape to the surface to gather wood` when local wood / crafting / pickaxe facts already make on-site recovery possible.
- [x] Early surfaced bootstrap now keeps `cobblestone -> stone_pickaxe` ahead of generic inventory cleanup instead of letting cleanup urgency hijack the next real progression step.
- [x] Crafted-goal verification no longer depends only on raw inventory snapshots; it cross-checks canonical inventory, held/equipped state, nearby crafting access, and recent craft-sync mismatch diagnostics before requeueing the same crafted target.
- [x] Low-torch states with `furnace + logs + no coal` no longer fall back to a generic fuel-gather wording that bypasses the structured smelt path; the objective layer now keeps the planner on a reusable charcoal goal.
- [x] Furnace/block activation no longer relies on a hardcoded top-face hit, and `smeltItem` no longer aborts on the first transient furnace-open miss; the runtime now retries from closer interaction range with refreshed furnace targets.
- [x] Underground `Collect nearby food` recovery no longer starts with blind animal search when a visible surface cue plus enclosed terrain already show that the bot should break out first; planner fast paths and recovery now retarget into surface escape before resuming food search.
- [x] Nearby surface-cue contact no longer immediately throws away gained altitude through `moveAway`; the runner now attempts an exact cue-top ascent first and only reorients when the cue route produced no meaningful rise.
- [x] Fabric bridge block lookup and initial `goto` dispatch no longer force `recoverTowardSurface` to inherit default 30-120 second waits; stalled block queries are skipped, confined-shaft walks reuse the underground timeout budget, and the first `goto`/`gotoNear` request now honors the caller's goal timeout.
- [x] Near-surface `shaft_trap` states now attempt scaffold pillar escape before deeper cue/exit scanning, and `recoverTowardSurface` emits explicit cue/exit stage logs so live failures reduce to concrete terrain-read blockers instead of an opaque hang.
- [x] Structured recipe planning now reserves each ensured ingredient immediately inside the parent recipe pass, so shared inputs like planks cannot be double-spent once for direct tool ingredients and again through derived sticks.
- [x] Action verification snapshots now retain both localized nearby entity names and canonical types, so generic `searchForEntity(animal)` verification no longer fails just because the live scene only surfaced localized fish labels.
- [x] Generic food combat now prefers easier land prey before water prey and adds a short swim-aware pursuit path for fish, instead of relying only on the default PvP chase loop in coastal recovery states.
- [x] `searchForBlock(log)` no longer paths straight to canopy observations; wood-like searches now reuse trunk-aware targeting and approach a ground-level break position before the later collection step starts.
- [x] Search-phase wood targeting no longer insists on exact canopy Y alignment once the bot has horizontal contact with the chosen tree candidate; `searchForBlock(log)` can now verify and hand off into collection from that state.
- [x] Wood gathering no longer force-climbs a still-unresolved single canopy log after horizontal approach; unreachable elevated candidates are skipped so the runtime can keep searching for reachable wood instead of repeating the same ascent trap.
- [x] Wood candidate generation now collapses dense canopy observations into distinct tree retries and avoids revisiting the same resolved tree base within one gather pass, so coastal retries widen across the scene instead of rewalking near-duplicate canopy hits.
- [x] Wood collection now attempts the trunk-aware/manual break path before generic `baritone mine(log)` recovery, so the search-phase canopy fix is not immediately undone by a premature mining fallback.
- [x] Generic ensure-managed craft requests such as `craftRecipe(sword)` no longer fail inventory preflight with `ingredient_missing`; the action is allowed through to `ensureSword()` / `ensure*()` resolution.
- [x] `Collect nearby food` no longer automatically classifies a tree-covered surface scene as underground escape context; a nearby sky window through natural canopy now suppresses the `recoverTowardSurface` fast path until live evidence says otherwise.
- [x] Generic temporary-shelter fallback no longer assumes `cobblestone`; when the goal text leaves material unspecified, planner fallback now chooses from currently held `dirt`, planks, logs, or cobble-like blocks.
- [x] Death signals now clear bridge inventory, armor/offhand, canonical inventory, and persisted resume state so recovery cannot reason from stale pre-death gear.
- [x] `recoverTowardSurface` no longer fails action verification when the bot is already on the surface; the no-op success path is explicit in runner and action verification.
- [x] Wood search now has a wood-specific defer result for unresolved unsafe canopy observations, and verification only accepts that explicit defer for wood targets instead of weakening generic `searchForBlock`.
- [x] Wood recovery candidate ranking keeps farther recovery-range ground trees after skipping nearer canopy hits, preventing a single local elevated cluster from excluding safer trunks.
- [x] Species-specific wood collection now stops only after the requested wood type reaches the target count, not after unrelated logs satisfy a generic count.
- [x] Explicit Japanese wood/log acquisition requests are verified as resource acquisition instead of being satisfied by downstream craft outcomes.
- [x] Furnace placement now requires post-place block or inventory evidence before recent-placement cache can satisfy later smelting recovery.
- [x] Mining goals now fail early when hunger is depleted and no recovery food is buffered, preventing stone/iron pushes from continuing at `food <= 8`.

## Inference / VRAM Audit

- [x] No extra heavy inference lane, embedding worker, reranker, vector DB, or summarizer was added.
- [x] Action/recovery still outrank planning/narration/TTS under single-lane scheduling.
- [x] Prompt additions are compact structured facts, not raw slot dumps or long recent speech dumps.

## Inventory / Equip Audit

- [x] Shield is treated as preferred offhand gear instead of crowding the primary weapon slot.
- [x] Sword remains the immediate primary-weapon hotbar target when both sword and shield exist.
- [x] Attack preflight no longer misclassifies `pickaxe` as a valid `axe` weapon.
- [x] Attack inventory preflight now matches the executor's real melee fallback set, so no-sword food hunts can proceed with `pickaxe` / `shovel` instead of failing early with `ingredient_missing`.
- [x] Live inventory-pressure churn no longer deadlocks on unsupported slot management or a lost `compactInventory` bridge-method binding.
- [x] Default plank bootstrap no longer assumes oak-only outputs when another visible log family can satisfy the same progression step.
- [x] Focused Minecraft window capture can now bypass stale `PrintWindow` frames via `-PreferScreenCopy`, although bridge/visual mismatch is still not fully resolved.
- [x] Remote walk fallback now aborts no-progress jitter loops instead of waiting indefinitely on wall-contact movement noise, so planner/action recovery can continue.
- [x] BotProxy held-item state now derives from the canonical selected raw hotbar slot instead of stale tracked inventory cache or raw armor-slot fallback matches.
- [x] Block placement now refuses to continue when equip leaves the hand on a different item, preventing dirt/cobble placements from being reported as the requested furnace/table block.

## Iteration Notes

- Current focus:
  Extend the May 10 live-verified `stone_pickaxe + furnace + torches + logs` checkpoint into reliable `food buffer -> safe iron -> iron pickaxe -> diamonds` progression while bridge/runtime telemetry stays primary truth. The latest restart proved the wrong-hand furnace placement is no longer accepted and completed charcoal/torch crafting through a real furnace, then exposed a low-hunger regression where the bot returned underground for iron at `food=6`. The next concrete need is live validation that depleted hunger now redirects mining goals to food/surface recovery before longer iron/diamond soaks.

## 2026-07-10 - OpenAI budget safety review

- Official `api.openai.com` paths assert the model allowlist before transport and record successful and non-success responses, including each Neuri/XSAI tool-call round trip. Missing usage is conservatively estimated from request/response characters.
- Post-response accounting records consumption before reasserting the budget, so late in-flight responses remain counted after the soft stop has already blocked new sends.
- Budget errors bypass planner, decision, and speech fallbacks. The orchestrator interrupts active execution, releases the shared plan lock, and requests graceful shutdown; `main.ts` suppresses restart and blocked-state startup before exit 78.
- The production orchestrator no longer owns or invokes a `RuleBasedAutonomyDecisionProvider`; ordinary LLM failures produce an explicit error plus a no-op intent that skips goal selection.
- Local Ollama and Gemini-native transports remain unmetered by design.

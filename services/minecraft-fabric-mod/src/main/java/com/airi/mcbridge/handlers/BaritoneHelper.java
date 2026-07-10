package com.airi.mcbridge.handlers;

import com.airi.mcbridge.AiriMcBridge;
import net.minecraft.entity.Entity;
import net.minecraft.util.math.BlockPos;
import net.minecraft.registry.Registries;
import net.minecraft.block.Block;
import net.minecraft.util.Identifier;

import java.util.ArrayList;
import java.util.List;

/**
 * Optional Baritone API wrapper.
 * All methods are safe to call even when Baritone is not installed —
 * they return false/null and never throw.
 */
public final class BaritoneHelper {
    private static Boolean cachedAvailable = null;

    private BaritoneHelper() {}

    // ─── Availability ────────────────────────────────────────────────────

    /**
     * Check whether the Baritone API is on the classpath (cached after first call).
     */
    public static boolean isAvailable() {
        if (cachedAvailable == null) {
            try {
                Class.forName("baritone.api.BaritoneAPI");
                cachedAvailable = true;
                AiriMcBridge.LOGGER.info("[AIRI] Baritone API detected");
            } catch (ClassNotFoundException e) {
                cachedAvailable = false;
                AiriMcBridge.LOGGER.info("[AIRI] Baritone API not found — pathfinding will use fallback");
            }
        }
        return cachedAvailable;
    }

    // ─── Internal helpers ────────────────────────────────────────────────

    private static Object getBaritone() throws Exception {
        Class<?> api = Class.forName("baritone.api.BaritoneAPI");
        Object provider = api.getMethod("getProvider").invoke(null);
        return provider.getClass().getMethod("getPrimaryBaritone").invoke(provider);
    }

    private static Object getCustomGoalProcess() throws Exception {
        Object baritone = getBaritone();
        return baritone.getClass().getMethod("getCustomGoalProcess").invoke(baritone);
    }

    private static Object getPathingBehavior() throws Exception {
        Object baritone = getBaritone();
        return baritone.getClass().getMethod("getPathingBehavior").invoke(baritone);
    }

    private static Object getMineProcess() throws Exception {
        Object baritone = getBaritone();
        return baritone.getClass().getMethod("getMineProcess").invoke(baritone);
    }

    private static Object getFollowProcess() throws Exception {
        Object baritone = getBaritone();
        return baritone.getClass().getMethod("getFollowProcess").invoke(baritone);
    }

    private static void setGoalAndPath(Object goal) throws Exception {
        Object process = getCustomGoalProcess();
        Class<?> goalInterface = Class.forName("baritone.api.pathing.goals.Goal");
        process.getClass().getMethod("setGoalAndPath", goalInterface).invoke(process, goal);
    }

    /**
     * Build a GoalNear instance across Baritone API variants.
     * Some releases expose GoalNear(BlockPos, int) instead of GoalNear(int, int, int, int).
     */
    private static Object createGoalNear(int x, int y, int z, int range) throws Exception {
        Class<?> goalNearClass = Class.forName("baritone.api.pathing.goals.GoalNear");

        try {
            return goalNearClass.getConstructor(int.class, int.class, int.class, int.class)
                    .newInstance(x, y, z, range);
        } catch (NoSuchMethodException ignored) {
            // NOTICE: Baritone 1.10.4 on Fabric 1.20.4 exposes GoalNear(BlockPos, int).
            // Keep the older ctor fallback so the bridge stays compatible with both layouts.
            return goalNearClass.getConstructor(BlockPos.class, int.class)
                    .newInstance(new BlockPos(x, y, z), range);
        }
    }

    // ─── Navigation ──────────────────────────────────────────────────────

    /**
     * Navigate to an exact block position.
     * @return true if Baritone accepted the goal
     */
    public static boolean gotoBlock(int x, int y, int z) {
        if (!isAvailable()) return false;
        try {
            Class<?> goalBlockClass = Class.forName("baritone.api.pathing.goals.GoalBlock");
            Object goal = goalBlockClass.getConstructor(int.class, int.class, int.class)
                    .newInstance(x, y, z);
            setGoalAndPath(goal);
            return true;
        } catch (Exception e) {
            AiriMcBridge.LOGGER.error("[AIRI] Baritone gotoBlock failed", e);
            return false;
        }
    }

    /**
     * Navigate to within {@code range} blocks of a position.
     * @return true if Baritone accepted the goal
     */
    public static boolean gotoNear(int x, int y, int z, int range) {
        if (!isAvailable()) return false;
        try {
            Object goal = createGoalNear(x, y, z, range);
            setGoalAndPath(goal);
            return true;
        } catch (Exception e) {
            AiriMcBridge.LOGGER.error("[AIRI] Baritone gotoNear failed", e);
            return false;
        }
    }

    /**
     * Mine specified block types automatically.
     * @param blockNames registry names like "diamond_ore", "oak_log"
     * @return true if mining started
     */
    public static boolean mine(List<String> blockNames) {
        if (!isAvailable()) return false;
        try {
            // Resolve block names to Block objects
            List<Block> blocks = new ArrayList<>();
            for (String name : blockNames) {
                Identifier id = name.contains(":")
                        ? Identifier.tryParse(name)
                        : Identifier.tryParse("minecraft:" + name);
                if (id != null) {
                    Block block = Registries.BLOCK.get(id);
                    if (block != null) {
                        blocks.add(block);
                    }
                }
            }

            if (blocks.isEmpty()) {
                AiriMcBridge.LOGGER.warn("[AIRI] Baritone mine: no valid blocks resolved from {}", blockNames);
                return false;
            }

            Object mineProcess = getMineProcess();
            // MineProcess.mine(int quantity, Block... blocks)
            // Use 0 for unlimited quantity
            Block[] blockArray = blocks.toArray(new Block[0]);
            mineProcess.getClass().getMethod("mine", int.class, Block[].class)
                    .invoke(mineProcess, 0, blockArray);
            return true;
        } catch (Exception e) {
            AiriMcBridge.LOGGER.error("[AIRI] Baritone mine failed", e);
            return false;
        }
    }

    /**
     * Follow a specific entity.
     * @return true if follow started
     */
    @SuppressWarnings("unchecked")
    public static boolean follow(Entity target) {
        if (!isAvailable()) return false;
        try {
            Object followProcess = getFollowProcess();
            // FollowProcess.follow(Predicate<Entity> filter)
            // We create a predicate that matches the exact entity
            java.util.function.Predicate<Entity> predicate = e -> e == target;
            followProcess.getClass().getMethod("follow", java.util.function.Predicate.class)
                    .invoke(followProcess, predicate);
            return true;
        } catch (Exception e) {
            AiriMcBridge.LOGGER.error("[AIRI] Baritone follow failed", e);
            return false;
        }
    }

    // ─── Control ─────────────────────────────────────────────────────────

    /**
     * Cancel all Baritone activity.
     * @return true if cancel succeeded
     */
    public static boolean stop() {
        if (!isAvailable()) return false;
        try {
            Object pathingBehavior = getPathingBehavior();
            pathingBehavior.getClass().getMethod("cancelEverything").invoke(pathingBehavior);
            return true;
        } catch (Exception e) {
            AiriMcBridge.LOGGER.error("[AIRI] Baritone stop failed", e);
            return false;
        }
    }

    /**
     * @return true if Baritone is currently calculating or executing a path
     */
    public static boolean isPathing() {
        if (!isAvailable()) return false;
        try {
            Object pathingBehavior = getPathingBehavior();
            return (boolean) pathingBehavior.getClass().getMethod("isPathing").invoke(pathingBehavior);
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * @return true if any Baritone process (goal/mine/follow) is active
     */
    public static boolean isActive() {
        if (!isAvailable()) return false;
        try {
            // Check CustomGoalProcess
            Object goalProcess = getCustomGoalProcess();
            boolean goalActive = (boolean) goalProcess.getClass().getMethod("isActive").invoke(goalProcess);
            if (goalActive) return true;

            // Check MineProcess
            Object mineProcess = getMineProcess();
            boolean mineActive = (boolean) mineProcess.getClass().getMethod("isActive").invoke(mineProcess);
            if (mineActive) return true;

            // Check FollowProcess
            Object followProcess = getFollowProcess();
            boolean followActive = (boolean) followProcess.getClass().getMethod("isActive").invoke(followProcess);
            return followActive;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Apply recommended Baritone settings for our use-case.
     * Called once after confirming availability.
     */
    public static void configureSettings() {
        if (!isAvailable()) return;
        try {
            Class<?> api = Class.forName("baritone.api.BaritoneAPI");
            Object settings = api.getMethod("getSettings").invoke(null);
            Class<?> settingsClass = settings.getClass();

            setBaritoneSettingBool(settings, settingsClass, "allowSprint", true);
            setBaritoneSettingBool(settings, settingsClass, "allowParkour", true);
            setBaritoneSettingBool(settings, settingsClass, "allowBreak", true);
            setBaritoneSettingBool(settings, settingsClass, "allowPlace", true);

            AiriMcBridge.LOGGER.info("[AIRI] Baritone settings configured");
        } catch (Exception e) {
            AiriMcBridge.LOGGER.error("[AIRI] Failed to configure Baritone settings", e);
        }
    }

    private static void setBaritoneSettingBool(Object settings, Class<?> settingsClass, String name, boolean value) {
        try {
            Object field = settingsClass.getField(name).get(settings);
            // Settings fields are baritone.api.Settings.Setting<Boolean>
            field.getClass().getField("value").set(field, value);
        } catch (Exception e) {
            AiriMcBridge.LOGGER.warn("[AIRI] Could not set Baritone setting '{}': {}", name, e.getMessage());
        }
    }
}

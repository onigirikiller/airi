package com.airi.mcbridge.handlers;

import com.airi.mcbridge.AiriMcBridge;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.entity.Entity;

import java.util.ArrayList;
import java.util.List;

public class MovementHandler {

    /**
     * Navigate to a position using Baritone or signal error for fallback.
     * Params: { x: number, y: number, z: number }
     */
    public JsonObject handleGoto(JsonObject params, MinecraftClient client) throws Exception {
        requirePlayer(client);
        AiriMcBridge.getInstance().getRemoteMovementController().stop(client, "goto");

        int x = params.get("x").getAsInt();
        int y = params.get("y").getAsInt();
        int z = params.get("z").getAsInt();

        if (BaritoneHelper.gotoBlock(x, y, z)) {
            JsonObject result = new JsonObject();
            result.addProperty("status", "pathfinding");
            result.addProperty("target_x", x);
            result.addProperty("target_y", y);
            result.addProperty("target_z", z);
            result.addProperty("method", "baritone");
            return result;
        }

        // Baritone not available — Node.js side will fall back to simpleWalkToward
        JsonObject result = new JsonObject();
        result.addProperty("status", "error");
        result.addProperty("message", "Baritone not installed. Install Baritone for pathfinding support.");
        return result;
    }

    /**
     * Navigate to within range blocks of a position using Baritone.
     * Params: { x: number, y: number, z: number, range: number }
     */
    public JsonObject handleGotoNear(JsonObject params, MinecraftClient client) throws Exception {
        requirePlayer(client);
        AiriMcBridge.getInstance().getRemoteMovementController().stop(client, "goto_near");

        int x = params.get("x").getAsInt();
        int y = params.get("y").getAsInt();
        int z = params.get("z").getAsInt();
        int range = params.has("range") ? params.get("range").getAsInt() : 2;

        if (BaritoneHelper.gotoNear(x, y, z, range)) {
            JsonObject result = new JsonObject();
            result.addProperty("status", "pathfinding");
            result.addProperty("target_x", x);
            result.addProperty("target_y", y);
            result.addProperty("target_z", z);
            result.addProperty("range", range);
            result.addProperty("method", "baritone");
            return result;
        }

        JsonObject result = new JsonObject();
        result.addProperty("status", "error");
        result.addProperty("message", "Baritone not installed.");
        return result;
    }

    /**
     * Mine specified block types using Baritone.
     * Params: { blockNames: ["diamond_ore", "oak_log"] }
     */
    public JsonObject handleBaritoneMine(JsonObject params, MinecraftClient client) throws Exception {
        requirePlayer(client);
        AiriMcBridge.getInstance().getRemoteMovementController().stop(client, "baritone_mine");

        JsonArray namesArray = params.getAsJsonArray("blockNames");
        List<String> blockNames = new ArrayList<>();
        for (int i = 0; i < namesArray.size(); i++) {
            blockNames.add(namesArray.get(i).getAsString());
        }

        if (BaritoneHelper.mine(blockNames)) {
            JsonObject result = new JsonObject();
            result.addProperty("status", "mining");
            result.addProperty("method", "baritone");
            result.add("blockNames", namesArray);
            return result;
        }

        JsonObject result = new JsonObject();
        result.addProperty("status", "error");
        result.addProperty("message", "Baritone not installed or no valid blocks specified.");
        return result;
    }

    /**
     * Follow an entity using Baritone.
     * Params: { entityId: number }
     */
    public JsonObject handleBaritoneFollow(JsonObject params, MinecraftClient client) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);
        AiriMcBridge.getInstance().getRemoteMovementController().stop(client, "baritone_follow");

        int entityId = params.get("entityId").getAsInt();
        Entity target = player.getWorld().getEntityById(entityId);

        if (target == null) {
            JsonObject result = new JsonObject();
            result.addProperty("status", "error");
            result.addProperty("message", "Entity not found: " + entityId);
            return result;
        }

        if (BaritoneHelper.follow(target)) {
            JsonObject result = new JsonObject();
            result.addProperty("status", "following");
            result.addProperty("method", "baritone");
            result.addProperty("entityId", entityId);
            result.addProperty("entityName", target.getName().getString());
            return result;
        }

        JsonObject result = new JsonObject();
        result.addProperty("status", "error");
        result.addProperty("message", "Baritone not installed.");
        return result;
    }

    /**
     * Get Baritone status.
     * Params: {}
     */
    public JsonObject handleBaritoneStatus(JsonObject params, MinecraftClient client) throws Exception {
        JsonObject result = new JsonObject();
        result.addProperty("available", BaritoneHelper.isAvailable());
        result.addProperty("isPathing", BaritoneHelper.isPathing());
        result.addProperty("isActive", BaritoneHelper.isActive());
        return result;
    }

    /**
     * Look at a specific yaw/pitch.
     * Params: { yaw: number, pitch: number }
     */
    public JsonObject handleLook(JsonObject params, MinecraftClient client) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);
        AiriMcBridge.getInstance().getRemoteMovementController().stop(client, "manual_look");

        float yaw = params.get("yaw").getAsFloat();
        float pitch = params.get("pitch").getAsFloat();

        player.setYaw(yaw);
        player.setPitch(pitch);

        JsonObject result = new JsonObject();
        result.addProperty("status", "ok");
        result.addProperty("yaw", yaw);
        result.addProperty("pitch", pitch);
        return result;
    }

    /**
     * Set a control state (forward, back, left, right, jump, sneak, sprint).
     * Params: { control: string, state: boolean }
     */
    public JsonObject handleSetControlState(JsonObject params, MinecraftClient client) throws Exception {
        requirePlayer(client);
        AiriMcBridge.getInstance().getRemoteMovementController().stop(client, "manual_controls");

        String control = params.get("control").getAsString();
        boolean state = params.get("state").getAsBoolean();

        KeyBinding key = switch (control) {
            case "forward" -> client.options.forwardKey;
            case "back" -> client.options.backKey;
            case "left" -> client.options.leftKey;
            case "right" -> client.options.rightKey;
            case "jump" -> client.options.jumpKey;
            case "sneak" -> client.options.sneakKey;
            case "sprint" -> client.options.sprintKey;
            default -> throw new IllegalArgumentException("Unknown control: " + control);
        };

        key.setPressed(state);

        JsonObject result = new JsonObject();
        result.addProperty("status", "ok");
        result.addProperty("control", control);
        result.addProperty("state", state);
        return result;
    }

    /**
     * Start tick-driven remote movement toward a target.
     * Params: { x: number, y: number, z: number, range?: number, movementMode?: "walk"|"swim", timeoutMs?: number }
     */
    public JsonObject handleMoveToward(JsonObject params, MinecraftClient client) throws Exception {
        requirePlayer(client);

        double x = params.get("x").getAsDouble();
        double y = params.get("y").getAsDouble();
        double z = params.get("z").getAsDouble();
        double range = params.has("range") ? params.get("range").getAsDouble() : 2.0D;
        String movementMode = params.has("movementMode") ? params.get("movementMode").getAsString() : "walk";
        long timeoutMs = params.has("timeoutMs") ? params.get("timeoutMs").getAsLong() : 60_000L;

        AiriMcBridge.getInstance()
                .getRemoteMovementController()
                .startMoveToward(x, y, z, range, movementMode, timeoutMs);

        JsonObject result = new JsonObject();
        result.addProperty("status", "moving");
        result.addProperty("mode", movementMode);
        result.addProperty("target_x", x);
        result.addProperty("target_y", y);
        result.addProperty("target_z", z);
        result.addProperty("range", range);
        result.addProperty("timeoutMs", timeoutMs);
        return result;
    }

    /**
     * Stop all movement (release all keys, cancel Baritone).
     */
    public JsonObject handleStopMovement(JsonObject params, MinecraftClient client) throws Exception {
        requirePlayer(client);
        AiriMcBridge.getInstance().getRemoteMovementController().stop(client, "stop_requested");

        // Release all movement keys
        client.options.forwardKey.setPressed(false);
        client.options.backKey.setPressed(false);
        client.options.leftKey.setPressed(false);
        client.options.rightKey.setPressed(false);
        client.options.jumpKey.setPressed(false);
        client.options.sneakKey.setPressed(false);
        client.options.sprintKey.setPressed(false);

        // Cancel Baritone if present
        BaritoneHelper.stop();

        JsonObject result = new JsonObject();
        result.addProperty("status", "ok");
        return result;
    }

    private ClientPlayerEntity requirePlayer(MinecraftClient client) throws Exception {
        if (client.player == null) throw new IllegalStateException("Player not in world");
        return client.player;
    }
}

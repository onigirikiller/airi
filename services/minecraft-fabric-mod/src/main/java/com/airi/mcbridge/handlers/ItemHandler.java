package com.airi.mcbridge.handlers;

import com.google.gson.JsonObject;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.entity.Entity;
import net.minecraft.entity.EyeOfEnderEntity;
import net.minecraft.registry.Registries;
import net.minecraft.util.Hand;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;

public class ItemHandler {

    /**
     * Use item (right-click) in hand.
     * Params: { hand?: "main"|"off" }
     */
    public JsonObject handleUseItem(JsonObject params, MinecraftClient client) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);
        Hand hand = getHand(params);

        client.interactionManager.interactItem(player, hand);
        player.swingHand(hand);

        String itemName = (hand == Hand.MAIN_HAND
            ? player.getMainHandStack()
            : player.getOffHandStack()).getName().getString();

        JsonObject result = new JsonObject();
        result.addProperty("status", "ok");
        result.addProperty("item", itemName);
        return result;
    }

    /**
     * Use item on a block (right-click block).
     * Params: { x, y, z, face?: string, hand?: "main"|"off" }
     */
    public JsonObject handleUseItemOnBlock(JsonObject params, MinecraftClient client) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);
        Hand hand = getHand(params);

        int x = params.get("x").getAsInt();
        int y = params.get("y").getAsInt();
        int z = params.get("z").getAsInt();
        BlockPos pos = new BlockPos(x, y, z);

        Direction face = Direction.UP;
        if (params.has("face")) {
            face = switch (params.get("face").getAsString().toUpperCase()) {
                case "DOWN" -> Direction.DOWN;
                case "NORTH" -> Direction.NORTH;
                case "SOUTH" -> Direction.SOUTH;
                case "EAST" -> Direction.EAST;
                case "WEST" -> Direction.WEST;
                default -> Direction.UP;
            };
        }

        Vec3d hitVec = Vec3d.ofCenter(pos);
        BlockHitResult hitResult = new BlockHitResult(hitVec, face, pos, false);
        client.interactionManager.interactBlock(player, hand, hitResult);

        JsonObject result = new JsonObject();
        result.addProperty("status", "ok");
        return result;
    }

    /**
     * Start using item (hold right-click, e.g. bow draw).
     * Params: { hand?: "main"|"off" }
     */
    public JsonObject handleStartUseItem(JsonObject params, MinecraftClient client) throws Exception {
        requirePlayer(client);
        client.options.useKey.setPressed(true);

        JsonObject result = new JsonObject();
        result.addProperty("status", "ok");
        return result;
    }

    /**
     * Stop using item (release right-click, e.g. bow release).
     * Params: {}
     */
    public JsonObject handleStopUseItem(JsonObject params, MinecraftClient client) throws Exception {
        requirePlayer(client);
        client.options.useKey.setPressed(false);

        JsonObject result = new JsonObject();
        result.addProperty("status", "ok");
        return result;
    }

    /**
     * Throw eye of ender and track its flight direction.
     * Params: {}
     * Returns: { status, direction: {x, z}, startPos: {x,y,z}, endPos: {x,y,z} }
     */
    public JsonObject handleThrowEyeOfEnder(JsonObject params, MinecraftClient client) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);

        // Use the ender eye
        client.interactionManager.interactItem(player, Hand.MAIN_HAND);
        player.swingHand(Hand.MAIN_HAND);

        // Wait a moment for the entity to spawn
        Thread.sleep(100);

        // Find the eye of ender entity (use getOtherEntities for client world)
        EyeOfEnderEntity eye = null;
        for (Entity entity : player.getWorld().getOtherEntities(player, player.getBoundingBox().expand(10))) {
            if (entity instanceof EyeOfEnderEntity e) {
                eye = e;
                break;
            }
        }

        if (eye == null) {
            JsonObject result = new JsonObject();
            result.addProperty("status", "error");
            result.addProperty("message", "Could not find eye of ender entity");
            return result;
        }

        double startX = eye.getX();
        double startY = eye.getY();
        double startZ = eye.getZ();

        double endX = startX;
        double endY = startY;
        double endZ = startZ;

        // Track the eye's flight for up to 3 seconds
        for (int i = 0; i < 60; i++) {
            Thread.sleep(50);
            if (eye.isRemoved()) break;
            endX = eye.getX();
            endY = eye.getY();
            endZ = eye.getZ();
        }

        // Calculate direction
        double dx = endX - startX;
        double dz = endZ - startZ;
        double len = Math.sqrt(dx * dx + dz * dz);

        JsonObject direction = new JsonObject();
        if (len > 0.1) {
            direction.addProperty("x", dx / len);
            direction.addProperty("z", dz / len);
        } else {
            direction.addProperty("x", 0);
            direction.addProperty("z", 0);
        }

        JsonObject startPos = new JsonObject();
        startPos.addProperty("x", startX);
        startPos.addProperty("y", startY);
        startPos.addProperty("z", startZ);

        JsonObject endPos = new JsonObject();
        endPos.addProperty("x", endX);
        endPos.addProperty("y", endY);
        endPos.addProperty("z", endZ);

        JsonObject result = new JsonObject();
        result.addProperty("status", "ok");
        result.add("direction", direction);
        result.add("startPos", startPos);
        result.add("endPos", endPos);
        return result;
    }

    /**
     * Look at specific world coordinates.
     * Params: { x, y, z }
     */
    public JsonObject handleLookAt(JsonObject params, MinecraftClient client) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);

        double x = params.get("x").getAsDouble();
        double y = params.get("y").getAsDouble();
        double z = params.get("z").getAsDouble();

        double dx = x - player.getX();
        double dy = y - (player.getY() + player.getEyeHeight(player.getPose()));
        double dz = z - player.getZ();
        double dist = Math.sqrt(dx * dx + dz * dz);
        float yaw = (float) (Math.atan2(-dx, dz) * 180.0 / Math.PI);
        float pitch = (float) (-(Math.atan2(dy, dist) * 180.0 / Math.PI));

        player.setYaw(yaw);
        player.setPitch(pitch);

        JsonObject result = new JsonObject();
        result.addProperty("status", "ok");
        result.addProperty("yaw", yaw);
        result.addProperty("pitch", pitch);
        return result;
    }

    private Hand getHand(JsonObject params) {
        if (params.has("hand") && "off".equals(params.get("hand").getAsString())) {
            return Hand.OFF_HAND;
        }
        return Hand.MAIN_HAND;
    }

    private ClientPlayerEntity requirePlayer(MinecraftClient client) throws Exception {
        if (client.player == null) throw new IllegalStateException("Player not in world");
        return client.player;
    }
}

package com.airi.mcbridge.handlers;

import com.google.gson.JsonObject;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.entity.Entity;
import net.minecraft.entity.LivingEntity;
import net.minecraft.util.Hand;

public class CombatHandler {

    /**
     * Attack a single entity by ID.
     * Params: { entityId: number }
     */
    public JsonObject handleAttack(JsonObject params, MinecraftClient client) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);
        int entityId = params.get("entityId").getAsInt();

        Entity target = player.getWorld().getEntityById(entityId);
        if (target == null) {
            throw new IllegalArgumentException("Entity not found: " + entityId);
        }

        // Face target
        double dx = target.getX() - player.getX();
        double dy = (target.getY() + target.getHeight() / 2) - (player.getY() + player.getEyeHeight(player.getPose()));
        double dz = target.getZ() - player.getZ();
        double dist = Math.sqrt(dx * dx + dz * dz);
        float yaw = (float) (Math.atan2(-dx, dz) * 180.0 / Math.PI);
        float pitch = (float) (-(Math.atan2(dy, dist) * 180.0 / Math.PI));
        player.setYaw(yaw);
        player.setPitch(pitch);

        // Attack
        client.interactionManager.attackEntity(player, target);
        player.swingHand(Hand.MAIN_HAND);

        JsonObject result = new JsonObject();
        result.addProperty("status", "ok");
        result.addProperty("entityId", entityId);
        result.addProperty("distance", player.distanceTo(target));
        return result;
    }

    /**
     * Continuous PVP attack - attack and strafe.
     * Params: { entityId: number }
     */
    public JsonObject handlePvpAttack(JsonObject params, MinecraftClient client) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);
        int entityId = params.get("entityId").getAsInt();

        Entity target = player.getWorld().getEntityById(entityId);
        if (target == null) {
            throw new IllegalArgumentException("Entity not found: " + entityId);
        }

        double distance = player.distanceTo(target);

        // If close enough, attack
        if (distance < 4.0) {
            // Face target
            double dx = target.getX() - player.getX();
            double dy = (target.getY() + target.getHeight() / 2) - (player.getY() + player.getEyeHeight(player.getPose()));
            double dz = target.getZ() - player.getZ();
            double h = Math.sqrt(dx * dx + dz * dz);
            float yaw = (float) (Math.atan2(-dx, dz) * 180.0 / Math.PI);
            float pitch = (float) (-(Math.atan2(dy, h) * 180.0 / Math.PI));
            player.setYaw(yaw);
            player.setPitch(pitch);

            // Only attack when cooldown is ready
            if (player.getAttackCooldownProgress(0.5f) >= 1.0f) {
                client.interactionManager.attackEntity(player, target);
                player.swingHand(Hand.MAIN_HAND);
            }

            JsonObject result = new JsonObject();
            result.addProperty("status", "attacking");
            result.addProperty("distance", distance);
            return result;
        } else {
            // Use Baritone or manual approach to get closer
            JsonObject result = new JsonObject();
            result.addProperty("status", "too_far");
            result.addProperty("distance", distance);
            return result;
        }
    }

    /**
     * Perform a critical attack (jump + attack while falling).
     * Params: { entityId: number }
     */
    public JsonObject handleCriticalAttack(JsonObject params, MinecraftClient client) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);
        int entityId = params.get("entityId").getAsInt();

        Entity target = player.getWorld().getEntityById(entityId);
        if (target == null) {
            throw new IllegalArgumentException("Entity not found: " + entityId);
        }

        // Face target
        double dx = target.getX() - player.getX();
        double dy = (target.getY() + target.getHeight() / 2) - (player.getY() + player.getEyeHeight(player.getPose()));
        double dz = target.getZ() - player.getZ();
        double dist = Math.sqrt(dx * dx + dz * dz);
        float yaw = (float) (Math.atan2(-dx, dz) * 180.0 / Math.PI);
        float pitch = (float) (-(Math.atan2(dy, dist) * 180.0 / Math.PI));
        player.setYaw(yaw);
        player.setPitch(pitch);

        // Jump
        client.options.jumpKey.setPressed(true);
        Thread.sleep(100);
        client.options.jumpKey.setPressed(false);

        // Wait for player to start falling
        Thread.sleep(200);

        // Attack while falling (critical hit)
        double attackDist = player.distanceTo(target);
        if (attackDist < 5.0) {
            client.interactionManager.attackEntity(player, target);
            player.swingHand(Hand.MAIN_HAND);
        }

        JsonObject result = new JsonObject();
        result.addProperty("status", "ok");
        result.addProperty("entityId", entityId);
        result.addProperty("distance", attackDist);
        return result;
    }

    /**
     * Block with shield (hold/release use key with shield in offhand).
     * Params: { active: boolean }
     */
    public JsonObject handleShieldBlock(JsonObject params, MinecraftClient client) throws Exception {
        requirePlayer(client);
        boolean active = params.get("active").getAsBoolean();
        client.options.useKey.setPressed(active);

        JsonObject result = new JsonObject();
        result.addProperty("status", "ok");
        result.addProperty("blocking", active);
        return result;
    }

    /**
     * Stop any ongoing attack behavior.
     */
    public JsonObject handleStopAttack(JsonObject params, MinecraftClient client) throws Exception {
        JsonObject result = new JsonObject();
        result.addProperty("status", "ok");
        return result;
    }

    private ClientPlayerEntity requirePlayer(MinecraftClient client) throws Exception {
        if (client.player == null) throw new IllegalStateException("Player not in world");
        return client.player;
    }
}

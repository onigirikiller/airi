package com.airi.mcbridge.movement;

import com.airi.mcbridge.ws.BridgeServer;
import com.google.gson.JsonObject;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.util.math.MathHelper;
import net.minecraft.util.math.Vec3d;

/**
 * Tick-driven remote movement controller for cases where one-shot key presses are
 * not reliable enough, especially underwater escape and cave-surface recovery.
 */
public class RemoteMovementController {
    private final BridgeServer server;

    private boolean active = false;
    private double targetX = 0;
    private double targetY = 0;
    private double targetZ = 0;
    private double range = 2;
    private String movementMode = "walk";
    private long startedAtMs = 0;
    private long timeoutMs = 60_000;
    private String stopReason = "idle";

    public RemoteMovementController(BridgeServer server) {
        this.server = server;
    }

    public boolean isActive() {
        return active;
    }

    public String getMovementMode() {
        return movementMode;
    }

    public void startMoveToward(double x, double y, double z, double range, String movementMode, long timeoutMs) {
        this.active = true;
        this.targetX = x;
        this.targetY = y;
        this.targetZ = z;
        this.range = Math.max(0.5D, range);
        this.movementMode = movementMode == null ? "walk" : movementMode;
        this.timeoutMs = Math.max(5_000L, timeoutMs);
        this.startedAtMs = System.currentTimeMillis();
        this.stopReason = "active";
    }

    public void tick(MinecraftClient client) {
        if (!active || client.player == null) {
            return;
        }

        ClientPlayerEntity player = client.player;
        long now = System.currentTimeMillis();
        if (now - startedAtMs > timeoutMs) {
            stop(client, "timeout");
            return;
        }

        double dx = targetX - player.getX();
        double dy = targetY - player.getY();
        double dz = targetZ - player.getZ();
        double horizontalDistance = Math.sqrt(dx * dx + dz * dz);
        double verticalDistance = Math.abs(dy);

        if (horizontalDistance <= range && verticalDistance <= Math.max(1.5D, range)) {
            stop(client, "arrived");
            return;
        }

        boolean swimMode = "swim".equalsIgnoreCase(movementMode);
        float yaw = (float) (Math.atan2(-dx, dz) * 180.0D / Math.PI);
        float pitch = swimMode
                ? (float) (-(Math.atan2(dy, Math.max(horizontalDistance, 0.1D)) * 180.0D / Math.PI))
                : 0.0F;

        player.setYaw(approachAngle(player.getYaw(), yaw, swimMode ? 18.0F : 28.0F));
        player.setPitch(MathHelper.clamp(approachAngle(player.getPitch(), pitch, 14.0F), -85.0F, 85.0F));

        client.options.forwardKey.setPressed(true);
        client.options.backKey.setPressed(false);
        client.options.leftKey.setPressed(false);
        client.options.rightKey.setPressed(false);
        client.options.sprintKey.setPressed(!swimMode && horizontalDistance > 8.0D);

        if (swimMode) {
            boolean shouldAscend = dy > -0.35D || player.isSubmergedInWater() || player.isTouchingWater();
            client.options.jumpKey.setPressed(shouldAscend);
            client.options.sneakKey.setPressed(dy < -1.25D);
            nudgeSwimVelocity(player, dx, dy, dz, horizontalDistance);
        } else {
            client.options.jumpKey.setPressed(dy > 1.0D);
            client.options.sneakKey.setPressed(false);
        }
    }

    public void stop(MinecraftClient client, String reason) {
        active = false;
        stopReason = reason == null ? "stopped" : reason;

        if (client != null) {
            releaseKeys(client);
        }

        JsonObject payload = new JsonObject();
        payload.addProperty("reason", stopReason);
        payload.addProperty("mode", movementMode);
        payload.addProperty("target_x", targetX);
        payload.addProperty("target_y", targetY);
        payload.addProperty("target_z", targetZ);
        server.broadcastEvent("event:remoteMovementStopped", payload.toString());
    }

    public void stop(MinecraftClient client) {
        stop(client, "stopped");
    }

    private void releaseKeys(MinecraftClient client) {
        client.options.forwardKey.setPressed(false);
        client.options.backKey.setPressed(false);
        client.options.leftKey.setPressed(false);
        client.options.rightKey.setPressed(false);
        client.options.jumpKey.setPressed(false);
        client.options.sneakKey.setPressed(false);
        client.options.sprintKey.setPressed(false);
    }

    private float approachAngle(float current, float target, float maxDelta) {
        return MathHelper.stepUnwrappedAngleTowards(current, target, maxDelta);
    }

    private void nudgeSwimVelocity(ClientPlayerEntity player, double dx, double dy, double dz, double horizontalDistance) {
        Vec3d direction = new Vec3d(dx, Math.max(dy * 0.75D, -0.2D), dz);
        if (direction.lengthSquared() < 1.0E-4D) {
            return;
        }

        Vec3d normalized = direction.normalize();
        double speedBoost = horizontalDistance > 6.0D ? 0.04D : 0.025D;
        double upwardBoost = dy > 0.5D ? 0.03D : (dy > -0.2D ? 0.012D : 0.0D);
        player.addVelocity(
                normalized.x * speedBoost,
                normalized.y * speedBoost + upwardBoost,
                normalized.z * speedBoost
        );
    }
}

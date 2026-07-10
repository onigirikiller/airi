package com.airi.mcbridge.handlers;

import com.airi.mcbridge.util.Serializers;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.block.Block;
import net.minecraft.block.BlockState;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.registry.Registries;
import net.minecraft.util.Hand;
import net.minecraft.util.Identifier;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

public class BlockHandler {

    private final ScheduledExecutorService scheduler =
        Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "AIRI-BlockBreak-Ticker");
            t.setDaemon(true);
            return t;
        });

    /**
     * Break a block at position.
     * In survival mode this must simulate holding left-click until the block
     * actually breaks (attackBlock starts mining, then updateBlockBreakingProgress
     * must be called each game tick until the block is gone).
     *
     * NOTE: This handler is called from a worker thread (not the render thread)
     * because it blocks until mining completes. It dispatches Minecraft API calls
     * to the render thread via client.execute().
     *
     * Params: { x: number, y: number, z: number }
     */
    public JsonObject handleDig(JsonObject params, MinecraftClient client) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);
        BlockPos pos = new BlockPos(
            params.get("x").getAsInt(),
            params.get("y").getAsInt(),
            params.get("z").getAsInt()
        );

        // Read block state on the render thread
        CompletableFuture<BlockState> stateFuture = new CompletableFuture<>();
        client.execute(() -> {
            try {
                stateFuture.complete(player.getWorld().getBlockState(pos));
            } catch (Exception e) {
                stateFuture.completeExceptionally(e);
            }
        });
        BlockState state = stateFuture.get(5, TimeUnit.SECONDS);

        if (state.isAir()) {
            throw new IllegalArgumentException("No block at position");
        }

        String blockId = Registries.BLOCK.getId(state.getBlock()).toString();

        // Creative mode: instant break on render thread
        if (player.isCreative()) {
            CompletableFuture<Void> creativeFuture = new CompletableFuture<>();
            client.execute(() -> {
                try {
                    client.interactionManager.attackBlock(pos, Direction.UP);
                    client.interactionManager.attackBlock(pos, Direction.UP);
                    creativeFuture.complete(null);
                } catch (Exception e) {
                    creativeFuture.completeExceptionally(e);
                }
            });
            creativeFuture.get(5, TimeUnit.SECONDS);

            JsonObject result = new JsonObject();
            result.addProperty("status", "digging");
            result.addProperty("block", blockId);
            result.add("position", Serializers.blockPosToJson(pos));
            return result;
        }

        // Survival mode: start mining on the render thread
        Direction face = findBestFace(player, pos);
        CompletableFuture<Void> startFuture = new CompletableFuture<>();
        client.execute(() -> {
            try {
                client.interactionManager.attackBlock(pos, face);
                startFuture.complete(null);
            } catch (Exception e) {
                startFuture.completeExceptionally(e);
            }
        });
        startFuture.get(5, TimeUnit.SECONDS);

        // Tick mining progress using a scheduled executor.
        // Each tick dispatches updateBlockBreakingProgress to the render thread
        // without blocking it.
        CompletableFuture<Boolean> breakFuture = new CompletableFuture<>();
        final int MAX_TICKS = 300; // 15 seconds at 20 TPS
        AtomicInteger tickCount = new AtomicInteger(0);

        var tickTask = scheduler.scheduleAtFixedRate(() -> {
            if (breakFuture.isDone()) return;

            int tick = tickCount.getAndIncrement();
            if (tick >= MAX_TICKS) {
                breakFuture.complete(false);
                return;
            }

            client.execute(() -> {
                try {
                    BlockState current = player.getWorld().getBlockState(pos);
                    if (current.isAir()) {
                        breakFuture.complete(true);
                        return;
                    }
                    client.interactionManager.updateBlockBreakingProgress(pos, face);
                } catch (Exception e) {
                    breakFuture.completeExceptionally(e);
                }
            });
        }, 0, 50, TimeUnit.MILLISECONDS);

        // Block this worker thread (NOT the render thread) until done
        boolean success;
        try {
            success = breakFuture.get(16, TimeUnit.SECONDS);
        } finally {
            tickTask.cancel(false);
        }

        JsonObject result = new JsonObject();
        result.addProperty("status", success ? "digging" : "timeout");
        result.addProperty("block", blockId);
        result.add("position", Serializers.blockPosToJson(pos));
        return result;
    }

    private Direction findBestFace(ClientPlayerEntity player, BlockPos pos) {
        Vec3d eyePos = player.getEyePos();
        Vec3d blockCenter = Vec3d.ofCenter(pos);
        Vec3d diff = eyePos.subtract(blockCenter);

        double absX = Math.abs(diff.x);
        double absY = Math.abs(diff.y);
        double absZ = Math.abs(diff.z);

        if (absY >= absX && absY >= absZ) {
            return diff.y > 0 ? Direction.UP : Direction.DOWN;
        } else if (absX >= absZ) {
            return diff.x > 0 ? Direction.EAST : Direction.WEST;
        } else {
            return diff.z > 0 ? Direction.SOUTH : Direction.NORTH;
        }
    }

    /**
     * Place a block at position.
     * Params: { x: number, y: number, z: number, face: string? }
     */
    public JsonObject handlePlace(JsonObject params, MinecraftClient client) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);

        int x = params.get("x").getAsInt();
        int y = params.get("y").getAsInt();
        int z = params.get("z").getAsInt();

        Direction face = Direction.UP;
        if (params.has("face")) {
            face = Direction.valueOf(params.get("face").getAsString().toUpperCase());
        }

        BlockPos pos = new BlockPos(x, y, z);
        Vec3d hitVec = Vec3d.ofCenter(pos);
        BlockHitResult hitResult = new BlockHitResult(hitVec, face, pos, false);

        client.interactionManager.interactBlock(player, Hand.MAIN_HAND, hitResult);

        JsonObject result = new JsonObject();
        result.addProperty("status", "ok");
        result.add("position", Serializers.blockPosToJson(pos));
        return result;
    }

    /**
     * Find blocks matching a type within range.
     * Params: { block: string, maxDistance: number?, count: number? }
     */
    public JsonObject handleFindBlocks(JsonObject params, MinecraftClient client) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);

        String blockName = params.get("block").getAsString();
        int maxDistance = params.has("maxDistance") ? params.get("maxDistance").getAsInt() : 64;
        int count = params.has("count") ? params.get("count").getAsInt() : 100;

        Block targetBlock = Registries.BLOCK.get(new Identifier(blockName));
        if (targetBlock == null) {
            throw new IllegalArgumentException("Unknown block: " + blockName);
        }

        BlockPos playerPos = player.getBlockPos();
        List<BlockPos> matches = new ArrayList<>();

        for (int dx = -maxDistance; dx <= maxDistance; dx++) {
            for (int dy = -maxDistance; dy <= maxDistance; dy++) {
                for (int dz = -maxDistance; dz <= maxDistance; dz++) {
                    BlockPos checkPos = playerPos.add(dx, dy, dz);
                    BlockState state = player.getWorld().getBlockState(checkPos);
                    if (state.getBlock() == targetBlock) {
                        matches.add(checkPos);
                    }
                }
            }
        }

        // NOTICE: The bridge previously truncated matches in raw dx/dy/dz scan order,
        // which biased results toward far negative-X blocks and caused the bot to chase
        // distant trees while nearer logs were available. Sort by player distance first
        // so higher-level path selection receives the actual nearest candidates.
        matches.sort(Comparator.comparingDouble(checkPos -> checkPos.getSquaredDistance(playerPos)));

        JsonArray found = new JsonArray();
        for (int index = 0; index < matches.size() && index < count; index++) {
            found.add(Serializers.blockPosToJson(matches.get(index)));
        }

        JsonObject result = new JsonObject();
        result.addProperty("status", "ok");
        result.addProperty("block", blockName);
        result.add("positions", found);
        result.addProperty("count", found.size());
        return result;
    }

    /**
     * Get block info at a position.
     * Params: { x: number, y: number, z: number }
     */
    public JsonObject handleBlockAt(JsonObject params, MinecraftClient client) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);
        BlockPos pos = new BlockPos(
            params.get("x").getAsInt(),
            params.get("y").getAsInt(),
            params.get("z").getAsInt()
        );

        BlockState state = player.getWorld().getBlockState(pos);

        JsonObject result = new JsonObject();
        result.addProperty("status", "ok");
        result.addProperty("name", Registries.BLOCK.getId(state.getBlock()).toString());
        result.addProperty("isAir", state.isAir());
        result.addProperty("isSolid", state.isSolidBlock(player.getWorld(), pos));
        result.add("position", Serializers.blockPosToJson(pos));
        return result;
    }

    /**
     * Right-click/activate a block (e.g., open chest, press button).
     * Params: { x: number, y: number, z: number }
     */
    public JsonObject handleActivateBlock(JsonObject params, MinecraftClient client) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);
        BlockPos pos = new BlockPos(
            params.get("x").getAsInt(),
            params.get("y").getAsInt(),
            params.get("z").getAsInt()
        );

        Direction face = InventoryHandler.getPreferredInteractionFaces(player.getEyePos(), pos).get(0);
        Vec3d hitVec = Vec3d.ofCenter(pos).add(
            face.getOffsetX() * 0.49D,
            face.getOffsetY() * 0.49D,
            face.getOffsetZ() * 0.49D
        );
        BlockHitResult hitResult = new BlockHitResult(hitVec, face, pos, false);
        client.interactionManager.interactBlock(player, Hand.MAIN_HAND, hitResult);

        JsonObject result = new JsonObject();
        result.addProperty("status", "ok");
        result.add("position", Serializers.blockPosToJson(pos));
        return result;
    }

    private ClientPlayerEntity requirePlayer(MinecraftClient client) throws Exception {
        if (client.player == null) throw new IllegalStateException("Player not in world");
        return client.player;
    }
}

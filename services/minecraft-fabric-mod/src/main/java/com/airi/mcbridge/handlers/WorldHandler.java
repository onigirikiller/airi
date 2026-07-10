package com.airi.mcbridge.handlers;

import com.airi.mcbridge.util.Serializers;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.client.network.PlayerListEntry;
import net.minecraft.entity.Entity;
import net.minecraft.entity.LivingEntity;
import net.minecraft.entity.mob.MobEntity;
import net.minecraft.entity.passive.AnimalEntity;
import net.minecraft.entity.player.PlayerEntity;
import net.minecraft.registry.Registries;
import net.minecraft.util.math.BlockPos;
import net.minecraft.world.biome.Biome;

public class WorldHandler {

    /**
     * Get nearby entities.
     * Params: { maxDistance: number?, type: string? }
     */
    public JsonObject handleGetEntities(JsonObject params, MinecraftClient client) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);
        double maxDistance = params.has("maxDistance") ? params.get("maxDistance").getAsDouble() : 32.0;
        String typeFilter = params.has("type") ? params.get("type").getAsString() : null;

        JsonArray entities = new JsonArray();
        for (Entity entity : player.getWorld().getOtherEntities(player, player.getBoundingBox().expand(maxDistance))) {
            double dist = entity.distanceTo(player);

            String entityType = Registries.ENTITY_TYPE.getId(entity.getType()).toString();
            if (typeFilter != null && !entityType.contains(typeFilter)) continue;

            JsonObject entityJson = new JsonObject();
            entityJson.addProperty("id", entity.getId());
            entityJson.addProperty("type", entityType);
            entityJson.addProperty("name", entity.getName().getString());
            entityJson.addProperty("x", entity.getX());
            entityJson.addProperty("y", entity.getY());
            entityJson.addProperty("z", entity.getZ());
            entityJson.addProperty("distance", dist);
            entityJson.addProperty("isHostile", entity instanceof MobEntity);
            entityJson.addProperty("isPassive", entity instanceof AnimalEntity);
            entityJson.addProperty("isPlayer", entity instanceof PlayerEntity);

            if (entity instanceof LivingEntity living) {
                entityJson.addProperty("health", living.getHealth());
                entityJson.addProperty("maxHealth", living.getMaxHealth());
            }

            entities.add(entityJson);
        }

        JsonObject result = new JsonObject();
        result.addProperty("status", "ok");
        result.add("entities", entities);
        result.addProperty("count", entities.size());
        return result;
    }

    /**
     * Get current game time.
     */
    public JsonObject handleGetTime(JsonObject params, MinecraftClient client) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);

        long timeOfDay = player.getWorld().getTimeOfDay();
        long dayCount = timeOfDay / 24000;

        JsonObject result = new JsonObject();
        result.addProperty("status", "ok");
        result.addProperty("timeOfDay", timeOfDay % 24000);
        result.addProperty("day", dayCount);
        result.addProperty("isDay", timeOfDay % 24000 < 13000);
        result.addProperty("isNight", timeOfDay % 24000 >= 13000);
        return result;
    }

    /**
     * Get current dimension.
     */
    public JsonObject handleGetDimension(JsonObject params, MinecraftClient client) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);

        String dimension = player.getWorld().getRegistryKey().getValue().toString();

        JsonObject result = new JsonObject();
        result.addProperty("status", "ok");
        result.addProperty("dimension", dimension);
        return result;
    }

    /**
     * Get biome at player position.
     * Params: { x: number?, y: number?, z: number? } (defaults to player pos)
     */
    public JsonObject handleGetBiome(JsonObject params, MinecraftClient client) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);

        BlockPos pos;
        if (params.has("x")) {
            pos = new BlockPos(
                params.get("x").getAsInt(),
                params.get("y").getAsInt(),
                params.get("z").getAsInt()
            );
        } else {
            pos = player.getBlockPos();
        }

        var biomeEntry = player.getWorld().getBiome(pos);
        String biomeName = biomeEntry.getKey()
            .map(key -> key.getValue().toString())
            .orElse("unknown");

        JsonObject result = new JsonObject();
        result.addProperty("status", "ok");
        result.addProperty("biome", biomeName);
        return result;
    }

    /**
     * Get current weather.
     */
    public JsonObject handleGetWeather(JsonObject params, MinecraftClient client) throws Exception {
        requirePlayer(client);

        String weather = "clear";
        if (client.world.isThundering()) {
            weather = "thunder";
        } else if (client.world.isRaining()) {
            weather = "rain";
        }

        JsonObject result = new JsonObject();
        result.addProperty("status", "ok");
        result.addProperty("weather", weather);
        return result;
    }

    /**
     * Get online players.
     */
    public JsonObject handleGetPlayers(JsonObject params, MinecraftClient client) throws Exception {
        requirePlayer(client);

        JsonArray players = new JsonArray();
        if (client.getNetworkHandler() != null) {
            for (PlayerListEntry entry : client.getNetworkHandler().getPlayerList()) {
                JsonObject playerJson = new JsonObject();
                playerJson.addProperty("name", entry.getProfile().getName());
                playerJson.addProperty("uuid", entry.getProfile().getId().toString());
                playerJson.addProperty("ping", entry.getLatency());
                players.add(playerJson);
            }
        }

        JsonObject result = new JsonObject();
        result.addProperty("status", "ok");
        result.add("players", players);
        return result;
    }

    /**
     * Respawn after death.
     */
    public JsonObject handleRespawn(JsonObject params, MinecraftClient client) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);
        player.requestRespawn();

        JsonObject result = new JsonObject();
        result.addProperty("status", "ok");
        return result;
    }

    private ClientPlayerEntity requirePlayer(MinecraftClient client) throws Exception {
        if (client.player == null) throw new IllegalStateException("Player not in world");
        return client.player;
    }
}

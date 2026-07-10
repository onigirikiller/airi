package com.airi.mcbridge.state;

import com.airi.mcbridge.handlers.BaritoneHelper;
import com.airi.mcbridge.util.Serializers;
import com.airi.mcbridge.ws.BridgeServer;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.entity.effect.StatusEffectInstance;
import net.minecraft.item.ItemStack;
import net.minecraft.registry.Registries;

public class StateEmitter {
    private final BridgeServer server;
    private int tickCounter = 0;

    // Cached values for change detection
    private float lastHealth = -1;
    private int lastFood = -1;
    private int lastInventoryHash = 0;
    private long lastTimeOfDay = -1;
    private boolean lastBaritoneActive = false;
    private boolean baritoneConfigured = false;
    private String lastDimension = null;

    // Intervals (in ticks, 20 ticks = 1 second)
    private static final int POSITION_INTERVAL = 2;   // ~100ms for smoother first-person viewer motion
    private static final int HEALTH_CHECK_INTERVAL = 2; // ~100ms
    private static final int TIME_INTERVAL = 20;       // 1 second

    public StateEmitter(BridgeServer server) {
        this.server = server;
    }

    public void tick(MinecraftClient client) {
        ClientPlayerEntity player = client.player;
        if (player == null) return;

        tickCounter++;

        // Position - every 200ms
        if (tickCounter % POSITION_INTERVAL == 0) {
            emitPosition(player);
        }

        // Health/Food - on change
        if (tickCounter % HEALTH_CHECK_INTERVAL == 0) {
            checkHealthChange(player);
        }

        // Inventory - on change
        if (tickCounter % 10 == 0) {
            checkInventoryChange(player);
        }

        // Time - every second
        if (tickCounter % TIME_INTERVAL == 0) {
            emitTime(player);
        }

        // Dimension change detection - every 10 ticks
        if (tickCounter % 10 == 0) {
            checkDimensionChange(player);
        }

        // Baritone path completion detection - every tick
        checkBaritoneCompletion();
    }

    private void checkDimensionChange(ClientPlayerEntity player) {
        String currentDimension = player.getWorld().getRegistryKey().getValue().toString();
        if (lastDimension != null && !currentDimension.equals(lastDimension)) {
            JsonObject data = new JsonObject();
            data.addProperty("from", lastDimension);
            data.addProperty("to", currentDimension);
            server.broadcastEvent("event:dimensionChange", data.toString());
        }
        lastDimension = currentDimension;
    }

    private void checkBaritoneCompletion() {
        if (!BaritoneHelper.isAvailable()) return;

        // Configure Baritone settings once on first detection
        if (!baritoneConfigured) {
            BaritoneHelper.configureSettings();
            baritoneConfigured = true;
        }

        boolean active = BaritoneHelper.isPathing() || BaritoneHelper.isActive();
        if (lastBaritoneActive && !active) {
            server.broadcastEvent("event:pathComplete", "{}");
        }
        lastBaritoneActive = active;
    }

    private void emitPosition(ClientPlayerEntity player) {
        JsonObject data = new JsonObject();
        data.addProperty("x", player.getX());
        data.addProperty("y", player.getY());
        data.addProperty("z", player.getZ());
        data.addProperty("yaw", player.getYaw());
        data.addProperty("pitch", player.getPitch());
        data.addProperty("onGround", player.isOnGround());
        data.addProperty("velocity_x", player.getVelocity().x);
        data.addProperty("velocity_y", player.getVelocity().y);
        data.addProperty("velocity_z", player.getVelocity().z);
        server.broadcastEvent("state:position", data.toString());
    }

    private void checkHealthChange(ClientPlayerEntity player) {
        float health = player.getHealth();
        int food = player.getHungerManager().getFoodLevel();

        if (health != lastHealth || food != lastFood) {
            lastHealth = health;
            lastFood = food;
            emitHealth(player);
        }

        // Death detection
        if (health <= 0 && lastHealth > 0) {
            server.broadcastEvent("event:death", "{}");
        }
    }

    private void emitHealth(ClientPlayerEntity player) {
        JsonObject data = new JsonObject();
        data.addProperty("health", player.getHealth());
        data.addProperty("maxHealth", player.getMaxHealth());
        data.addProperty("food", player.getHungerManager().getFoodLevel());
        data.addProperty("saturation", player.getHungerManager().getSaturationLevel());
        data.addProperty("armor", player.getArmor());
        data.addProperty("isOnFire", player.isOnFire());
        data.addProperty("air", player.getAir());

        // Active effects
        JsonArray effects = new JsonArray();
        for (StatusEffectInstance effect : player.getStatusEffects()) {
            JsonObject effectJson = new JsonObject();
            effectJson.addProperty("id", Registries.STATUS_EFFECT.getId(effect.getEffectType()).toString());
            effectJson.addProperty("duration", effect.getDuration());
            effectJson.addProperty("amplifier", effect.getAmplifier());
            effects.add(effectJson);
        }
        data.add("effects", effects);

        server.broadcastEvent("state:health", data.toString());
    }

    private void checkInventoryChange(ClientPlayerEntity player) {
        int hash = computeInventoryHash(player);
        if (hash != lastInventoryHash) {
            lastInventoryHash = hash;
            emitInventory(player);
        }
    }

    private void emitInventory(ClientPlayerEntity player) {
        JsonArray items = new JsonArray();
        for (int i = 0; i < player.getInventory().size(); i++) {
            ItemStack stack = player.getInventory().getStack(i);
            if (!stack.isEmpty()) {
                items.add(Serializers.itemStackToJson(stack, i));
            }
        }

        JsonObject data = new JsonObject();
        data.add("items", items);
        data.addProperty("selectedSlot", player.getInventory().selectedSlot);

        // Armor
        JsonArray armor = new JsonArray();
        for (int i = 0; i < 4; i++) {
            ItemStack armorStack = player.getInventory().armor.get(i);
            if (!armorStack.isEmpty()) {
                armor.add(Serializers.itemStackToJson(armorStack, 36 + i));
            }
        }
        data.add("armor", armor);

        // Offhand
        ItemStack offhand = player.getOffHandStack();
        if (!offhand.isEmpty()) {
            data.add("offhand", Serializers.itemStackToJson(offhand, 40));
        }

        server.broadcastEvent("state:inventory", data.toString());
    }

    private void emitTime(ClientPlayerEntity player) {
        long timeOfDay = player.getWorld().getTimeOfDay() % 24000;
        if (timeOfDay == lastTimeOfDay) return;
        lastTimeOfDay = timeOfDay;

        JsonObject data = new JsonObject();
        data.addProperty("timeOfDay", timeOfDay);
        data.addProperty("day", player.getWorld().getTimeOfDay() / 24000);
        data.addProperty("isDay", timeOfDay < 13000);
        server.broadcastEvent("state:time", data.toString());
    }

    private int computeInventoryHash(ClientPlayerEntity player) {
        int hash = player.getInventory().selectedSlot;
        for (int i = 0; i < player.getInventory().size(); i++) {
            ItemStack stack = player.getInventory().getStack(i);
            if (!stack.isEmpty()) {
                hash = 31 * hash + Registries.ITEM.getId(stack.getItem()).hashCode();
                hash = 31 * hash + stack.getCount();
                hash = 31 * hash + stack.getDamage();
                hash = 31 * hash + stack.getMaxDamage();
            }
        }
        return hash;
    }
}

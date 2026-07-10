package com.airi.mcbridge.ws;

import com.airi.mcbridge.AiriMcBridge;
import com.airi.mcbridge.handlers.*;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.client.MinecraftClient;

import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

public class MessageRouter {
    @FunctionalInterface
    public interface CommandHandler {
        JsonObject handle(JsonObject params, MinecraftClient client) throws Exception;
    }

    private final Map<String, CommandHandler> handlers = new HashMap<>();
    /**
     * Commands that manage their own threading (e.g. dig which needs to block
     * while ticking mining progress on the render thread via client.execute()).
     * These must NOT be wrapped in client.execute() by route() or they will
     * deadlock.
     */
    private final Set<String> asyncCommands = Set.of("dig", "craft", "openFurnace");

    public MessageRouter() {
        registerHandlers();
    }

    public Set<String> getSupportedCommandsSnapshot() {
        return new TreeSet<>(handlers.keySet());
    }

    public String getCapabilitiesHash() {
        return Integer.toHexString(getSupportedCommandsSnapshot().toString().hashCode());
    }

    private void registerHandlers() {
        // Movement
        MovementHandler movement = new MovementHandler();
        handlers.put("goto", movement::handleGoto);
        handlers.put("gotoNear", movement::handleGotoNear);
        handlers.put("look", movement::handleLook);
        handlers.put("moveToward", movement::handleMoveToward);
        handlers.put("setControlState", movement::handleSetControlState);
        handlers.put("stopMovement", movement::handleStopMovement);
        handlers.put("baritone_mine", movement::handleBaritoneMine);
        handlers.put("baritone_follow", movement::handleBaritoneFollow);
        handlers.put("baritone_status", movement::handleBaritoneStatus);

        // Combat
        CombatHandler combat = new CombatHandler();
        handlers.put("attack", combat::handleAttack);
        handlers.put("pvpAttack", combat::handlePvpAttack);
        handlers.put("stopAttack", combat::handleStopAttack);
        handlers.put("criticalAttack", combat::handleCriticalAttack);
        handlers.put("shieldBlock", combat::handleShieldBlock);

        // Block
        BlockHandler block = new BlockHandler();
        handlers.put("dig", block::handleDig);
        handlers.put("place", block::handlePlace);
        handlers.put("findBlocks", block::handleFindBlocks);
        handlers.put("blockAt", block::handleBlockAt);
        handlers.put("activateBlock", block::handleActivateBlock);

        // Item usage
        ItemHandler item = new ItemHandler();
        handlers.put("useItem", item::handleUseItem);
        handlers.put("useItemOnBlock", item::handleUseItemOnBlock);
        handlers.put("startUseItem", item::handleStartUseItem);
        handlers.put("stopUseItem", item::handleStopUseItem);
        handlers.put("throwEyeOfEnder", item::handleThrowEyeOfEnder);
        handlers.put("lookAt", item::handleLookAt);

        // Inventory
        InventoryHandler inventory = new InventoryHandler();
        handlers.put("equip", inventory::handleEquip);
        handlers.put("selectHotbarSlot", inventory::handleSelectHotbarSlot);
        handlers.put("swapInventorySlots", inventory::handleSwapInventorySlots);
        handlers.put("compactInventory", inventory::handleCompactInventory);
        handlers.put("craft", inventory::handleCraft);
        handlers.put("recipesFor", inventory::handleRecipesFor);
        handlers.put("openFurnace", inventory::handleOpenFurnace);
        handlers.put("getFurnaceSlots", inventory::handleGetFurnaceSlots);
        handlers.put("furnacePutInput", inventory::handleFurnacePutInput);
        handlers.put("furnacePutFuel", inventory::handleFurnacePutFuel);
        handlers.put("furnaceTakeOutput", inventory::handleFurnaceTakeOutput);
        handlers.put("furnaceTakeInput", inventory::handleFurnaceTakeInput);
        handlers.put("furnaceTakeFuel", inventory::handleFurnaceTakeFuel);
        handlers.put("closeFurnace", inventory::handleCloseFurnace);
        handlers.put("consume", inventory::handleConsume);
        handlers.put("toss", inventory::handleToss);
        handlers.put("getInventory", inventory::handleGetInventory);
        handlers.put("brew", inventory::handleBrew);
        handlers.put("enchant", inventory::handleEnchant);

        // World
        WorldHandler world = new WorldHandler();
        handlers.put("getEntities", world::handleGetEntities);
        handlers.put("getTime", world::handleGetTime);
        handlers.put("getDimension", world::handleGetDimension);
        handlers.put("getBiome", world::handleGetBiome);
        handlers.put("getWeather", world::handleGetWeather);
        handlers.put("getPlayers", world::handleGetPlayers);
        handlers.put("respawn", world::handleRespawn);

        // Chat
        ChatHandler chat = new ChatHandler();
        handlers.put("chat", chat::handleChat);

        // Meta
        handlers.put("ping", (params, client) -> {
            JsonObject result = new JsonObject();
            result.addProperty("pong", System.currentTimeMillis());
            return result;
        });

        handlers.put("getStatus", (params, client) -> {
            JsonObject result = new JsonObject();
            AiriMcBridge bridge = AiriMcBridge.getInstance();
            if (bridge != null) {
                result.addProperty("bridgeVersion", bridge.getBridgeVersion());
                result.addProperty("bridgeBuildTimestamp", bridge.getBridgeBuildTimestamp());
                result.addProperty("remoteMovementActive", bridge.getRemoteMovementController().isActive());
                result.addProperty("remoteMovementMode", bridge.getRemoteMovementController().getMovementMode());
            }
            if (client.player != null) {
                result.addProperty("connected", true);
                result.addProperty("username", client.player.getName().getString());
                result.addProperty("health", client.player.getHealth());
                result.addProperty("food", client.player.getHungerManager().getFoodLevel());
            } else {
                result.addProperty("connected", false);
            }
            JsonArray supportedCommands = new JsonArray();
            for (String commandName : getSupportedCommandsSnapshot()) {
                supportedCommands.add(commandName);
            }
            result.add("supportedCommands", supportedCommands);
            result.addProperty("capabilitiesHash", getCapabilitiesHash());
            return result;
        });
    }

    public void route(BridgeServer.WsConnection conn, JsonObject message, BridgeServer server) {
        String id = message.has("id") ? message.get("id").getAsString() : "unknown";
        String command = message.has("command") ? message.get("command").getAsString() : null;
        JsonObject params = message.has("params") ? message.getAsJsonObject("params") : new JsonObject();

        if (command == null) {
            server.sendError(conn, id, "Missing 'command' field");
            return;
        }

        CommandHandler handler = handlers.get(command);
        if (handler == null) {
            server.sendError(conn, id, "Unknown command: " + command);
            return;
        }

        MinecraftClient client = MinecraftClient.getInstance();

        if (asyncCommands.contains(command)) {
            // Async commands manage their own render-thread dispatching.
            // Run them on a daemon thread so they can block (e.g. waiting
            // for mining to complete) without deadlocking the render thread.
            Thread worker = new Thread(() -> {
                try {
                    JsonObject result = handler.handle(params, client);
                    server.sendResponse(conn, id, result);
                } catch (Exception e) {
                    AiriMcBridge.LOGGER.error("[AIRI] Async command '{}' failed", command, e);
                    server.sendError(conn, id, e.getMessage());
                }
            }, "AIRI-Async-" + command);
            worker.setDaemon(true);
            worker.start();
        } else {
            // Execute on main thread (client tick thread) for thread safety
            client.execute(() -> {
                try {
                    JsonObject result = handler.handle(params, client);
                    server.sendResponse(conn, id, result);
                } catch (Exception e) {
                    AiriMcBridge.LOGGER.error("[AIRI] Command '{}' failed", command, e);
                    server.sendError(conn, id, e.getMessage());
                }
            });
        }
    }
}

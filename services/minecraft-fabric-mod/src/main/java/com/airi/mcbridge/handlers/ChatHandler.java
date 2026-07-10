package com.airi.mcbridge.handlers;

import com.airi.mcbridge.AiriMcBridge;
import com.google.gson.JsonObject;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;

public class ChatHandler {

    /**
     * Send a chat message or command.
     * Params: { message: string }
     */
    public JsonObject handleChat(JsonObject params, MinecraftClient client) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);
        String message = params.get("message").getAsString();

        if (message.startsWith("/")) {
            // Send as command
            player.networkHandler.sendChatCommand(message.substring(1));
        } else {
            // Send as chat message
            player.networkHandler.sendChatMessage(message);
        }

        JsonObject result = new JsonObject();
        result.addProperty("status", "ok");
        result.addProperty("message", message);
        return result;
    }

    private ClientPlayerEntity requirePlayer(MinecraftClient client) throws Exception {
        if (client.player == null) throw new IllegalStateException("Player not in world");
        return client.player;
    }
}

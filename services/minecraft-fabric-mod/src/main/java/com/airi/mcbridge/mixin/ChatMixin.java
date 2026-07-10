package com.airi.mcbridge.mixin;

import com.airi.mcbridge.AiriMcBridge;
import com.google.gson.JsonObject;
import net.minecraft.client.network.ClientPlayNetworkHandler;
import net.minecraft.network.packet.s2c.play.GameMessageS2CPacket;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(ClientPlayNetworkHandler.class)
public class ChatMixin {

    @Inject(method = "onGameMessage", at = @At("HEAD"))
    private void onChatMessage(GameMessageS2CPacket packet, CallbackInfo ci) {
        try {
            String message = packet.content().getString();

            // Parse chat messages in format "<username> message"
            String username = "";
            String chatMessage = message;

            if (message.startsWith("<") && message.contains(">")) {
                int closeIndex = message.indexOf('>');
                username = message.substring(1, closeIndex);
                chatMessage = message.substring(closeIndex + 2).trim();
            }

            JsonObject data = new JsonObject();
            data.addProperty("raw", message);
            data.addProperty("username", username);
            data.addProperty("message", chatMessage);

            AiriMcBridge bridge = AiriMcBridge.getInstance();
            if (bridge != null && bridge.getBridgeServer() != null) {
                bridge.getBridgeServer().broadcastEvent("event:chat", data.toString());
            }
        } catch (Exception e) {
            AiriMcBridge.LOGGER.error("[AIRI] Failed to process chat message", e);
        }
    }
}

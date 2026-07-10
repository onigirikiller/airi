package com.airi.mcbridge;

import com.airi.mcbridge.state.StateEmitter;
import com.airi.mcbridge.movement.RemoteMovementController;
import com.airi.mcbridge.util.QuickPlayWorldResolver;
import com.airi.mcbridge.ws.BridgeServer;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.minecraft.client.MinecraftClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Optional;

public class AiriMcBridge implements ClientModInitializer {
    public static final String MOD_ID = "airi-mcbridge";
    public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);
    private static final int AUTO_REJOIN_GRACE_TICKS = 30 * 20;

    private static AiriMcBridge instance;
    private BridgeServer bridgeServer;
    private StateEmitter stateEmitter;
    private RemoteMovementController remoteMovementController;
    private boolean connected = false;
    private String bridgeVersion = "unknown";
    private String bridgeBuildTimestamp = "unknown";
    private int ticksSinceClientBoot = 0;
    private boolean autoRejoinAttempted = false;
    private boolean hasJoinedThisSession = false;

    public static AiriMcBridge getInstance() {
        return instance;
    }

    public BridgeServer getBridgeServer() {
        return bridgeServer;
    }

    public String getBridgeVersion() {
        return bridgeVersion;
    }

    public String getBridgeBuildTimestamp() {
        return bridgeBuildTimestamp;
    }

    public RemoteMovementController getRemoteMovementController() {
        return remoteMovementController;
    }

    @Override
    public void onInitializeClient() {
        instance = this;
        loadBuildMetadata();
        LOGGER.info("[AIRI] Initializing MC Bridge mod version={} build={}", bridgeVersion, bridgeBuildTimestamp);
        LOGGER.info("[AIRI][VERIFY-FIX-20260711] auto-rejoin-after-manual-exit fix loaded");

        bridgeServer = new BridgeServer(8089);
        stateEmitter = new StateEmitter(bridgeServer);
        remoteMovementController = new RemoteMovementController(bridgeServer);

        // Start WebSocket server
        bridgeServer.start();

        // Register tick event for state emission
        ClientTickEvents.END_CLIENT_TICK.register(client -> {
            ticksSinceClientBoot++;

            if (client.player != null && connected) {
                remoteMovementController.tick(client);
                stateEmitter.tick(client);
            }

            maybeRecoverSingleplayerWorld(client);
        });

        // Track join/leave
        ClientPlayConnectionEvents.JOIN.register((handler, sender, client) -> {
            connected = true;
            hasJoinedThisSession = true;
            LOGGER.info("[AIRI] Player joined world, bridge active");
            bridgeServer.broadcastEvent("event:spawn", "{}");
        });

        ClientPlayConnectionEvents.DISCONNECT.register((handler, client) -> {
            connected = false;
            LOGGER.info("[AIRI] Player disconnected");
            bridgeServer.broadcastEvent("event:disconnect", "{}");
        });

        // Cleanup on client stop
        ClientLifecycleEvents.CLIENT_STOPPING.register(client -> {
            LOGGER.info("[AIRI] Shutting down bridge server");
            bridgeServer.stop();
        });

        LOGGER.info("[AIRI] MC Bridge mod initialized, WebSocket on :8089 version={} build={}", bridgeVersion, bridgeBuildTimestamp);
    }

    private void maybeRecoverSingleplayerWorld(MinecraftClient client) {
        if (client.player != null || connected || autoRejoinAttempted || hasJoinedThisSession
                || ticksSinceClientBoot < AUTO_REJOIN_GRACE_TICKS) {
            return;
        }

        if (client.isIntegratedServerRunning() || client.getServer() != null) {
            return;
        }

        Optional<String> quickPlayWorld = QuickPlayWorldResolver.resolveSingleplayerWorld(getMinecraftDirectory());
        if (quickPlayWorld.isEmpty()) {
            return;
        }

        autoRejoinAttempted = true;
        String worldName = quickPlayWorld.get();
        LOGGER.warn("[AIRI] Minecraft client stayed out of world after relaunch; reopening quick-play singleplayer world '{}'", worldName);
        client.createIntegratedServerLoader().start(worldName, () -> autoRejoinAttempted = false);
    }

    private Path getMinecraftDirectory() {
        String runDirectory = System.getProperty("user.dir");
        if (runDirectory != null && !runDirectory.isBlank()) {
            return Paths.get(runDirectory);
        }

        return Paths.get(".");
    }

    private void loadBuildMetadata() {
        try (InputStream stream = AiriMcBridge.class.getClassLoader().getResourceAsStream("airi-mcbridge-build.json")) {
            if (stream == null) {
                LOGGER.warn("[AIRI] Build metadata resource not found");
                return;
            }

            JsonObject buildInfo = JsonParser.parseReader(new InputStreamReader(stream, StandardCharsets.UTF_8)).getAsJsonObject();
            if (buildInfo.has("version")) {
                bridgeVersion = buildInfo.get("version").getAsString();
            }
            if (buildInfo.has("buildTimestamp")) {
                bridgeBuildTimestamp = buildInfo.get("buildTimestamp").getAsString();
            }
        } catch (Exception error) {
            LOGGER.warn("[AIRI] Failed to load build metadata", error);
        }
    }
}

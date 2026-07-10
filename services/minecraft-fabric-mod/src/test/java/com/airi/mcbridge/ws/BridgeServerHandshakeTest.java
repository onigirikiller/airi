package com.airi.mcbridge.ws;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertTrue;

class BridgeServerHandshakeTest {
    @Test
    void acceptsStandardWebSocketHandshake() throws Exception {
        int port = reservePort();
        BridgeServer server = new BridgeServer(port);
        server.start();

        try {
            waitForServer(port);

            CompletableFuture<Void> connected = new CompletableFuture<>();
            WebSocket socket = HttpClient.newHttpClient()
                    .newWebSocketBuilder()
                    .connectTimeout(Duration.ofSeconds(5))
                    .buildAsync(URI.create("ws://127.0.0.1:" + port), new WebSocket.Listener() {
                        @Override
                        public void onOpen(WebSocket webSocket) {
                            connected.complete(null);
                            WebSocket.Listener.super.onOpen(webSocket);
                        }
                    })
                    .get(5, TimeUnit.SECONDS);

            connected.get(5, TimeUnit.SECONDS);
            assertTrue(socket.isOutputClosed() == false, "WebSocket should remain open after handshake");

            socket.sendClose(WebSocket.NORMAL_CLOSURE, "bye").get(5, TimeUnit.SECONDS);
        } finally {
            server.stop();
        }
    }

    private static int reservePort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }

    private static void waitForServer(int port) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (System.nanoTime() < deadline) {
            try (java.net.Socket ignored = new java.net.Socket("127.0.0.1", port)) {
                return;
            } catch (IOException ignored) {
                Thread.sleep(50);
            }
        }

        throw new IllegalStateException("BridgeServer did not start listening in time");
    }
}

package com.airi.mcbridge.ws;

import com.airi.mcbridge.AiriMcBridge;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.*;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Lightweight WebSocket server using Java standard library only.
 * No Netty dependency required.
 */
public class BridgeServer {
    private static final String WEBSOCKET_ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private final int port;
    private final Set<WsConnection> clients = ConcurrentHashMap.newKeySet();
    private final MessageRouter router;
    private ServerSocket serverSocket;
    private volatile boolean running = false;
    private Thread acceptThread;

    public BridgeServer(int port) {
        this.port = port;
        this.router = new MessageRouter();
    }

    public MessageRouter getRouter() {
        return router;
    }

    public void start() {
        running = true;
        acceptThread = new Thread(() -> {
            try {
                serverSocket = new ServerSocket(port);
                AiriMcBridge.LOGGER.info("[AIRI] WebSocket server started on port {}", port);

                while (running) {
                    try {
                        Socket socket = serverSocket.accept();
                        new Thread(() -> handleNewConnection(socket), "AIRI-WS-Client").start();
                    } catch (IOException e) {
                        if (running) {
                            AiriMcBridge.LOGGER.error("[AIRI] Accept error", e);
                        }
                    }
                }
            } catch (IOException e) {
                AiriMcBridge.LOGGER.error("[AIRI] Failed to start WebSocket server", e);
            }
        }, "AIRI-WebSocket-Server");
        acceptThread.setDaemon(true);
        acceptThread.start();
    }

    public void stop() {
        running = false;
        try {
            if (serverSocket != null) serverSocket.close();
        } catch (IOException ignored) {}
        for (WsConnection conn : clients) {
            conn.close();
        }
        clients.clear();
    }

    public void broadcastEvent(String type, String data) {
        JsonObject msg = new JsonObject();
        msg.addProperty("type", type);
        try {
            msg.add("data", JsonParser.parseString(data));
        } catch (Exception e) {
            msg.addProperty("data", data);
        }
        String json = msg.toString();
        for (WsConnection conn : clients) {
            conn.send(json);
        }
    }

    public void sendResponse(WsConnection conn, String id, JsonObject result) {
        JsonObject msg = new JsonObject();
        msg.addProperty("type", "response");
        msg.addProperty("id", id);
        msg.add("data", result);
        conn.send(msg.toString());
    }

    public void sendError(WsConnection conn, String id, String error) {
        JsonObject msg = new JsonObject();
        msg.addProperty("type", "error");
        msg.addProperty("id", id);
        msg.addProperty("error", error);
        conn.send(msg.toString());
    }

    private void handleNewConnection(Socket socket) {
        try {
            InputStream rawIn = socket.getInputStream();
            OutputStream out = socket.getOutputStream();

            // Read HTTP headers line by line (without Scanner to avoid buffering issues)
            StringBuilder headerBuilder = new StringBuilder();
            int prev = 0, curr;
            int crlfCount = 0;
            while ((curr = rawIn.read()) != -1) {
                headerBuilder.append((char) curr);
                if (prev == '\r' && curr == '\n') {
                    crlfCount++;
                } else if (curr != '\r') {
                    crlfCount = 0;
                }
                if (crlfCount == 2) break; // \r\n\r\n found
                prev = curr;
            }

            String request = headerBuilder.toString();

            // Extract WebSocket key
            String wsKey = null;
            for (String line : request.split("\r\n")) {
                if (line.toLowerCase().startsWith("sec-websocket-key:")) {
                    wsKey = line.substring("sec-websocket-key:".length()).trim();
                    break;
                }
            }

            if (wsKey == null) {
                socket.close();
                return;
            }

            String acceptKey = Base64.getEncoder().encodeToString(
                MessageDigest.getInstance("SHA-1").digest(
                    (wsKey + WEBSOCKET_ACCEPT_GUID).getBytes(StandardCharsets.UTF_8)
                )
            );

            // Send upgrade response
            String response = "HTTP/1.1 101 Switching Protocols\r\n"
                + "Upgrade: websocket\r\n"
                + "Connection: Upgrade\r\n"
                + "Sec-WebSocket-Accept: " + acceptKey + "\r\n"
                + "\r\n";
            out.write(response.getBytes(StandardCharsets.UTF_8));
            out.flush();

            WsConnection conn = new WsConnection(socket, rawIn, out);
            clients.add(conn);
            AiriMcBridge.LOGGER.info("[AIRI] Client connected: {}", socket.getRemoteSocketAddress());

            // Read loop
            while (running && !socket.isClosed()) {
                String message = conn.readFrame();
                if (message == null) break;

                try {
                    JsonObject json = JsonParser.parseString(message).getAsJsonObject();
                    router.route(conn, json, this);
                } catch (Exception e) {
                    AiriMcBridge.LOGGER.error("[AIRI] Failed to process message: {}", message, e);
                    sendError(conn, "unknown", "Invalid JSON: " + e.getMessage());
                }
            }
        } catch (Exception e) {
            if (running) {
                AiriMcBridge.LOGGER.debug("[AIRI] Client connection ended: {}", e.getMessage());
            }
        } finally {
            try { socket.close(); } catch (IOException ignored) {}
            // Remove from clients set (find matching connection)
            clients.removeIf(c -> c.getSocket() == socket);
            AiriMcBridge.LOGGER.info("[AIRI] Client disconnected");
        }
    }

    /**
     * Represents a single WebSocket connection with frame read/write support.
     */
    public static class WsConnection {
        private final Socket socket;
        private final InputStream in;
        private final OutputStream out;
        private final Object writeLock = new Object();

        public WsConnection(Socket socket, InputStream in, OutputStream out) {
            this.socket = socket;
            this.in = in;
            this.out = out;
        }

        public Socket getSocket() {
            return socket;
        }

        /**
         * Read a WebSocket text frame. Returns null on close/error.
         */
        public String readFrame() throws IOException {
            int firstByte = in.read();
            if (firstByte == -1) return null;

            int opcode = firstByte & 0x0F;
            if (opcode == 0x8) return null; // Close frame

            int secondByte = in.read();
            if (secondByte == -1) return null;

            boolean masked = (secondByte & 0x80) != 0;
            long payloadLength = secondByte & 0x7F;

            if (payloadLength == 126) {
                payloadLength = ((in.read() & 0xFF) << 8) | (in.read() & 0xFF);
            } else if (payloadLength == 127) {
                payloadLength = 0;
                for (int i = 0; i < 8; i++) {
                    payloadLength = (payloadLength << 8) | (in.read() & 0xFF);
                }
            }

            byte[] maskKey = null;
            if (masked) {
                maskKey = new byte[4];
                in.readNBytes(maskKey, 0, 4);
            }

            byte[] payload = in.readNBytes((int) payloadLength);

            if (masked && maskKey != null) {
                for (int i = 0; i < payload.length; i++) {
                    payload[i] = (byte) (payload[i] ^ maskKey[i % 4]);
                }
            }

            if (opcode == 0x9) {
                // Ping - respond with pong
                sendRawFrame(0xA, payload);
                return readFrame(); // Continue reading
            }

            return new String(payload, StandardCharsets.UTF_8);
        }

        /**
         * Send a text frame.
         */
        public void send(String message) {
            try {
                byte[] payload = message.getBytes(StandardCharsets.UTF_8);
                sendRawFrame(0x1, payload);
            } catch (IOException e) {
                AiriMcBridge.LOGGER.debug("[AIRI] Failed to send message: {}", e.getMessage());
            }
        }

        private void sendRawFrame(int opcode, byte[] payload) throws IOException {
            synchronized (writeLock) {
                out.write(0x80 | opcode); // FIN + opcode

                if (payload.length < 126) {
                    out.write(payload.length);
                } else if (payload.length < 65536) {
                    out.write(126);
                    out.write((payload.length >> 8) & 0xFF);
                    out.write(payload.length & 0xFF);
                } else {
                    out.write(127);
                    for (int i = 7; i >= 0; i--) {
                        out.write((int) ((payload.length >> (8 * i)) & 0xFF));
                    }
                }

                out.write(payload);
                out.flush();
            }
        }

        public void close() {
            try {
                sendRawFrame(0x8, new byte[0]);
                socket.close();
            } catch (IOException ignored) {}
        }
    }
}

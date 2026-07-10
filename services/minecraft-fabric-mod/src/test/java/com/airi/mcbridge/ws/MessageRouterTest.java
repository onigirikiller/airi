package com.airi.mcbridge.ws;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class MessageRouterTest {
    @Test
    void exposesSupportedCommandsForCapabilityHandshake() {
        MessageRouter router = new MessageRouter();

        assertTrue(router.getSupportedCommandsSnapshot().contains("compactInventory"));
        assertTrue(router.getSupportedCommandsSnapshot().contains("craft"));
        assertTrue(router.getSupportedCommandsSnapshot().contains("getStatus"));
        assertFalse(router.getSupportedCommandsSnapshot().isEmpty());
        assertNotNull(router.getCapabilitiesHash());
        assertFalse(router.getCapabilitiesHash().isBlank());
    }
}

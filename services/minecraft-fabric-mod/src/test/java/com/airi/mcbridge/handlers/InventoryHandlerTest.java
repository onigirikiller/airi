package com.airi.mcbridge.handlers;

import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class InventoryHandlerTest {
    @Test
    void prefersTheNearestHorizontalFaceForSideOnCraftingTableInteraction() {
        List<Direction> faces = InventoryHandler.getPreferredInteractionFaces(
            new Vec3d(4.0D, 65.62D, 0.0D),
            new BlockPos(0, 64, 0)
        );

        assertEquals(Direction.EAST, faces.get(0));
        assertEquals(Direction.UP, faces.get(1));
    }

    @Test
    void prefersTheTopFaceWhenThePlayerIsWellAboveTheBlock() {
        List<Direction> faces = InventoryHandler.getPreferredInteractionFaces(
            new Vec3d(0.5D, 68.0D, 0.5D),
            new BlockPos(0, 64, 0)
        );

        assertEquals(Direction.UP, faces.get(0));
        assertTrue(faces.contains(Direction.NORTH));
        assertTrue(faces.contains(Direction.SOUTH));
        assertTrue(faces.contains(Direction.EAST));
        assertTrue(faces.contains(Direction.WEST));
        assertEquals(6, faces.size());
    }

    @Test
    void prefersTheBottomFaceWhenThePlayerIsWellBelowTheBlock() {
        List<Direction> faces = InventoryHandler.getPreferredInteractionFaces(
            new Vec3d(0.5D, 63.0D, 0.5D),
            new BlockPos(0, 64, 0)
        );

        assertEquals(Direction.DOWN, faces.get(0));
        assertTrue(faces.contains(Direction.UP));
        assertTrue(faces.contains(Direction.NORTH));
        assertTrue(faces.contains(Direction.SOUTH));
        assertTrue(faces.contains(Direction.EAST));
        assertTrue(faces.contains(Direction.WEST));
        assertEquals(6, faces.size());
    }

    @Test
    void mapsRawInventorySlotsToPlayerScreenSlotsForHotbarArmorAndOffhand() {
        assertEquals(36, InventoryHandler.rawInventoryToPlayerScreenSlot(0));
        assertEquals(44, InventoryHandler.rawInventoryToPlayerScreenSlot(8));
        assertEquals(9, InventoryHandler.rawInventoryToPlayerScreenSlot(9));
        assertEquals(35, InventoryHandler.rawInventoryToPlayerScreenSlot(35));
        assertEquals(8, InventoryHandler.rawInventoryToPlayerScreenSlot(36));
        assertEquals(7, InventoryHandler.rawInventoryToPlayerScreenSlot(37));
        assertEquals(6, InventoryHandler.rawInventoryToPlayerScreenSlot(38));
        assertEquals(5, InventoryHandler.rawInventoryToPlayerScreenSlot(39));
        assertEquals(45, InventoryHandler.rawInventoryToPlayerScreenSlot(40));
    }

    @Test
    void resolvesEquipDestinationsToCanonicalRawSlots() {
        assertEquals(36, InventoryHandler.destinationSlotToRawInventorySlot("feet"));
        assertEquals(37, InventoryHandler.destinationSlotToRawInventorySlot("legs"));
        assertEquals(38, InventoryHandler.destinationSlotToRawInventorySlot("torso"));
        assertEquals(39, InventoryHandler.destinationSlotToRawInventorySlot("head"));
        assertEquals(40, InventoryHandler.destinationSlotToRawInventorySlot("off-hand"));
        assertEquals(40, InventoryHandler.destinationSlotToRawInventorySlot("offhand"));
        assertEquals(-1, InventoryHandler.destinationSlotToRawInventorySlot("hand"));
    }
}

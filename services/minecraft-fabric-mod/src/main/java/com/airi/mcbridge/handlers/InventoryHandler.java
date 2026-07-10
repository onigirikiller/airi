package com.airi.mcbridge.handlers;

import com.airi.mcbridge.util.Serializers;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.block.Blocks;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.screen.ingame.InventoryScreen;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.entity.EquipmentSlot;
import net.minecraft.item.ItemStack;
import net.minecraft.recipe.Ingredient;
import net.minecraft.recipe.RecipeEntry;
import net.minecraft.recipe.CraftingRecipe;
import net.minecraft.recipe.RecipeType;
import net.minecraft.recipe.ShapedRecipe;
import net.minecraft.registry.Registries;
import net.minecraft.inventory.CraftingResultInventory;
import net.minecraft.inventory.RecipeInputInventory;
import net.minecraft.screen.AbstractFurnaceScreenHandler;
import net.minecraft.screen.CraftingScreenHandler;
import net.minecraft.screen.PlayerScreenHandler;
import net.minecraft.screen.ScreenHandler;
import net.minecraft.screen.slot.SlotActionType;
import net.minecraft.util.Hand;
import net.minecraft.util.collection.DefaultedList;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

public class InventoryHandler {
    private static final int CRAFTING_TABLE_OPEN_ATTEMPTS = 30;
    private static final long CRAFTING_TABLE_OPEN_DELAY_MS = 100L;
    private static final int FURNACE_OPEN_ATTEMPTS = 8;
    private static final long FURNACE_OPEN_DELAY_MS = 75L;

    /**
     * Execute a task on the Minecraft render/client thread and block until it completes.
     * This is needed when a handler runs on a daemon thread (asyncCommands) but needs
     * to interact with client-side state like slot clicks or block interactions.
     */
    private static <T> T runOnRenderThread(MinecraftClient client, Callable<T> task) throws Exception {
        if (client.isOnThread()) {
            return task.call();
        }
        CompletableFuture<T> future = new CompletableFuture<>();
        client.execute(() -> {
            try {
                future.complete(task.call());
            } catch (Exception e) {
                future.completeExceptionally(e);
            }
        });
        return future.get(30, TimeUnit.SECONDS);
    }

    private static void runOnRenderThread(MinecraftClient client, Runnable task) throws Exception {
        runOnRenderThread(client, () -> { task.run(); return null; });
    }

    private static final class CraftRecipeMatch {
        private final RecipeEntry<CraftingRecipe> entry;
        private final CraftingRecipe recipe;
        private final String outputName;
        private final int outputCount;
        private final int missingIngredients;
        private final boolean needs3x3;
        private final Ingredient[] gridMap;

        private CraftRecipeMatch(
            RecipeEntry<CraftingRecipe> entry,
            CraftingRecipe recipe,
            String outputName,
            int outputCount,
            int missingIngredients,
            boolean needs3x3,
            Ingredient[] gridMap
        ) {
            this.entry = entry;
            this.recipe = recipe;
            this.outputName = outputName;
            this.outputCount = outputCount;
            this.missingIngredients = missingIngredients;
            this.needs3x3 = needs3x3;
            this.gridMap = gridMap;
        }
    }

    private String normalizeItemQuery(String itemName) {
        String trimmed = itemName == null ? "" : itemName.trim();
        if (trimmed.startsWith("minecraft:")) {
            return trimmed.substring("minecraft:".length());
        }
        return trimmed;
    }

    private boolean itemIdMatchesQuery(String itemId, String itemQuery) {
        String normalizedId = normalizeItemQuery(itemId);
        String normalizedQuery = normalizeItemQuery(itemQuery);
        return normalizedId.equals(normalizedQuery);
    }

    private JsonArray serializeInventoryItems(ClientPlayerEntity player) {
        JsonArray items = new JsonArray();
        for (int i = 0; i < player.getInventory().size(); i++) {
            ItemStack stack = player.getInventory().getStack(i);
            if (!stack.isEmpty()) {
                items.add(Serializers.itemStackToJson(stack, i));
            }
        }
        return items;
    }

    private JsonArray serializeArmorItems(ClientPlayerEntity player) {
        JsonArray armor = new JsonArray();
        for (int i = 0; i < player.getInventory().armor.size(); i++) {
            ItemStack armorStack = player.getInventory().armor.get(i);
            if (!armorStack.isEmpty()) {
                armor.add(Serializers.itemStackToJson(armorStack, 36 + i));
            }
        }
        return armor;
    }

    private JsonObject serializeFullInventoryState(ClientPlayerEntity player) {
        JsonObject result = new JsonObject();
        result.addProperty("status", "ok");
        result.add("items", serializeInventoryItems(player));
        result.addProperty("selectedSlot", player.getInventory().selectedSlot);
        result.add("armor", serializeArmorItems(player));

        ItemStack offhand = player.getOffHandStack();
        if (!offhand.isEmpty()) {
            result.add("offhand", Serializers.itemStackToJson(offhand, 40));
        }

        return result;
    }

    private int countInventoryItems(ClientPlayerEntity player, String itemId) {
        int total = 0;
        for (int i = 0; i < player.getInventory().size(); i++) {
            ItemStack stack = player.getInventory().getStack(i);
            if (!stack.isEmpty() && Registries.ITEM.getId(stack.getItem()).toString().equals(itemId)) {
                total += stack.getCount();
            }
        }
        return total;
    }

    private void refreshCraftingScreenState(ClientPlayerEntity player) {
        player.playerScreenHandler.sendContentUpdates();
        if (player.currentScreenHandler != null) {
            player.currentScreenHandler.sendContentUpdates();
        }
    }

    private PlayerScreenHandler requirePlayerInventoryHandler(ClientPlayerEntity player) {
        if (player.currentScreenHandler != player.playerScreenHandler) {
            player.closeHandledScreen();
        }
        return player.playerScreenHandler;
    }

    static int rawInventoryToPlayerScreenSlot(int rawSlot) {
        if (rawSlot < 0 || rawSlot > 40) {
            throw new IllegalArgumentException("Unsupported raw inventory slot: " + rawSlot);
        }
        if (rawSlot < 9) {
            return 36 + rawSlot;
        }
        if (rawSlot < 36) {
            return rawSlot;
        }
        return switch (rawSlot) {
            case 36 -> 8;
            case 37 -> 7;
            case 38 -> 6;
            case 39 -> 5;
            case 40 -> 45;
            default -> throw new IllegalArgumentException("Unsupported raw inventory slot: " + rawSlot);
        };
    }

    static int destinationSlotToRawInventorySlot(String slot) {
        return switch (slot) {
            case "feet" -> 36;
            case "legs" -> 37;
            case "torso", "chest" -> 38;
            case "head" -> 39;
            case "off-hand", "offhand" -> 40;
            default -> -1;
        };
    }

    private void swapPlayerInventorySlots(
        MinecraftClient client,
        ClientPlayerEntity player,
        int fromRawSlot,
        int toRawSlot
    ) {
        if (fromRawSlot == toRawSlot) {
            return;
        }

        PlayerScreenHandler handler = requirePlayerInventoryHandler(player);
        int fromScreenSlot = rawInventoryToPlayerScreenSlot(fromRawSlot);
        int toScreenSlot = rawInventoryToPlayerScreenSlot(toRawSlot);
        clearCursor(handler, client, player);
        client.interactionManager.clickSlot(handler.syncId, fromScreenSlot, 0, SlotActionType.PICKUP, player);
        client.interactionManager.clickSlot(handler.syncId, toScreenSlot, 0, SlotActionType.PICKUP, player);
        client.interactionManager.clickSlot(handler.syncId, fromScreenSlot, 0, SlotActionType.PICKUP, player);
        clearCursor(handler, client, player);
        refreshCraftingScreenState(player);
    }

    private boolean mergePlayerInventoryStacks(
        MinecraftClient client,
        ClientPlayerEntity player,
        int fromRawSlot,
        int toRawSlot
    ) {
        if (fromRawSlot == toRawSlot) {
            return false;
        }

        ItemStack fromStack = player.getInventory().getStack(fromRawSlot);
        ItemStack toStack = player.getInventory().getStack(toRawSlot);
        if (fromStack.isEmpty()
            || toStack.isEmpty()
            || !ItemStack.canCombine(fromStack, toStack)
            || toStack.getCount() >= toStack.getMaxCount()) {
            return false;
        }

        PlayerScreenHandler handler = requirePlayerInventoryHandler(player);
        int fromScreenSlot = rawInventoryToPlayerScreenSlot(fromRawSlot);
        int toScreenSlot = rawInventoryToPlayerScreenSlot(toRawSlot);
        clearCursor(handler, client, player);
        client.interactionManager.clickSlot(handler.syncId, fromScreenSlot, 0, SlotActionType.PICKUP, player);
        client.interactionManager.clickSlot(handler.syncId, toScreenSlot, 0, SlotActionType.PICKUP, player);
        if (!handler.getCursorStack().isEmpty()) {
            client.interactionManager.clickSlot(handler.syncId, fromScreenSlot, 0, SlotActionType.PICKUP, player);
        }
        clearCursor(handler, client, player);
        refreshCraftingScreenState(player);
        return true;
    }

    private void refreshCraftingResult(ScreenHandler handler, ClientPlayerEntity player) {
        if (handler instanceof PlayerScreenHandler playerHandler) {
            playerHandler.onContentChanged(playerHandler.getCraftingInput());
        } else if (handler instanceof CraftingScreenHandler craftingHandler) {
            craftingHandler.onContentChanged(craftingHandler.getSlot(1).inventory);
        }

        refreshCraftingResultClientSide(handler, player);

        refreshCraftingScreenState(player);
    }

    private void refreshCraftingResultClientSide(ScreenHandler handler, ClientPlayerEntity player) {
        if (!player.getWorld().isClient()) {
            return;
        }

        RecipeInputInventory craftingInput = null;
        if (handler instanceof PlayerScreenHandler playerHandler) {
            craftingInput = playerHandler.getCraftingInput();
        } else if (handler.getSlot(1).inventory instanceof RecipeInputInventory recipeInput) {
            craftingInput = recipeInput;
        }

        if (craftingInput == null) {
            return;
        }

        ItemStack craftedStack = ItemStack.EMPTY;
        RecipeEntry<CraftingRecipe> matchedRecipe = null;
        var recipeManager = player.getWorld().getRecipeManager();
        var matched = recipeManager.getFirstMatch(RecipeType.CRAFTING, craftingInput, player.getWorld());
        if (matched.isPresent()) {
            matchedRecipe = matched.get();
            ItemStack candidate = matchedRecipe.value().craft(craftingInput, player.getWorld().getRegistryManager());
            if (candidate.isItemEnabled(player.getWorld().getEnabledFeatures())) {
                craftedStack = candidate;
            }
        }

        if (handler.getSlot(0).inventory instanceof CraftingResultInventory resultInventory) {
            resultInventory.setLastRecipe(matchedRecipe);
            resultInventory.setStack(0, craftedStack);
        }
        handler.getSlot(0).setStack(craftedStack);
        handler.setPreviousTrackedSlot(0, craftedStack.copy());
    }

    private void waitForCraftingResult(ScreenHandler handler, ClientPlayerEntity player, int attempts, long delayMs)
        throws InterruptedException {
        for (int attempt = 0; attempt < attempts; attempt++) {
            if (!handler.getSlot(0).getStack().isEmpty()) {
                return;
            }

            Thread.sleep(delayMs);
            refreshCraftingResult(handler, player);
        }
    }

    private CraftingScreenHandler waitForCraftingTableScreen(
        ClientPlayerEntity player,
        int attempts,
        long delayMs
    ) throws InterruptedException {
        for (int attempt = 0; attempt < attempts; attempt++) {
            if (player.currentScreenHandler instanceof CraftingScreenHandler craftingHandler) {
                return craftingHandler;
            }

            Thread.sleep(delayMs);
            refreshCraftingScreenState(player);
        }

        return null;
    }

    static List<Direction> getPreferredInteractionFaces(Vec3d eyePos, BlockPos blockPos) {
        Vec3d center = Vec3d.ofCenter(blockPos);
        double dx = eyePos.x - center.x;
        double dy = eyePos.y - center.y;
        double dz = eyePos.z - center.z;

        List<Direction> orderedFaces = new ArrayList<>();
        Direction preferredFace;
        double horizontalMagnitude = Math.max(Math.abs(dx), Math.abs(dz));
        if (Math.abs(dy) > horizontalMagnitude + 0.25D) {
            preferredFace = dy >= 0.0D ? Direction.UP : Direction.DOWN;
        } else if (Math.abs(dx) >= Math.abs(dz)) {
            preferredFace = dx >= 0.0D ? Direction.EAST : Direction.WEST;
        } else {
            preferredFace = dz >= 0.0D ? Direction.SOUTH : Direction.NORTH;
        }

        orderedFaces.add(preferredFace);
        if (preferredFace != Direction.UP) {
            orderedFaces.add(Direction.UP);
        }

        Direction[] fallbackFaces = new Direction[] {
            Direction.NORTH,
            Direction.SOUTH,
            Direction.EAST,
            Direction.WEST,
            Direction.DOWN
        };
        for (Direction face : fallbackFaces) {
            if (!orderedFaces.contains(face)) {
                orderedFaces.add(face);
            }
        }

        return orderedFaces;
    }

    private List<BlockHitResult> buildBlockInteractionHitResults(ClientPlayerEntity player, BlockPos blockPos) {
        List<BlockHitResult> hitResults = new ArrayList<>();
        Vec3d center = Vec3d.ofCenter(blockPos);
        for (Direction face : getPreferredInteractionFaces(player.getEyePos(), blockPos)) {
            Vec3d hitVec = center.add(
                face.getOffsetX() * 0.49D,
                face.getOffsetY() * 0.49D,
                face.getOffsetZ() * 0.49D
            );
            hitResults.add(new BlockHitResult(hitVec, face, blockPos, false));
        }
        return hitResults;
    }

    private Ingredient[] buildGridMap(CraftingRecipe recipe, int maxGridSize) {
        DefaultedList<Ingredient> ingredients = recipe.getIngredients();
        Ingredient[] gridMap = new Ingredient[maxGridSize * maxGridSize];
        if (recipe instanceof ShapedRecipe shaped) {
            for (int row = 0; row < shaped.getHeight(); row++) {
                for (int col = 0; col < shaped.getWidth(); col++) {
                    int ingredientIdx = row * shaped.getWidth() + col;
                    if (ingredientIdx < ingredients.size()) {
                        int gridIdx = row * maxGridSize + col;
                        gridMap[gridIdx] = ingredients.get(ingredientIdx);
                    }
                }
            }
        } else {
            int idx = 0;
            for (Ingredient ingredient : ingredients) {
                if (!ingredient.isEmpty() && idx < gridMap.length) {
                    gridMap[idx] = ingredient;
                    idx++;
                }
            }
        }

        return gridMap;
    }

    private int countMissingIngredients(ClientPlayerEntity player, Ingredient[] gridMap) {
        int[] remainingCounts = new int[player.getInventory().size()];
        for (int i = 0; i < player.getInventory().size(); i++) {
            remainingCounts[i] = player.getInventory().getStack(i).getCount();
        }

        int missingIngredients = 0;
        for (Ingredient ingredient : gridMap) {
            if (ingredient == null || ingredient.isEmpty()) continue;

            boolean found = false;
            for (int i = 0; i < player.getInventory().size(); i++) {
                if (remainingCounts[i] <= 0) continue;
                ItemStack stack = player.getInventory().getStack(i);
                if (!stack.isEmpty() && ingredient.test(stack)) {
                    remainingCounts[i]--;
                    found = true;
                    break;
                }
            }

            if (!found) {
                missingIngredients++;
            }
        }

        return missingIngredients;
    }

    private CraftRecipeMatch selectCraftRecipeMatch(ClientPlayerEntity player, String itemName) {
        var recipeManager = player.getWorld().getRecipeManager();
        CraftRecipeMatch bestMatch = null;

        for (RecipeEntry<?> entry : recipeManager.values()) {
            if (!(entry.value() instanceof CraftingRecipe craftingRecipe)) continue;

            ItemStack output = craftingRecipe.getResult(player.getWorld().getRegistryManager());
            String outputId = Registries.ITEM.getId(output.getItem()).toString();
            if (!itemIdMatchesQuery(outputId, itemName)) continue;

            DefaultedList<Ingredient> ingredients = craftingRecipe.getIngredients();
            boolean isShaped = craftingRecipe instanceof ShapedRecipe;
            int gridWidth;
            int gridHeight;
            if (isShaped) {
                ShapedRecipe shaped = (ShapedRecipe) craftingRecipe;
                gridWidth = shaped.getWidth();
                gridHeight = shaped.getHeight();
            } else {
                gridWidth = ingredients.size() <= 4 ? 2 : 3;
                gridHeight = ingredients.size() <= 2 ? 1 : (ingredients.size() <= 4 ? 2 : 3);
            }

            boolean needs3x3 = (isShaped && (gridWidth > 2 || gridHeight > 2)) || ingredients.size() > 4;
            int maxGridSize = needs3x3 ? 3 : 2;
            Ingredient[] gridMap = buildGridMap(craftingRecipe, maxGridSize);
            int missingIngredients = countMissingIngredients(player, gridMap);

            @SuppressWarnings("unchecked")
            RecipeEntry<CraftingRecipe> matchedEntry = (RecipeEntry<CraftingRecipe>) entry;
            CraftRecipeMatch candidate = new CraftRecipeMatch(
                matchedEntry,
                craftingRecipe,
                outputId,
                output.getCount(),
                missingIngredients,
                needs3x3,
                gridMap
            );

            if (bestMatch == null || candidate.missingIngredients < bestMatch.missingIngredients) {
                bestMatch = candidate;
                if (candidate.missingIngredients == 0) {
                    break;
                }
            }
        }

        return bestMatch;
    }

    private String describeCraftingGrid(ScreenHandler handler, int gridSize) {
        List<String> gridEntries = new ArrayList<>();
        int slotCount = gridSize * gridSize;
        for (int i = 0; i < slotCount; i++) {
            int gridSlot = 1 + i;
            ItemStack stack = handler.getSlot(gridSlot).getStack();
            String stackId = stack.isEmpty() ? "empty" : Registries.ITEM.getId(stack.getItem()).toString() + "x" + stack.getCount();
            gridEntries.add(gridSlot + "=" + stackId);
        }

        return String.join(",", gridEntries);
    }

    /**
     * Disabled: clickRecipe (recipe-book autofill) is asynchronous — the server fills
     * the crafting grid via slot update packets that arrive at an unpredictable time.
     * No matter how long we wait, the response can arrive AFTER the manual fallback
     * has already placed items, doubling up items in wrong positions.
     * Always use manual slot placement instead, which is fully synchronous and reliable.
     */
    @SuppressWarnings("unused")
    private boolean tryFillCraftingGridFromRecipe(
        MinecraftClient client,
        ClientPlayerEntity player,
        ScreenHandler handler,
        RecipeEntry<CraftingRecipe> recipeEntry
    ) throws InterruptedException {
        return false;
    }

    private boolean openInventoryScreenForPlayerCrafting(MinecraftClient client, ClientPlayerEntity player)
        throws InterruptedException {
        if (client.currentScreen instanceof InventoryScreen && player.currentScreenHandler == player.playerScreenHandler) {
            return false;
        }

        client.setScreen(new InventoryScreen(player));
        Thread.sleep(150);
        refreshCraftingScreenState(player);
        return true;
    }


    /**
     * Equip an item to a slot.
     * Params: { item: string, slot: string (hand|head|chest|legs|feet|offhand) }
     */
    public JsonObject handleEquip(JsonObject params, MinecraftClient client) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);
        String itemName = params.get("item").getAsString();
        String slot = params.has("slot") ? params.get("slot").getAsString() : "hand";

        // Find item in inventory
        int foundSlot = -1;
        for (int i = 0; i < player.getInventory().size(); i++) {
            ItemStack stack = player.getInventory().getStack(i);
            if (!stack.isEmpty()) {
                String id = Registries.ITEM.getId(stack.getItem()).toString();
                if (id.contains(itemName)) {
                    foundSlot = i;
                    break;
                }
            }
        }

        if (foundSlot == -1) {
            throw new IllegalArgumentException("Item not found in inventory: " + itemName);
        }

        if ("hand".equals(slot)) {
            requirePlayerInventoryHandler(player);
            if (foundSlot < 9) {
                player.getInventory().selectedSlot = foundSlot;
            } else {
                client.interactionManager.clickSlot(
                    player.playerScreenHandler.syncId,
                    rawInventoryToPlayerScreenSlot(foundSlot), player.getInventory().selectedSlot,
                    SlotActionType.SWAP, player
                );
            }
        } else {
            int destinationRawSlot = destinationSlotToRawInventorySlot(slot);
            if (destinationRawSlot < 0) {
                throw new IllegalArgumentException("Unsupported equip slot: " + slot);
            }
            swapPlayerInventorySlots(client, player, foundSlot, destinationRawSlot);
        }

        refreshCraftingScreenState(player);
        JsonObject result = serializeFullInventoryState(player);
        result.addProperty("item", itemName);
        result.addProperty("slot", slot);
        return result;
    }

    /**
     * Select a hotbar slot without mutating the rest of the inventory.
     * Params: { slot: number }
     */
    public JsonObject handleSelectHotbarSlot(JsonObject params, MinecraftClient client) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);
        int slot = params.get("slot").getAsInt();
        if (slot < 0 || slot > 8) {
            throw new IllegalArgumentException("Hotbar slot must be between 0 and 8");
        }

        player.getInventory().selectedSlot = slot;
        refreshCraftingScreenState(player);
        JsonObject result = serializeFullInventoryState(player);
        result.addProperty("selectedSlot", slot);
        return result;
    }

    /**
     * Swap two raw inventory slots using the player inventory handler.
     * Params: { fromSlot: number, toSlot: number }
     */
    public JsonObject handleSwapInventorySlots(JsonObject params, MinecraftClient client) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);
        int fromSlot = params.get("fromSlot").getAsInt();
        int toSlot = params.get("toSlot").getAsInt();
        swapPlayerInventorySlots(client, player, fromSlot, toSlot);

        JsonObject result = serializeFullInventoryState(player);
        result.addProperty("fromSlot", fromSlot);
        result.addProperty("toSlot", toSlot);
        return result;
    }

    /**
     * Merge partial carry-inventory stacks to reduce fragmentation.
     * Params: { maxOperations?: number }
     */
    public JsonObject handleCompactInventory(JsonObject params, MinecraftClient client) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);
        int maxOperations = params.has("maxOperations") ? Math.max(1, params.get("maxOperations").getAsInt()) : 12;
        int mergedStacks = 0;

        outer:
        for (int targetRawSlot = 9; targetRawSlot < 36; targetRawSlot++) {
            ItemStack targetStack = player.getInventory().getStack(targetRawSlot);
            if (targetStack.isEmpty() || targetStack.getCount() >= targetStack.getMaxCount()) {
                continue;
            }

            for (int sourceRawSlot = 0; sourceRawSlot < 36; sourceRawSlot++) {
                if (sourceRawSlot == targetRawSlot) {
                    continue;
                }
                if (mergePlayerInventoryStacks(client, player, sourceRawSlot, targetRawSlot)) {
                    mergedStacks++;
                    if (mergedStacks >= maxOperations) {
                        break outer;
                    }

                    targetStack = player.getInventory().getStack(targetRawSlot);
                    if (targetStack.isEmpty() || targetStack.getCount() >= targetStack.getMaxCount()) {
                        break;
                    }
                }
            }
        }

        JsonObject result = serializeFullInventoryState(player);
        result.addProperty("mergedStacks", mergedStacks);
        return result;
    }

    /**
     * Craft an item using 2x2 player grid or 3x3 crafting table.
     * Params: { item: string, count: number?, craftingTable: {x,y,z}? }
     *
     * THREADING: This handler runs on a daemon thread (asyncCommands) so that
     * getCraftingHandler can sleep while waiting for the crafting table screen
     * without deadlocking the render thread. All render-thread operations
     * (slot clicks, screen changes, etc.) are dispatched via runOnRenderThread.
     */
    public JsonObject handleCraft(JsonObject params, MinecraftClient client) throws Exception {
        // Phase 1: Parse params and select recipe (render thread for inventory/world access)
        String itemName = params.get("item").getAsString();
        int count = params.has("count") ? params.get("count").getAsInt() : 1;

        ClientPlayerEntity player = runOnRenderThread(client, () -> requirePlayer(client));

        CraftRecipeMatch selectedRecipe = runOnRenderThread(client, () -> selectCraftRecipeMatch(player, itemName));
        if (selectedRecipe == null) {
            JsonObject result = new JsonObject();
            result.addProperty("status", "error");
            result.addProperty("message", "No recipe found for: " + itemName);
            return result;
        }
        RecipeEntry<CraftingRecipe> foundEntry = selectedRecipe.entry;
        CraftingRecipe foundRecipe = selectedRecipe.recipe;
        String outputName = selectedRecipe.outputName;
        int outputCount = selectedRecipe.outputCount;

        DefaultedList<Ingredient> ingredients = foundRecipe.getIngredients();
        boolean needs3x3 = selectedRecipe.needs3x3;

        BlockPos craftingTablePos = null;
        if (needs3x3) {
            if (!params.has("craftingTable")) {
                JsonObject result = new JsonObject();
                result.addProperty("status", "error");
                result.addProperty("message", "Recipe requires 3x3 crafting table but no craftingTable position provided");
                return result;
            }
            JsonObject ct = params.getAsJsonObject("craftingTable");
            BlockPos tablePos = new BlockPos(ct.get("x").getAsInt(), ct.get("y").getAsInt(), ct.get("z").getAsInt());
            JsonObject validationError = runOnRenderThread(client, () -> {
                if (!player.getWorld().getBlockState(tablePos).isOf(Blocks.CRAFTING_TABLE)) {
                    JsonObject err = new JsonObject();
                    err.addProperty("status", "error");
                    err.addProperty("message", "Provided craftingTable position is not a crafting table");
                    return err;
                }
                if (player.getPos().squaredDistanceTo(Vec3d.ofCenter(tablePos)) > 36.0D) {
                    JsonObject err = new JsonObject();
                    err.addProperty("status", "error");
                    err.addProperty("message", "Crafting table is too far away");
                    return err;
                }
                return null;
            });
            if (validationError != null) return validationError;
            craftingTablePos = tablePos;
        }

        int maxGridSize = needs3x3 ? 3 : 2;
        Ingredient[] gridMap = selectedRecipe.gridMap;
        int timesToCraft = (int) Math.ceil((double) count / outputCount);

        // Phase 2: Open screen — for 3x3 this is async (daemon thread sleeps,
        // render thread processes the screen-open packet). For 2x2 this is brief
        // render-thread work.
        boolean openedInventoryScreen = false;
        if (!needs3x3) {
            openedInventoryScreen = runOnRenderThread(client,
                () -> openInventoryScreenForPlayerCrafting(client, player));
        }

        ScreenHandler handler = getCraftingHandler(client, player, needs3x3, craftingTablePos);

        // Phase 3: Execute crafting loop on the render thread.
        // Slot clicks, grid manipulation, and result extraction all need the render thread.
        final boolean fOpenedInventoryScreen = openedInventoryScreen;
        return runOnRenderThread(client, () -> executeCraftLoop(
            client, player, handler, foundEntry, selectedRecipe,
            gridMap, maxGridSize, needs3x3, outputName, outputCount,
            timesToCraft, fOpenedInventoryScreen
        ));
    }

    /**
     * The inner crafting loop. MUST run on the render thread.
     */
    private JsonObject executeCraftLoop(
        MinecraftClient client,
        ClientPlayerEntity player,
        ScreenHandler handler,
        RecipeEntry<CraftingRecipe> foundEntry,
        CraftRecipeMatch selectedRecipe,
        Ingredient[] gridMap,
        int maxGridSize,
        boolean needs3x3,
        String outputName,
        int outputCount,
        int timesToCraft,
        boolean openedInventoryScreen
    ) throws Exception {
        int syncId = handler.syncId;
        int crafted = 0;

        try {
            clearCursor(handler, client, player);
            clearCraftingGrid(handler, client, player, maxGridSize, needs3x3);

            for (int iteration = 0; iteration < timesToCraft; iteration++) {
                clearCursor(handler, client, player);
                clearCraftingGrid(handler, client, player, maxGridSize, needs3x3);

                int[] sourceRawSlotsByGrid = new int[gridMap.length];
                for (int i = 0; i < sourceRawSlotsByGrid.length; i++) {
                    sourceRawSlotsByGrid[i] = -1;
                }
                int[] remainingCounts = new int[player.getInventory().size()];
                for (int i = 0; i < player.getInventory().size(); i++) {
                    remainingCounts[i] = player.getInventory().getStack(i).getCount();
                }

                boolean hasAllMaterials = true;
                for (int g = 0; g < gridMap.length; g++) {
                    Ingredient ingredient = gridMap[g];
                    if (ingredient == null || ingredient.isEmpty()) continue;

                    boolean found = false;
                    for (int i = 0; i < player.getInventory().size(); i++) {
                        if (remainingCounts[i] <= 0) continue;
                        ItemStack stack = player.getInventory().getStack(i);
                        if (!stack.isEmpty() && ingredient.test(stack)) {
                            sourceRawSlotsByGrid[g] = i;
                            remainingCounts[i]--;
                            found = true;
                            break;
                        }
                    }

                    if (!found) {
                        hasAllMaterials = false;
                        break;
                    }
                }

                if (!hasAllMaterials) {
                    if (crafted == 0) {
                        JsonObject result = new JsonObject();
                        result.addProperty("status", "error");
                        result.addProperty("message", "Not enough materials for: " + outputName);
                        return result;
                    }
                    break;
                }

                clearCursor(handler, client, player);
                boolean populatedByRecipeFill = tryFillCraftingGridFromRecipe(client, player, handler, foundEntry);

                if (!populatedByRecipeFill) {
                    clearCursor(handler, client, player);
                    clearCraftingGrid(handler, client, player, maxGridSize, needs3x3);

                    Thread.sleep(50);
                    refreshCraftingScreenState(player);
                    for (int i = 0; i < sourceRawSlotsByGrid.length; i++) {
                        sourceRawSlotsByGrid[i] = -1;
                    }
                    int[] updatedRemainingCounts = new int[player.getInventory().size()];
                    for (int i = 0; i < player.getInventory().size(); i++) {
                        updatedRemainingCounts[i] = player.getInventory().getStack(i).getCount();
                    }
                    boolean hasAllMaterialsForManual = true;
                    for (int g = 0; g < gridMap.length; g++) {
                        Ingredient ingredient2 = gridMap[g];
                        if (ingredient2 == null || ingredient2.isEmpty()) continue;
                        boolean found2 = false;
                        for (int i = 0; i < player.getInventory().size(); i++) {
                            if (updatedRemainingCounts[i] <= 0) continue;
                            ItemStack stack2 = player.getInventory().getStack(i);
                            if (!stack2.isEmpty() && ingredient2.test(stack2)) {
                                sourceRawSlotsByGrid[g] = i;
                                updatedRemainingCounts[i]--;
                                found2 = true;
                                break;
                            }
                        }
                        if (!found2) {
                            hasAllMaterialsForManual = false;
                            break;
                        }
                    }
                    if (!hasAllMaterialsForManual) {
                        if (crafted == 0) {
                            JsonObject result = new JsonObject();
                            result.addProperty("status", "error");
                            result.addProperty("message", "Not enough materials for manual placement: " + outputName);
                            return result;
                        }
                        break;
                    }

                    for (int gridIdx = 0; gridIdx < gridMap.length; gridIdx++) {
                        Ingredient ingredient = gridMap[gridIdx];
                        if (ingredient == null || ingredient.isEmpty()) continue;

                        int rawSlot = sourceRawSlotsByGrid[gridIdx];
                        if (rawSlot < 0) {
                            continue;
                        }
                        int sourceScreenSlot = rawInventoryToScreenSlot(rawSlot, needs3x3);
                        int gridScreenSlot = 1 + gridIdx;

                        client.interactionManager.clickSlot(syncId, sourceScreenSlot, 0, SlotActionType.PICKUP, player);
                        client.interactionManager.clickSlot(syncId, gridScreenSlot, 1, SlotActionType.PICKUP, player);
                        if (!handler.getCursorStack().isEmpty()) {
                            client.interactionManager.clickSlot(syncId, sourceScreenSlot, 0, SlotActionType.PICKUP, player);
                        }
                    }
                }

                refreshCraftingResult(handler, player);
                waitForCraftingResult(handler, player, 4, 50L);

                ItemStack resultStackBeforeTake = handler.getSlot(0).getStack().copy();
                if (resultStackBeforeTake.isEmpty()) {
                    if (crafted == 0) {
                        JsonObject result = new JsonObject();
                        result.addProperty("status", "error");
                        result.addProperty(
                            "message",
                            "Crafting grid did not produce output for: "
                                + outputName
                                + " (recipeFill="
                                + populatedByRecipeFill
                                + ", handler="
                                + handler.getClass().getSimpleName()
                                + ", screen="
                                + (client.currentScreen == null ? "null" : client.currentScreen.getClass().getSimpleName())
                                + ", grid="
                                + describeCraftingGrid(handler, maxGridSize)
                                + ")"
                        );
                        return result;
                    }
                    break;
                }

                int outputCountBeforeMove = countInventoryItems(player, outputName);
                client.interactionManager.clickSlot(syncId, 0, 0, SlotActionType.QUICK_MOVE, player);
                refreshCraftingScreenState(player);

                int outputCountAfterMove = countInventoryItems(player, outputName);
                if (outputCountAfterMove <= outputCountBeforeMove) {
                    if (crafted == 0) {
                        JsonObject result = new JsonObject();
                        result.addProperty("status", "error");
                        result.addProperty(
                            "message",
                            "Failed to move crafted output into inventory: "
                                + outputName
                                + " (before=" + outputCountBeforeMove
                                + ", after=" + outputCountAfterMove
                                + ", produced=" + resultStackBeforeTake.getCount()
                                + ")"
                        );
                        return result;
                    }
                    break;
                }

                crafted += resultStackBeforeTake.getCount();
            }
        } finally {
            clearCursor(handler, client, player);
            clearCraftingGrid(handler, client, player, maxGridSize, needs3x3);
            if (openedInventoryScreen && !needs3x3) {
                client.setScreen(null);
                refreshCraftingScreenState(player);
            }
        }

        refreshCraftingScreenState(player);

        JsonObject result = new JsonObject();
        result.addProperty("status", "ok");
        result.addProperty("crafted", crafted);
        result.addProperty("item", outputName);
        result.add("inventory", serializeInventoryItems(player));
        result.addProperty("selectedSlot", player.getInventory().selectedSlot);
        return result;
    }

    /**
     * Opens a 3x3 crafting table screen.
     *
     * IMPORTANT THREADING NOTE: This method is designed to run on a daemon/async thread
     * (NOT the render thread). It dispatches interactBlock to the render thread, then
     * polls for the screen handler on the daemon thread. This avoids a deadlock where
     * Thread.sleep() on the render thread would prevent the screen-open packet from
     * being processed.
     */
    private ScreenHandler getCraftingHandler(
        MinecraftClient client,
        ClientPlayerEntity player,
        boolean needs3x3,
        BlockPos craftingTablePos
    ) throws Exception {
        if (!needs3x3) {
            return runOnRenderThread(client, () -> player.playerScreenHandler);
        }

        if (craftingTablePos == null) {
            throw new IllegalArgumentException("Missing crafting table position for 3x3 crafting");
        }

        // Quick check if screen is already open
        if (player.currentScreenHandler instanceof CraftingScreenHandler craftingHandler) {
            return craftingHandler;
        }

        // Build hit results on render thread (needs player eye position)
        List<BlockHitResult> hitResults = runOnRenderThread(client,
            () -> buildBlockInteractionHitResults(player, craftingTablePos));

        for (BlockHitResult hitResult : hitResults) {
            // Dispatch interactBlock on the render thread
            runOnRenderThread(client, () -> {
                client.interactionManager.interactBlock(player, Hand.MAIN_HAND, hitResult);
                refreshCraftingScreenState(player);
            });

            // Poll on the daemon thread — the render thread is free to process the
            // screen-open packet from the server during our Thread.sleep() calls.
            for (int attempt = 0; attempt < CRAFTING_TABLE_OPEN_ATTEMPTS; attempt++) {
                Thread.sleep(CRAFTING_TABLE_OPEN_DELAY_MS);
                if (player.currentScreenHandler instanceof CraftingScreenHandler craftingHandler) {
                    return craftingHandler;
                }
            }
        }

        throw new IllegalStateException("Crafting table screen did not open after retries");
    }

    private void clearCursor(ScreenHandler handler, MinecraftClient client, ClientPlayerEntity player) {
        if (handler.getCursorStack().isEmpty()) {
            return;
        }

        int destinationSlot = findInventoryDestinationSlot(player, handler.getCursorStack(), handler instanceof CraftingScreenHandler);
        if (destinationSlot >= 0) {
            client.interactionManager.clickSlot(handler.syncId, destinationSlot, 0, SlotActionType.PICKUP, player);
        }
    }

    private void clearCraftingGrid(
        ScreenHandler handler,
        MinecraftClient client,
        ClientPlayerEntity player,
        int gridSize,
        boolean isCraftingTable
    ) {
        int slotCount = gridSize * gridSize;
        for (int i = 0; i < slotCount; i++) {
            int gridSlot = 1 + i;
            if (handler.getSlot(gridSlot).hasStack()) {
                client.interactionManager.clickSlot(handler.syncId, gridSlot, 0, SlotActionType.QUICK_MOVE, player);
            }
        }
        clearCursor(handler, client, player);
    }

    private int findInventoryDestinationSlot(ClientPlayerEntity player, ItemStack stack, boolean isCraftingTable) {
        String itemId = Registries.ITEM.getId(stack.getItem()).toString();

        for (int rawSlot = 0; rawSlot < player.getInventory().size(); rawSlot++) {
            ItemStack inventoryStack = player.getInventory().getStack(rawSlot);
            if (!inventoryStack.isEmpty()
                && inventoryStack.getCount() < inventoryStack.getMaxCount()
                && Registries.ITEM.getId(inventoryStack.getItem()).toString().equals(itemId)) {
                return rawInventoryToScreenSlot(rawSlot, isCraftingTable);
            }
        }

        for (int rawSlot = 0; rawSlot < player.getInventory().size(); rawSlot++) {
            ItemStack inventoryStack = player.getInventory().getStack(rawSlot);
            if (inventoryStack.isEmpty()) {
                return rawInventoryToScreenSlot(rawSlot, isCraftingTable);
            }
        }

        return -1;
    }

    /**
     * Convert raw player inventory index to screen handler slot index.
     * Raw inventory: 0-8 = hotbar, 9-35 = main inventory, 36-39 = armor, 40 = offhand
     * PlayerScreenHandler: 9-35 = main inv, 36-44 = hotbar (offset by 9 from crafting grid slots)
     * CraftingScreenHandler: 10-36 = main inv, 37-45 = hotbar (offset by 10)
     */
    private int rawInventoryToScreenSlot(int rawSlot, boolean isCraftingTable) {
        int offset = isCraftingTable ? 10 : 9;
        if (rawSlot < 9) {
            // Hotbar: raw 0-8 -> screen (offset+27) to (offset+35)
            return offset + 27 + rawSlot;
        } else if (rawSlot < 36) {
            // Main inventory: raw 9-35 -> screen (offset+0) to (offset+26)
            return offset + (rawSlot - 9);
        }
        // Armor/offhand: not typically used for crafting, return as-is
        return rawSlot;
    }

    /**
     * Get recipes for an item.
     * Params: { item: string }
     */
    public JsonObject handleRecipesFor(JsonObject params, MinecraftClient client) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);
        String itemName = params.get("item").getAsString();

        JsonArray recipes = new JsonArray();
        var recipeManager = player.getWorld().getRecipeManager();

        for (RecipeEntry<?> entry : recipeManager.values()) {
            ItemStack output = entry.value().getResult(player.getWorld().getRegistryManager());
            String outputId = Registries.ITEM.getId(output.getItem()).toString();
            if (itemIdMatchesQuery(outputId, itemName)) {
                JsonObject recipe = new JsonObject();
                recipe.addProperty("id", entry.id().toString());
                recipe.addProperty("output", outputId);
                recipe.addProperty("outputCount", output.getCount());
                recipe.addProperty("type", entry.value().getType().toString());
                recipes.add(recipe);
            }
        }

        JsonObject result = new JsonObject();
        result.addProperty("status", "ok");
        result.add("recipes", recipes);
        return result;
    }

    /**
     * Open a furnace at position and return its slot contents.
     * Params: { x: number, y: number, z: number }
     *
     * THREADING: Runs on a daemon thread (asyncCommands). Dispatches interactBlock
     * to the render thread, then polls for the furnace screen on the daemon thread
     * to avoid blocking the render thread during the wait.
     */
    public JsonObject handleOpenFurnace(JsonObject params, MinecraftClient client) throws Exception {
        ClientPlayerEntity player = runOnRenderThread(client, () -> requirePlayer(client));
        BlockPos pos = new BlockPos(
            params.get("x").getAsInt(),
            params.get("y").getAsInt(),
            params.get("z").getAsInt()
        );

        if (player.currentScreenHandler instanceof AbstractFurnaceScreenHandler furnaceHandler) {
            return runOnRenderThread(client, () -> buildFurnaceSlotsResult(furnaceHandler));
        }

        List<BlockHitResult> hitResults = runOnRenderThread(client,
            () -> buildBlockInteractionHitResults(player, pos));

        for (BlockHitResult hitResult : hitResults) {
            runOnRenderThread(client, () -> {
                client.interactionManager.interactBlock(player, Hand.MAIN_HAND, hitResult);
                refreshCraftingScreenState(player);
            });

            AbstractFurnaceScreenHandler furnaceHandler = waitForFurnaceScreen(
                player,
                FURNACE_OPEN_ATTEMPTS,
                FURNACE_OPEN_DELAY_MS
            );
            if (furnaceHandler != null) {
                return runOnRenderThread(client, () -> buildFurnaceSlotsResult(furnaceHandler));
            }
        }

        throw new IllegalStateException("Furnace screen did not open");
    }

    private AbstractFurnaceScreenHandler waitForFurnaceScreen(
        ClientPlayerEntity player,
        int attempts,
        long delayMs
    ) throws InterruptedException {
        for (int attempt = 0; attempt < attempts; attempt++) {
            if (player.currentScreenHandler instanceof AbstractFurnaceScreenHandler furnaceHandler) {
                return furnaceHandler;
            }
            Thread.sleep(delayMs);
            refreshCraftingScreenState(player);
        }
        return null;
    }

    /**
     * Furnace screen: slots 0=input, 1=fuel, 2=output, 3-29=main inventory, 30-38=hotbar.
     */
    private int rawInventoryToFurnaceScreenSlot(int rawSlot) {
        if (rawSlot < 9) {
            return 30 + rawSlot; // hotbar
        } else if (rawSlot < 36) {
            return 3 + (rawSlot - 9); // main inventory
        }
        return rawSlot;
    }

    private JsonObject buildFurnaceSlotsResult(AbstractFurnaceScreenHandler handler) {
        JsonObject result = new JsonObject();
        result.addProperty("status", "ok");

        ItemStack inputStack = handler.getSlot(0).getStack();
        if (!inputStack.isEmpty()) {
            result.add("inputItem", Serializers.itemStackToJson(inputStack, 0));
        }

        ItemStack fuelStack = handler.getSlot(1).getStack();
        if (!fuelStack.isEmpty()) {
            result.add("fuelItem", Serializers.itemStackToJson(fuelStack, 1));
        }

        ItemStack outputStack = handler.getSlot(2).getStack();
        if (!outputStack.isEmpty()) {
            result.add("outputItem", Serializers.itemStackToJson(outputStack, 2));
        }

        return result;
    }

    /**
     * Get current furnace slot contents.
     * Requires furnace to be already open.
     */
    public JsonObject handleGetFurnaceSlots(JsonObject params, MinecraftClient client) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);
        if (!(player.currentScreenHandler instanceof AbstractFurnaceScreenHandler furnaceHandler)) {
            throw new IllegalStateException("No furnace screen is currently open");
        }
        refreshCraftingScreenState(player);
        return buildFurnaceSlotsResult(furnaceHandler);
    }

    /**
     * Put an item into the furnace input slot (slot 0).
     * Params: { item: string, count: number }
     */
    public JsonObject handleFurnacePutInput(JsonObject params, MinecraftClient client) throws Exception {
        return furnaceSlotTransfer(params, client, 0);
    }

    /**
     * Put an item into the furnace fuel slot (slot 1).
     * Params: { item: string, count: number }
     */
    public JsonObject handleFurnacePutFuel(JsonObject params, MinecraftClient client) throws Exception {
        return furnaceSlotTransfer(params, client, 1);
    }

    private JsonObject furnaceSlotTransfer(JsonObject params, MinecraftClient client, int targetSlot) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);
        if (!(player.currentScreenHandler instanceof AbstractFurnaceScreenHandler furnaceHandler)) {
            throw new IllegalStateException("No furnace screen is currently open");
        }

        String itemName = params.get("item").getAsString();
        int count = params.has("count") ? params.get("count").getAsInt() : 1;
        int syncId = furnaceHandler.syncId;

        // Find the item in player inventory and move it to the target furnace slot
        int transferred = 0;
        for (int i = 0; i < player.getInventory().size() && transferred < count; i++) {
            ItemStack stack = player.getInventory().getStack(i);
            if (stack.isEmpty()) continue;
            String id = Registries.ITEM.getId(stack.getItem()).toString();
            if (!id.contains(itemName)) continue;

            int screenSlot = rawInventoryToFurnaceScreenSlot(i);
            int toTransfer = Math.min(count - transferred, stack.getCount());

            // Pick up from inventory slot
            client.interactionManager.clickSlot(syncId, screenSlot, 0, SlotActionType.PICKUP, player);
            Thread.sleep(50);

            if (toTransfer < stack.getCount()) {
                // Place partial amount: right-click (button=1) repeatedly
                for (int r = 0; r < toTransfer; r++) {
                    client.interactionManager.clickSlot(syncId, targetSlot, 1, SlotActionType.PICKUP, player);
                    Thread.sleep(20);
                }
                // Put the rest back
                client.interactionManager.clickSlot(syncId, screenSlot, 0, SlotActionType.PICKUP, player);
            } else {
                // Place full stack in target slot
                client.interactionManager.clickSlot(syncId, targetSlot, 0, SlotActionType.PICKUP, player);
            }
            Thread.sleep(50);
            transferred += toTransfer;
        }

        refreshCraftingScreenState(player);
        JsonObject result = new JsonObject();
        result.addProperty("status", "ok");
        result.addProperty("transferred", transferred);
        return result;
    }

    /**
     * Take items from furnace output slot (slot 2).
     */
    public JsonObject handleFurnaceTakeOutput(JsonObject params, MinecraftClient client) throws Exception {
        return furnaceSlotTake(client, 2);
    }

    /**
     * Take items from furnace input slot (slot 0).
     */
    public JsonObject handleFurnaceTakeInput(JsonObject params, MinecraftClient client) throws Exception {
        return furnaceSlotTake(client, 0);
    }

    /**
     * Take items from furnace fuel slot (slot 1).
     */
    public JsonObject handleFurnaceTakeFuel(JsonObject params, MinecraftClient client) throws Exception {
        return furnaceSlotTake(client, 1);
    }

    private JsonObject furnaceSlotTake(MinecraftClient client, int slotIndex) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);
        if (!(player.currentScreenHandler instanceof AbstractFurnaceScreenHandler furnaceHandler)) {
            throw new IllegalStateException("No furnace screen is currently open");
        }

        ItemStack before = furnaceHandler.getSlot(slotIndex).getStack().copy();
        client.interactionManager.clickSlot(furnaceHandler.syncId, slotIndex, 0, SlotActionType.QUICK_MOVE, player);
        Thread.sleep(50);
        refreshCraftingScreenState(player);

        JsonObject result = new JsonObject();
        result.addProperty("status", "ok");
        if (!before.isEmpty()) {
            result.add("item", Serializers.itemStackToJson(before, slotIndex));
        }
        return result;
    }

    /**
     * Close the currently open furnace screen.
     */
    public JsonObject handleCloseFurnace(JsonObject params, MinecraftClient client) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);
        player.closeHandledScreen();
        JsonObject result = new JsonObject();
        result.addProperty("status", "ok");
        return result;
    }

    /**
     * Consume held item (eat/drink).
     */
    public JsonObject handleConsume(JsonObject params, MinecraftClient client) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);

        ItemStack held = player.getMainHandStack();
        if (held.isEmpty() || !held.getItem().isFood()) {
            throw new IllegalArgumentException("Not holding a food item");
        }

        String itemId = Registries.ITEM.getId(held.getItem()).toString();

        // Simulate right-click hold to eat, then release after eating duration
        client.options.useKey.setPressed(true);

        // Release the use key after a timeout (eating takes ~1.6s = 32 ticks)
        java.util.concurrent.ScheduledExecutorService scheduler = java.util.concurrent.Executors.newSingleThreadScheduledExecutor();
        scheduler.schedule(() -> {
            client.execute(() -> client.options.useKey.setPressed(false));
            scheduler.shutdown();
        }, 2000, java.util.concurrent.TimeUnit.MILLISECONDS);

        JsonObject result = new JsonObject();
        result.addProperty("status", "consuming");
        result.addProperty("item", itemId);
        return result;
    }

    /**
     * Toss items from inventory.
     * Params: { item: string, count: number? }
     */
    public JsonObject handleToss(JsonObject params, MinecraftClient client) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);
        String itemName = params.get("item").getAsString();
        int count = params.has("count") ? params.get("count").getAsInt() : 1;

        int tossed = 0;
        for (int i = 0; i < player.getInventory().size() && tossed < count; i++) {
            ItemStack stack = player.getInventory().getStack(i);
            if (!stack.isEmpty() && Registries.ITEM.getId(stack.getItem()).toString().contains(itemName)) {
                int toToss = Math.min(count - tossed, stack.getCount());
                player.dropItem(stack.split(toToss), false);
                tossed += toToss;
                if (stack.isEmpty()) {
                    player.getInventory().setStack(i, ItemStack.EMPTY);
                }
            }
        }

        JsonObject result = serializeFullInventoryState(player);
        result.addProperty("tossed", tossed);
        return result;
    }

    /**
     * Get full inventory contents.
     */
    public JsonObject handleGetInventory(JsonObject params, MinecraftClient client) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);
        refreshCraftingScreenState(player);
        return serializeFullInventoryState(player);
    }

    /**
     * Brew potions using a brewing stand.
     * Params: { x, y, z, ingredient: string, fuel?: string, bottles?: string[] }
     */
    public JsonObject handleBrew(JsonObject params, MinecraftClient client) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);

        int x = params.get("x").getAsInt();
        int y = params.get("y").getAsInt();
        int z = params.get("z").getAsInt();
        String ingredient = params.get("ingredient").getAsString();

        BlockPos pos = new BlockPos(x, y, z);
        Vec3d hitVec = Vec3d.ofCenter(pos);
        BlockHitResult hitResult = new BlockHitResult(hitVec, Direction.UP, pos, false);
        client.interactionManager.interactBlock(player, Hand.MAIN_HAND, hitResult);

        // Wait for brewing stand screen to open
        Thread.sleep(500);

        ScreenHandler handler = player.currentScreenHandler;
        int syncId = handler.syncId;

        try {
            // Brewing stand slots:
            // 0: ingredient (top)
            // 1-3: bottles (bottom 3)
            // 4: fuel (blaze powder)
            // 5+: player inventory

            // Place fuel (blaze powder) in slot 4 if needed
            if (params.has("fuel")) {
                String fuelName = params.get("fuel").getAsString();
                int fuelSlot = findItemInInventory(player, fuelName);
                if (fuelSlot >= 0) {
                    int screenSlot = rawInventoryToBrewingScreenSlot(fuelSlot);
                    client.interactionManager.clickSlot(syncId, screenSlot, 0, SlotActionType.PICKUP, player);
                    client.interactionManager.clickSlot(syncId, 4, 0, SlotActionType.PICKUP, player);
                    if (!player.currentScreenHandler.getCursorStack().isEmpty()) {
                        client.interactionManager.clickSlot(syncId, screenSlot, 0, SlotActionType.PICKUP, player);
                    }
                    Thread.sleep(50);
                }
            }

            // Place bottles in slots 1-3
            for (int i = 0; i < 3; i++) {
                String bottleName = "glass_bottle";
                if (params.has("bottles")) {
                    var bottlesArray = params.getAsJsonArray("bottles");
                    if (i < bottlesArray.size()) {
                        bottleName = bottlesArray.get(i).getAsString();
                    }
                }
                int bottleSlot = findItemInInventory(player, bottleName);
                if (bottleSlot >= 0) {
                    int screenSlot = rawInventoryToBrewingScreenSlot(bottleSlot);
                    client.interactionManager.clickSlot(syncId, screenSlot, 0, SlotActionType.PICKUP, player);
                    client.interactionManager.clickSlot(syncId, 1 + i, 0, SlotActionType.PICKUP, player);
                    if (!player.currentScreenHandler.getCursorStack().isEmpty()) {
                        client.interactionManager.clickSlot(syncId, screenSlot, 0, SlotActionType.PICKUP, player);
                    }
                    Thread.sleep(50);
                }
            }

            // Place ingredient in slot 0
            int ingredientSlot = findItemInInventory(player, ingredient);
            if (ingredientSlot >= 0) {
                int screenSlot = rawInventoryToBrewingScreenSlot(ingredientSlot);
                client.interactionManager.clickSlot(syncId, screenSlot, 0, SlotActionType.PICKUP, player);
                client.interactionManager.clickSlot(syncId, 0, 0, SlotActionType.PICKUP, player);
                if (!player.currentScreenHandler.getCursorStack().isEmpty()) {
                    client.interactionManager.clickSlot(syncId, screenSlot, 0, SlotActionType.PICKUP, player);
                }
            }

            // Wait for brewing to complete (~20 seconds)
            Thread.sleep(21000);

            // Collect results from slots 1-3
            for (int i = 1; i <= 3; i++) {
                client.interactionManager.clickSlot(syncId, i, 0, SlotActionType.QUICK_MOVE, player);
                Thread.sleep(50);
            }

            JsonObject result = new JsonObject();
            result.addProperty("status", "ok");
            return result;
        } finally {
            player.closeHandledScreen();
        }
    }

    /**
     * Enchant an item at an enchanting table.
     * Params: { x, y, z, item: string, level: 1|2|3 }
     */
    public JsonObject handleEnchant(JsonObject params, MinecraftClient client) throws Exception {
        ClientPlayerEntity player = requirePlayer(client);

        int x = params.get("x").getAsInt();
        int y = params.get("y").getAsInt();
        int z = params.get("z").getAsInt();
        String itemName = params.get("item").getAsString();
        int level = params.get("level").getAsInt();

        if (level < 1 || level > 3) {
            throw new IllegalArgumentException("Enchant level must be 1, 2, or 3");
        }

        BlockPos pos = new BlockPos(x, y, z);
        Vec3d hitVec = Vec3d.ofCenter(pos);
        BlockHitResult hitResult = new BlockHitResult(hitVec, Direction.UP, pos, false);
        client.interactionManager.interactBlock(player, Hand.MAIN_HAND, hitResult);

        // Wait for enchantment screen to open
        Thread.sleep(500);

        ScreenHandler handler = player.currentScreenHandler;
        int syncId = handler.syncId;

        try {
            // Enchanting table slots:
            // 0: item to enchant
            // 1: lapis lazuli
            // 2+: player inventory

            // Place item in slot 0
            int itemSlot = findItemInInventory(player, itemName);
            if (itemSlot < 0) {
                throw new IllegalArgumentException("Item not found in inventory: " + itemName);
            }
            int screenItemSlot = rawInventoryToEnchantScreenSlot(itemSlot);
            client.interactionManager.clickSlot(syncId, screenItemSlot, 0, SlotActionType.PICKUP, player);
            client.interactionManager.clickSlot(syncId, 0, 0, SlotActionType.PICKUP, player);
            if (!player.currentScreenHandler.getCursorStack().isEmpty()) {
                client.interactionManager.clickSlot(syncId, screenItemSlot, 0, SlotActionType.PICKUP, player);
            }
            Thread.sleep(50);

            // Place lapis in slot 1
            int lapisSlot = findItemInInventory(player, "lapis_lazuli");
            if (lapisSlot >= 0) {
                int screenLapisSlot = rawInventoryToEnchantScreenSlot(lapisSlot);
                client.interactionManager.clickSlot(syncId, screenLapisSlot, 0, SlotActionType.PICKUP, player);
                client.interactionManager.clickSlot(syncId, 1, 0, SlotActionType.PICKUP, player);
                if (!player.currentScreenHandler.getCursorStack().isEmpty()) {
                    client.interactionManager.clickSlot(syncId, screenLapisSlot, 0, SlotActionType.PICKUP, player);
                }
            }
            Thread.sleep(100);

            // Click the enchantment button (level - 1)
            client.interactionManager.clickButton(syncId, level - 1);
            Thread.sleep(200);

            // Take result back
            client.interactionManager.clickSlot(syncId, 0, 0, SlotActionType.QUICK_MOVE, player);
            Thread.sleep(50);
            // Take lapis back
            client.interactionManager.clickSlot(syncId, 1, 0, SlotActionType.QUICK_MOVE, player);

            JsonObject result = new JsonObject();
            result.addProperty("status", "ok");
            return result;
        } finally {
            player.closeHandledScreen();
        }
    }

    private int findItemInInventory(ClientPlayerEntity player, String itemName) {
        for (int i = 0; i < player.getInventory().size(); i++) {
            ItemStack stack = player.getInventory().getStack(i);
            if (!stack.isEmpty()) {
                String id = Registries.ITEM.getId(stack.getItem()).toString();
                if (id.contains(itemName)) {
                    return i;
                }
            }
        }
        return -1;
    }

    /**
     * Brewing stand screen: slots 0-4 are brewing stand, 5-31 main inventory, 32-40 hotbar.
     */
    private int rawInventoryToBrewingScreenSlot(int rawSlot) {
        if (rawSlot < 9) {
            return 32 + rawSlot; // hotbar
        } else if (rawSlot < 36) {
            return 5 + (rawSlot - 9); // main inventory
        }
        return rawSlot;
    }

    /**
     * Enchanting table screen: slots 0-1 are enchant table, 2-28 main inventory, 29-37 hotbar.
     */
    private int rawInventoryToEnchantScreenSlot(int rawSlot) {
        if (rawSlot < 9) {
            return 29 + rawSlot; // hotbar
        } else if (rawSlot < 36) {
            return 2 + (rawSlot - 9); // main inventory
        }
        return rawSlot;
    }

    private ClientPlayerEntity requirePlayer(MinecraftClient client) throws Exception {
        if (client.player == null) throw new IllegalStateException("Player not in world");
        return client.player;
    }
}

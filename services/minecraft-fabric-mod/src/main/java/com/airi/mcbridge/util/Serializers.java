package com.airi.mcbridge.util;

import com.google.gson.JsonObject;
import net.minecraft.item.ItemStack;
import net.minecraft.nbt.NbtCompound;
import net.minecraft.registry.Registries;
import net.minecraft.util.math.BlockPos;

public class Serializers {

    public static JsonObject blockPosToJson(BlockPos pos) {
        JsonObject json = new JsonObject();
        json.addProperty("x", pos.getX());
        json.addProperty("y", pos.getY());
        json.addProperty("z", pos.getZ());
        return json;
    }

    public static JsonObject itemStackToJson(ItemStack stack, int slot) {
        JsonObject json = new JsonObject();
        json.addProperty("slot", slot);
        json.addProperty("name", Registries.ITEM.getId(stack.getItem()).toString());
        json.addProperty("count", stack.getCount());
        json.addProperty("maxCount", stack.getMaxCount());
        json.addProperty("durability", stack.getMaxDamage() - stack.getDamage());
        json.addProperty("maxDurability", stack.getMaxDamage());

        if (stack.hasNbt()) {
            NbtCompound nbt = stack.getNbt();
            if (nbt != null) {
                json.addProperty("nbt", nbt.toString());
            }
        }

        return json;
    }
}

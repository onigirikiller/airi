package com.airi.mcbridge.util;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.Optional;
import java.util.stream.StreamSupport;

public final class QuickPlayWorldResolver {
    private QuickPlayWorldResolver() {
    }

    public static Optional<String> resolveSingleplayerWorld(Path minecraftDir) {
        Path quickPlayDir = minecraftDir.resolve("quickPlay").resolve("java");
        if (!Files.isDirectory(quickPlayDir)) {
            return Optional.empty();
        }

        try (DirectoryStream<Path> candidates = Files.newDirectoryStream(quickPlayDir, "*.json")) {
            return StreamSupport.stream(candidates.spliterator(), false)
                    .sorted(Comparator.comparingLong(QuickPlayWorldResolver::lastModifiedMillis).reversed())
                    .map(QuickPlayWorldResolver::parseSingleplayerWorld)
                    .filter(Optional::isPresent)
                    .map(Optional::get)
                    .map(id -> toLoadableWorldId(minecraftDir, id))
                    .filter(Optional::isPresent)
                    .map(Optional::get)
                    .findFirst();
        } catch (IOException ignored) {
            return Optional.empty();
        }
    }

    /**
     * Some launch paths record the world id with literal {@code \\uXXXX} escapes
     * (e.g. Japanese world names). Loading that literal string sends Minecraft to a
     * nonexistent path like {@code C:新...\level.dat}. Only return ids whose
     * save folder actually exists, decoding stray escapes when needed.
     */
    static Optional<String> toLoadableWorldId(Path minecraftDir, String id) {
        if (isExistingSave(minecraftDir, id)) {
            return Optional.of(id);
        }

        String decoded = decodeUnicodeEscapes(id);
        if (!decoded.equals(id) && isExistingSave(minecraftDir, decoded)) {
            return Optional.of(decoded);
        }

        return Optional.empty();
    }

    private static boolean isExistingSave(Path minecraftDir, String worldId) {
        if (worldId.indexOf('\\') >= 0 || worldId.indexOf('/') >= 0) {
            return false;
        }
        try {
            return Files.exists(minecraftDir.resolve("saves").resolve(worldId).resolve("level.dat"));
        } catch (Exception ignored) {
            return false;
        }
    }

    /** Decodes literal {@code \\uXXXX} sequences left behind by broken JSON writers. */
    static String decodeUnicodeEscapes(String value) {
        StringBuilder result = new StringBuilder(value.length());
        int index = 0;
        while (index < value.length()) {
            if (value.charAt(index) == '\\' && index + 5 < value.length()
                    && (value.charAt(index + 1) == 'u' || value.charAt(index + 1) == 'U')) {
                try {
                    int codePoint = Integer.parseInt(value.substring(index + 2, index + 6), 16);
                    result.append((char) codePoint);
                    index += 6;
                    continue;
                } catch (NumberFormatException ignored) {
                    // fall through and keep the literal backslash
                }
            }
            result.append(value.charAt(index));
            index++;
        }
        return result.toString();
    }

    static Optional<String> parseSingleplayerWorld(Path quickPlayFile) {
        try (Reader reader = Files.newBufferedReader(quickPlayFile, StandardCharsets.UTF_8)) {
            JsonElement root = JsonParser.parseReader(reader);
            if (!root.isJsonArray()) {
                return Optional.empty();
            }

            JsonArray entries = root.getAsJsonArray();
            for (JsonElement entryElement : entries) {
                if (!entryElement.isJsonObject()) {
                    continue;
                }

                String type = getString(entryElement, "type");
                String id = getString(entryElement, "id");
                if ("singleplayer".equals(type) && id != null && !id.isBlank()) {
                    return Optional.of(id);
                }
            }
        } catch (Exception ignored) {
            return Optional.empty();
        }

        return Optional.empty();
    }

    private static String getString(JsonElement entryElement, String key) {
        if (!entryElement.getAsJsonObject().has(key) || entryElement.getAsJsonObject().get(key).isJsonNull()) {
            return null;
        }

        return entryElement.getAsJsonObject().get(key).getAsString();
    }

    private static long lastModifiedMillis(Path path) {
        try {
            return Files.getLastModifiedTime(path).toMillis();
        } catch (IOException ignored) {
            return Long.MIN_VALUE;
        }
    }
}

package com.airi.mcbridge.util;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class QuickPlayWorldResolverTest {
    @TempDir
    Path tempDir;

    private void createSave(String worldName) throws Exception {
        Path world = tempDir.resolve("saves").resolve(worldName);
        Files.createDirectories(world);
        Files.writeString(world.resolve("level.dat"), "", StandardCharsets.UTF_8);
    }

    @Test
    void resolvesLatestSingleplayerQuickPlayWorld() throws Exception {
        Path quickPlayDir = tempDir.resolve("quickPlay").resolve("java");
        Files.createDirectories(quickPlayDir);
        createSave("older-world");
        createSave("AIratest2");

        Path older = quickPlayDir.resolve("100.json");
        Files.writeString(older, "[{\"type\":\"singleplayer\",\"id\":\"older-world\"}]", StandardCharsets.UTF_8);
        Path newer = quickPlayDir.resolve("200.json");
        Files.writeString(newer, "[{\"type\":\"singleplayer\",\"id\":\"AIratest2\"}]", StandardCharsets.UTF_8);
        Files.setLastModifiedTime(older, FileTime.fromMillis(1_000));
        Files.setLastModifiedTime(newer, FileTime.fromMillis(2_000));

        Optional<String> resolved = QuickPlayWorldResolver.resolveSingleplayerWorld(tempDir);

        assertEquals(Optional.of("AIratest2"), resolved);
    }

    @Test
    void ignoresNonSingleplayerEntries() throws Exception {
        Path quickPlayDir = tempDir.resolve("quickPlay").resolve("java");
        Files.createDirectories(quickPlayDir);
        Path file = quickPlayDir.resolve("300.json");
        Files.writeString(file, "[{\"type\":\"multiplayer\",\"id\":\"localhost\"}]", StandardCharsets.UTF_8);

        Optional<String> resolved = QuickPlayWorldResolver.resolveSingleplayerWorld(tempDir);

        assertTrue(resolved.isEmpty());
    }

    @Test
    void decodesDoubleEscapedJapaneseWorldIds() throws Exception {
        Path quickPlayDir = tempDir.resolve("quickPlay").resolve("java");
        Files.createDirectories(quickPlayDir);
        createSave("新規ワールド (5)");

        // Broken writers leave literal \\uXXXX escapes in the id field while
        // the name field stays proper UTF-8. After JSON parsing the id becomes
        // the literal string "\\u65B0...".
        Path file = quickPlayDir.resolve("400.json");
        Files.writeString(file,
                "[{\"type\":\"singleplayer\",\"id\":\"\\\\u65B0\\\\u898F\\\\u30EF\\\\u30FC\\\\u30EB\\\\u30C9 (5)\",\"name\":\"新規ワールド\"}]",
                StandardCharsets.UTF_8);

        Optional<String> resolved = QuickPlayWorldResolver.resolveSingleplayerWorld(tempDir);

        assertEquals(Optional.of("新規ワールド (5)"), resolved);
    }

    @Test
    void skipsEntriesWhoseSaveFolderDoesNotExist() throws Exception {
        Path quickPlayDir = tempDir.resolve("quickPlay").resolve("java");
        Files.createDirectories(quickPlayDir);

        Path file = quickPlayDir.resolve("500.json");
        Files.writeString(file, "[{\"type\":\"singleplayer\",\"id\":\"deleted-world\"}]", StandardCharsets.UTF_8);

        Optional<String> resolved = QuickPlayWorldResolver.resolveSingleplayerWorld(tempDir);

        assertTrue(resolved.isEmpty());
    }

    @Test
    void decodeUnicodeEscapesLeavesNormalTextAlone() {
        assertEquals("新規ワールド (5)", QuickPlayWorldResolver.decodeUnicodeEscapes("\\u65B0\\u898F\\u30EF\\u30FC\\u30EB\\u30C9 (5)"));
        assertEquals("plain-world", QuickPlayWorldResolver.decodeUnicodeEscapes("plain-world"));
        assertEquals("bad\\uZZZZtail", QuickPlayWorldResolver.decodeUnicodeEscapes("bad\\uZZZZtail"));
    }
}

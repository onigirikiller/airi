import java.time.Instant

plugins {
    id("fabric-loom") version "1.9-SNAPSHOT"
    id("maven-publish")
}

version = project.property("mod_version") as String
group = project.property("maven_group") as String
val buildTimestamp = Instant.now().toString()

base {
    archivesName.set(project.property("archives_base_name") as String)
}

repositories {
    mavenCentral()
    maven("https://maven.fabricmc.net/") { name = "Fabric" }
    // Baritone
    maven("https://jitpack.io")
    // Local libs/ for Baritone API jar
    flatDir { dirs("libs") }
}

val minecraftVersion = project.property("minecraft_version") as String

dependencies {
    minecraft("com.mojang:minecraft:${minecraftVersion}")
    mappings("net.fabricmc:yarn:${project.property("yarn_mappings")}:v2")
    modImplementation("net.fabricmc:fabric-loader:${project.property("loader_version")}")
    modImplementation("net.fabricmc.fabric-api:fabric-api:${project.property("fabric_version")}")
    testImplementation(platform("org.junit:junit-bom:5.10.2"))
    testImplementation("org.junit.jupiter:junit-jupiter")

    // Baritone for pathfinding (compile-only, optional at runtime)
    // Place baritone-api-fabric-X.X.X.jar in libs/ to compile
    // Place baritone-standalone-fabric-X.X.X.jar in mods/ to run
    modCompileOnly("baritone-api-fabric:baritone-api-fabric:${property("baritone_version")}")

    // Netty is bundled with Minecraft, no extra dep needed for WebSocket
    // We use Java's built-in HttpServer + WebSocket or Netty from MC

    // Gson is bundled with Minecraft
}

tasks.processResources {
    inputs.property("version", project.version)
    inputs.property("buildTimestamp", buildTimestamp)
    filesMatching("fabric.mod.json") {
        expand("version" to project.version)
    }
    filesMatching("airi-mcbridge-build.json") {
        expand(mapOf(
            "version" to project.version,
            "buildTimestamp" to buildTimestamp,
        ))
    }
}

tasks.withType<JavaCompile> {
    options.release.set(17)
}

tasks.test {
    useJUnitPlatform()
}

java {
    withSourcesJar()
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

tasks.jar {
    from("LICENSE") {
        rename { "${it}_${project.base.archivesName.get()}" }
    }
}

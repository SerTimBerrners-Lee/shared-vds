import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));

function detectPlatform() {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  if (process.platform === "linux") return "linux";
  throw new Error(`Unsupported release platform: ${process.platform}`);
}

const platform = process.argv[2] || process.env.SHARED_VDS_RELEASE_PLATFORM || detectPlatform();
const bundleTargets = {
  macos: ["app"],
  windows: ["nsis"],
  linux: ["appimage", "deb"],
};

if (!Object.hasOwn(bundleTargets, platform)) {
  throw new Error(`Unsupported release platform: ${platform}`);
}

const env = {
  ...process.env,
  SHARED_VDS_SKIP_BEFORE_BUILD: "1",
};
const tauriBuildArgs = ["run", "tauri", "build", "--ci", "--bundles", bundleTargets[platform].join(",")];
const hasUpdaterSigningKey = Boolean(
  (env.TAURI_SIGNING_PRIVATE_KEY || env.TAURI_SIGNING_PRIVATE_KEY_PATH) && env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD,
);

if (platform === "macos") {
  env.MACOSX_DEPLOYMENT_TARGET = process.env.MACOSX_DEPLOYMENT_TARGET || "11.0";

  if (hasUpdaterSigningKey && !env.TAURI_SIGNING_PRIVATE_KEY && env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
    if (!existsSync(env.TAURI_SIGNING_PRIVATE_KEY_PATH)) {
      throw new Error(`TAURI_SIGNING_PRIVATE_KEY_PATH does not point to a file: ${env.TAURI_SIGNING_PRIVATE_KEY_PATH}`);
    }

    env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(env.TAURI_SIGNING_PRIVATE_KEY_PATH, "utf8");
  }
}

if (!hasUpdaterSigningKey) {
  console.warn("Updater signing key/password is not set; building installers without updater artifacts.");
  tauriBuildArgs.push("--config", JSON.stringify({ bundle: { createUpdaterArtifacts: false } }));
}

function run(command, args) {
  execFileSync(command, args, {
    cwd: rootDir,
    env,
    stdio: "inherit",
  });
}

run("bun", ["run", "build"]);
run("bun", tauriBuildArgs);

if (platform === "macos" && process.env.SHARED_VDS_POSTPROCESS_MACOS_RELEASE !== "0") {
  run("bun", ["run", "postprocess:macos-release"]);
}

console.log(`Built ${platform} release bundles: ${bundleTargets[platform].join(", ")}`);

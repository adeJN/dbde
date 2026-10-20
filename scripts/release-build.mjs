import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const config = JSON.parse(
  readFileSync(new URL("src-tauri/tauri.conf.json", root), "utf8"),
);
const cargo = readFileSync(new URL("src-tauri/Cargo.toml", root), "utf8");
const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (pkg.version !== config.version || pkg.version !== cargoVersion)
  throw new Error(
    "Synchronize versions in package.json, Cargo.toml and tauri.conf.json before releasing.",
  );
const key =
  process.env.TAURI_SIGNING_PRIVATE_KEY ||
  resolve(homedir(), ".tauri/dbde-updater.key");
if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !existsSync(key))
  throw new Error(
    "Updater signing key missing. Restore ~/.tauri/dbde-updater.key before building a release.",
  );
// Pass the key path through the environment; never print or copy it into the repository.
const result = spawnSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["run", "tauri", "--", "build", ...process.argv.slice(2)],
  {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      TAURI_SIGNING_PRIVATE_KEY: key,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD:
        process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD || "",
    },
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);

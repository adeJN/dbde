// Remove only reproducible Cargo caches. Preserve app bundles, installers,
// updater artifacts, project sources and all user database files.
import { lstat, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const target = new URL("../src-tauri/target/", import.meta.url);
try {
  if ((await lstat(target)).isSymbolicLink())
    throw new Error("Refusing to clean a symlinked target directory.");
} catch (error) {
  if (error.code === "ENOENT") process.exit(0);
  throw error;
}
for (const profile of ["debug", "release"]) {
  try {
    if ((await lstat(new URL(`${profile}/`, target))).isSymbolicLink())
      continue;
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  for (const folder of ["deps", "build", "incremental", ".fingerprint"]) {
    const path = new URL(`${profile}/${folder}/`, target);
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      await rm(path, { recursive: true });
      console.log(`Removed build cache: ${fileURLToPath(path)}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
console.log(
  "Bundles and installers preserved. The next Rust build will rebuild dependencies.",
);

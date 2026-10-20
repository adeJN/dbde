import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export function makeManifest({
  version,
  platform,
  artifact,
  signature,
  notes = "",
  previous,
  date = new Date().toISOString(),
}) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error("Invalid release version.");
  if (
    ![
      "darwin-aarch64",
      "darwin-x86_64",
      "windows-x86_64",
      "windows-aarch64",
      "linux-x86_64",
      "linux-aarch64",
    ].includes(platform)
  )
    throw new Error(
      "Specify a supported updater platform, e.g. darwin-aarch64.",
    );
  if (!signature?.trim() || /[\r\n]/.test(signature.trim()))
    throw new Error(
      "Signature must be the contents of the generated .sig file.",
    );
  // Tauri writes the full minisign signature as a single base64 string.
  const decoded = Buffer.from(signature.trim(), "base64").toString("utf8");
  if (!decoded.startsWith("untrusted comment:"))
    throw new Error("Invalid Tauri update signature.");
  if (platform.startsWith("darwin-") && !artifact.endsWith(".app.tar.gz"))
    throw new Error(
      "macOS updates require .app.tar.gz; a DMG is only for manual installation.",
    );
  if (previous && previous.version !== version)
    throw new Error(
      "Refusing to merge platforms from different release versions. Choose a new output file.",
    );
  return {
    version,
    notes,
    pub_date: date,
    platforms: {
      ...previous?.platforms,
      [platform]: {
        signature: signature.trim(),
        url: `https://github.com/adeJN/dbde/releases/download/v${version}/${encodeURIComponent(basename(artifact))}`,
      },
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: {
      artifact: { type: "string" },
      platform: { type: "string" },
      notes: { type: "string" },
      output: { type: "string", default: "latest.json" },
    },
  });
  if (!values.artifact || !values.platform)
    throw new Error(
      "Usage: npm run updater:manifest -- --artifact <DBde.app.tar.gz> --platform darwin-aarch64 [--notes release-notes.md] [--output latest.json]",
    );
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (!existsSync(values.artifact))
    throw new Error("Update artifact does not exist.");
  const manifest = makeManifest({
    version: pkg.version,
    platform: values.platform,
    artifact: values.artifact,
    signature: readFileSync(`${values.artifact}.sig`, "utf8"),
    notes: values.notes ? readFileSync(values.notes, "utf8") : "",
    previous: existsSync(values.output)
      ? JSON.parse(readFileSync(values.output, "utf8"))
      : undefined,
  });
  writeFileSync(values.output, JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    `Created ${values.output} for DBde ${pkg.version} (${Object.keys(manifest.platforms).join(", ")}).`,
  );
}

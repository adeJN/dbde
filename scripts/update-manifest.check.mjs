import { test } from "node:test";
import assert from "node:assert/strict";
import { makeManifest } from "./update-manifest.mjs";
const input = {
  version: "0.2.0",
  platform: "darwin-aarch64",
  artifact: "bundle/macos/DBde.app.tar.gz",
  signature: Buffer.from("untrusted comment: test signature\nfixture").toString(
    "base64",
  ),
  date: "2026-10-20T00:00:00Z",
};
test("uses GitHub version tag, artifact basename and signature contents", () => {
  const result = makeManifest(input);
  assert.equal(
    result.platforms["darwin-aarch64"].url,
    "https://github.com/adeJN/dbde/releases/download/v0.2.0/DBde.app.tar.gz",
  );
  assert.equal(result.platforms["darwin-aarch64"].signature, input.signature);
});
test("merges architectures only within the same version", () => {
  const first = makeManifest(input);
  assert.equal(
    Object.keys(
      makeManifest({ ...input, platform: "darwin-x86_64", previous: first })
        .platforms,
    ).length,
    2,
  );
  assert.throws(
    () => makeManifest({ ...input, version: "0.3.0", previous: first }),
    /different release/,
  );
});
test("rejects installers, missing/invalid signatures and unsupported platforms", () => {
  assert.throws(
    () => makeManifest({ ...input, artifact: "DBde.dmg" }),
    /app.tar.gz/,
  );
  assert.throws(
    () => makeManifest({ ...input, signature: "path/to/file.sig" }),
    /signature/,
  );
  assert.throws(
    () => makeManifest({ ...input, platform: "darwin-arm64" }),
    /platform/,
  );
});

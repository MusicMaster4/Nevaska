import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  BETA_POINTER_TAG,
  endpointFor,
  parseArgs as parseApplyArgs,
  withCargoLockVersion,
  withCargoVersion,
  withPackageVersion,
  withTauriConfig,
} from "./apply-version.mjs";
import { parseArgs as parseVersionArgs } from "./release-version.mjs";
import {
  REQUIRED_PLATFORMS,
  buildManifest,
  collectAssets,
  downloadUrl,
  platformsForAsset,
} from "./updater-manifest.mjs";

const REPO = "nevaska/nevaska";

describe("update endpoints", () => {
  test("stable rides GitHub's latest-release redirect, which skips prereleases", () => {
    assert.equal(endpointFor("stable", REPO), `https://github.com/${REPO}/releases/latest/download/latest.json`);
  });

  test("beta reads a manifest that only beta builds ever write", () => {
    assert.equal(
      endpointFor("testing", REPO),
      `https://github.com/${REPO}/releases/download/${BETA_POINTER_TAG}/latest.json`,
    );
  });

  test("the two channels can never resolve to the same manifest", () => {
    assert.notEqual(endpointFor("stable", REPO), endpointFor("testing", REPO));
  });
});

describe("stamping the version", () => {
  const config = {
    productName: "Nevaska",
    version: "0.1.0",
    plugins: { updater: { pubkey: "PUBKEY", endpoints: ["https://example.invalid/x.json"], windows: { installMode: "passive" } } },
  };

  test("package.json keeps everything but the version", () => {
    assert.deepEqual(withPackageVersion({ name: "nevaska", version: "0.1.0" }, "1.2.3"), {
      name: "nevaska",
      version: "1.2.3",
    });
  });

  test("a beta build is pointed at the beta manifest", () => {
    const next = withTauriConfig(config, { version: "1.2.3-testing.4", channel: "testing", repo: REPO });
    assert.equal(next.version, "1.2.3-testing.4");
    assert.deepEqual(next.plugins.updater.endpoints, [endpointFor("testing", REPO)]);
    assert.equal(next.plugins.updater.pubkey, "PUBKEY");
    assert.deepEqual(next.plugins.updater.windows, { installMode: "passive" });
    assert.equal(next.productName, "Nevaska");
    assert.equal(config.version, "0.1.0");
  });

  test("a stable build is pointed at the stable manifest", () => {
    const next = withTauriConfig(config, { version: "1.2.3", channel: "stable", repo: REPO });
    assert.deepEqual(next.plugins.updater.endpoints, [endpointFor("stable", REPO)]);
  });

  test("exactly one endpoint is configured, so a build cannot fall back to the other channel", () => {
    for (const channel of ["stable", "testing"]) {
      const next = withTauriConfig(config, { version: "1.2.3", channel, repo: REPO });
      assert.equal(next.plugins.updater.endpoints.length, 1);
    }
  });

  test("Cargo.toml: only the [package] version moves", () => {
    const toml = [
      "[package]",
      'name = "nevaska"',
      'version = "0.1.0"',
      "",
      "[dependencies]",
      'tauri = { version = "2", features = [] }',
      "",
    ].join("\n");
    const next = withCargoVersion(toml, "1.2.3-testing.4");
    assert.match(next, /version = "1.2.3-testing.4"/);
    assert.match(next, /tauri = \{ version = "2", features = \[\] \}/);
    assert.equal(next.match(/^version = /gm).length, 1);
  });

  test("Cargo.toml without a package version is an error", () => {
    assert.throws(() => withCargoVersion('[dependencies]\nserde = "1"\n', "1.2.3"));
  });

  test("Cargo.lock: only our crate's entry moves", () => {
    const lock = [
      "[[package]]",
      'name = "nevaska"',
      'version = "0.1.0"',
      "",
      "[[package]]",
      'name = "dunce"',
      'version = "0.1.0"',
      "",
    ].join("\n");
    const next = withCargoLockVersion(lock, "nevaska", "1.2.3");
    assert.match(next, /name = "nevaska"\nversion = "1.2.3"/);
    assert.match(next, /name = "dunce"\nversion = "0.1.0"/);
  });

  test("Cargo.lock: a missing crate is an error rather than a no-op", () => {
    assert.throws(() => withCargoLockVersion("[[package]]\n", "nevaska", "1.2.3"));
  });
});

describe("release script arguments", () => {
  test("the channel is inferred from the version", () => {
    assert.equal(parseApplyArgs(["--version", "1.2.3"]).channel, "stable");
    assert.equal(parseApplyArgs(["--version", "1.2.3-testing.4"]).channel, "testing");
  });

  test("a version that disagrees with the channel is refused", () => {
    assert.throws(() => parseApplyArgs(["--version", "1.2.3", "--channel", "testing"]));
    assert.throws(() => parseApplyArgs(["--version", "1.2.3-testing.1", "--channel", "stable"]));
  });

  test("a malformed version is refused before anything is written", () => {
    assert.throws(() => parseApplyArgs(["--version", "1.2"]));
    assert.throws(() => parseApplyArgs([]));
  });

  test("version resolution defaults to a patch bump and rejects unknown channels", () => {
    assert.equal(parseVersionArgs(["--channel", "testing"]).channel, "testing");
    assert.equal(parseVersionArgs(["--channel", "testing"]).bump, "patch");
    assert.equal(parseVersionArgs(["--channel", "stable", "--bump", ""]).bump, "patch");
    assert.throws(() => parseVersionArgs(["--channel", "nightly"]));
    assert.throws(() => parseVersionArgs(["--bump", "huge"]));
  });

  test("the release branch decides the channel, and no other branch releases", () => {
    assert.equal(parseVersionArgs(["--branch", "main"]).channel, "stable");
    assert.equal(parseVersionArgs(["--branch", "testing"]).channel, "testing");
    for (const branch of ["master", "develop", "feature/updates", "release/1.0"]) {
      assert.throws(() => parseVersionArgs(["--branch", branch]));
    }
  });
});

describe("updater manifest", () => {
  const assetsFor = (version, windowsName = `Nevaska_${version}_x64-setup.exe`) => [
    { name: windowsName, signature: "WINDOWS_SIGNATURE" },
    { name: `Nevaska_${version}_amd64.AppImage`, signature: "LINUX_SIGNATURE" },
    { name: `Nevaska_${version}_amd64.deb`, signature: "DEB_SIGNATURE" },
    { name: `Nevaska_${version}_universal.app.tar.gz`, signature: "MACOS_SIGNATURE" },
  ];
  const assets = assetsFor("1.2.3");

  test("points every official target at its signed artifact on the release", () => {
    const manifest = buildManifest({ version: "1.2.3", repo: REPO, tag: "v1.2.3", notes: "hi", assets });
    assert.equal(manifest.version, "1.2.3");
    assert.equal(manifest.notes, "hi");
    assert.deepEqual(manifest.platforms["windows-x86_64"], {
      signature: "WINDOWS_SIGNATURE",
      url: `https://github.com/${REPO}/releases/download/v1.2.3/Nevaska_1.2.3_x64-setup.exe`,
    });
    assert.deepEqual(manifest.platforms["linux-x86_64"], {
      signature: "LINUX_SIGNATURE",
      url: `https://github.com/${REPO}/releases/download/v1.2.3/Nevaska_1.2.3_amd64.AppImage`,
    });
    assert.deepEqual(manifest.platforms["linux-x86_64-appimage"], manifest.platforms["linux-x86_64"]);
    assert.deepEqual(manifest.platforms["linux-x86_64-deb"], {
      signature: "DEB_SIGNATURE",
      url: `https://github.com/${REPO}/releases/download/v1.2.3/Nevaska_1.2.3_amd64.deb`,
    });
    assert.deepEqual(manifest.platforms["darwin-aarch64"], {
      signature: "MACOS_SIGNATURE",
      url: `https://github.com/${REPO}/releases/download/v1.2.3/Nevaska_1.2.3_universal.app.tar.gz`,
    });
    assert.deepEqual(manifest.platforms["darwin-x86_64"], manifest.platforms["darwin-aarch64"]);
    assert.deepEqual(manifest.platforms["darwin-aarch64-app"], manifest.platforms["darwin-aarch64"]);
    assert.deepEqual(manifest.platforms["darwin-x86_64-app"], manifest.platforms["darwin-x86_64"]);
    assert.deepEqual(manifest.platforms["windows-x86_64-nsis"], manifest.platforms["windows-x86_64"]);
    assert.ok(REQUIRED_PLATFORMS.every((platform) => manifest.platforms[platform]));
    assert.ok(!Number.isNaN(Date.parse(manifest.pub_date)));
  });

  test("beta manifests carry the beta version, so only beta installs accept them", () => {
    const manifest = buildManifest({
      version: "1.2.3-testing.4",
      repo: REPO,
      tag: "v1.2.3-testing.4",
      assets: assetsFor("1.2.3-testing.4"),
    });
    assert.equal(manifest.version, "1.2.3-testing.4");
    assert.match(manifest.platforms["windows-x86_64"].url, /v1\.2\.3-testing\.4/);
  });

  test("accepts the zipped installer layout too", () => {
    for (const name of ["Nevaska_1.2.3_x64-setup.exe.zip", "Nevaska_1.2.3_x64.nsis.zip"]) {
      const manifest = buildManifest({
        version: "1.2.3",
        repo: REPO,
        tag: "v1.2.3",
        assets: assetsFor("1.2.3", name),
      });
      assert.ok(manifest.platforms["windows-x86_64"].url.includes(name));
    }
  });

  test("recognises universal and architecture-specific native updater artifacts", () => {
    assert.deepEqual(platformsForAsset("Nevaska_1.2.3_amd64.AppImage"), [
      "linux-x86_64",
      "linux-x86_64-appimage",
    ]);
    assert.deepEqual(platformsForAsset("Nevaska_1.2.3_universal.app.tar.gz"), [
      "darwin-x86_64",
      "darwin-x86_64-app",
      "darwin-aarch64",
      "darwin-aarch64-app",
    ]);
  });

  test("a partial or ambiguous matrix refuses to publish a manifest", () => {
    assert.throws(() => buildManifest({ version: "1.2.3", repo: REPO, tag: "v1.2.3", assets: [] }));
    assert.throws(() =>
      buildManifest({
        version: "1.2.3",
        repo: REPO,
        tag: "v1.2.3",
        assets: [...assets, { ...assets[1], name: "Nevaska_1.2.3_x86_64.AppImage" }],
      }),
    );
  });

  test("a version we do not recognise never reaches a manifest", () => {
    assert.throws(() => buildManifest({ version: "1.2.3-beta.1", repo: REPO, tag: "x", assets }));
  });

  test("spaces in a release asset name survive the URL", () => {
    assert.equal(
      downloadUrl(REPO, "v1.0.0", "Nev aska_setup.exe"),
      `https://github.com/${REPO}/releases/download/v1.0.0/Nev%20aska_setup.exe`,
    );
  });

  test("collects one asset per .sig file and ignores everything else", () => {
    const files = ["nsis/Nevaska_1.2.3_x64-setup.exe", "nsis/Nevaska_1.2.3_x64-setup.exe.sig", "nsis/notes.txt"];
    const collected = collectAssets("bundle", {
      readdir: () => files,
      readFile: (file) => (file.includes("setup.exe.sig") ? "SIG\n" : "?"),
    });
    assert.deepEqual(collected, [{ name: "Nevaska_1.2.3_x64-setup.exe", signature: "SIG" }]);
  });
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { BETA_POINTER_TAG, endpointFor } from "./apply-version.mjs";
import { channelForBranch, channelOf } from "../src/lib/version.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(ROOT, file), "utf8");
const yaml = (file) => parse(read(file));

const release = yaml(".github/workflows/release.yml");
const releaseText = read(".github/workflows/release.yml");
const ci = yaml(".github/workflows/ci.yml");
const tauriConfig = JSON.parse(read("src-tauri/tauri.conf.json"));
const styles = read("src/styles.css");
const app = read("src/App.tsx");

function runSteps(workflow) {
  return Object.values(workflow.jobs).flatMap((job) =>
    (job.steps ?? []).filter((step) => typeof step.run === "string"),
  );
}

describe("release triggers", () => {
  test("only main and testing can start a release", () => {
    assert.deepEqual(release.on.push.branches, ["main", "testing"]);
    for (const branch of release.on.push.branches) assert.ok(channelForBranch(branch));
  });

  test("no tag, schedule or pull_request trigger can sneak a release out", () => {
    assert.deepEqual(Object.keys(release.on).sort(), ["push", "workflow_dispatch"]);
    assert.equal(release.on.push.tags, undefined);
  });

  test("a manual run still has to be on a release branch", () => {
    const step = runSteps(release).find((s) => s.run.includes("release-version.mjs"));
    assert.ok(step.run.includes("--branch"));
    assert.ok(step.run.includes("$GITHUB_REF_NAME"));
  });

  test("releases run one at a time per branch, so two pushes cannot claim one version", () => {
    assert.ok(release.concurrency.group.includes("github.ref"));
    assert.equal(release.concurrency["cancel-in-progress"], false);
  });

  test("the workflow may write releases", () => {
    assert.equal(release.permissions.contents, "write");
  });
});

describe("channel isolation in the published releases", () => {
  const publish = release.jobs.publish;
  const stableStep = publish.steps.find((s) => s.if?.includes("'stable'") && s.run?.includes("--draft=false --latest"));
  const betaStep = publish.steps.find((s) => s.if?.includes("'testing'") && s.run?.includes("release edit"));

  test("a stable release becomes the repository's Latest", () => {
    assert.ok(stableStep.run.includes("--draft=false"));
    assert.ok(stableStep.run.includes("--latest"));
    assert.ok(!stableStep.run.includes("--prerelease"));
  });

  test("a beta release is a prerelease and never Latest — stable installs cannot reach it", () => {
    assert.ok(betaStep.run.includes("--prerelease"));
    assert.ok(betaStep.run.includes("--latest=false"));
  });

  test("the beta pointer release the workflow writes is the one beta builds read", () => {
    const pointerStep = runSteps(release).find((s) => s.run.includes("release upload") && s.run.includes("BETA_POINTER"));
    assert.equal(release.env.BETA_POINTER_TAG, BETA_POINTER_TAG);
    assert.ok(endpointFor("testing").includes(`/releases/download/${release.env.BETA_POINTER_TAG}/latest.json`));
    assert.ok(pointerStep.run.includes("latest.json"));
    assert.ok(pointerStep.run.includes("nevaska-beta-setup.exe"));
    assert.ok(pointerStep.run.includes("--clobber"));
    assert.ok(pointerStep.run.includes("--prerelease"));
  });

  test("the pointer is only ever written from the beta channel", () => {
    for (const step of release.jobs.publish.steps) {
      if (step.run?.includes("BETA_POINTER_TAG")) assert.ok(step.if.includes("'testing'"));
    }
  });
});

describe("the build job", () => {
  const build = release.jobs.build;
  const validate = release.jobs.validate;
  const manifest = release.jobs.manifest;
  const matrix = build.strategy.matrix.include;

  test("builds each supported native package on the right runner", () => {
    assert.deepEqual(matrix.map((entry) => entry.platform).sort(), ["linux", "macos", "windows"]);
    assert.equal(matrix.find((entry) => entry.platform === "windows").bundles, "nsis");
    assert.equal(matrix.find((entry) => entry.platform === "linux").bundles, "deb,appimage");
    assert.equal(matrix.find((entry) => entry.platform === "macos").bundles, "app,dmg");
    assert.equal(build.strategy["fail-fast"], false);
  });

  test("stamps the resolved version and channel before building", () => {
    const apply = build.steps.findIndex((s) => s.run?.includes("apply-version.mjs"));
    const compile = build.steps.findIndex((s) => s.run?.includes("tauri build"));
    assert.ok(apply >= 0);
    assert.ok(apply < compile);
    assert.ok(build.steps[apply].run.includes("--channel"));
  });

  test("validates the frontend and Linux backend before the native build matrix", () => {
    const validationCommands = runSteps({ jobs: { validate } }).map((step) => step.run);
    assert.ok(validationCommands.some((run) => run.includes("npm test") && run.includes("typecheck")));
    assert.ok(validationCommands.some((run) => run.includes("cargo test --locked")));
    assert.ok(build.needs.includes("validate"));
  });

  test("signs every updater artifact with the repository's private key", () => {
    const step = build.steps.find((s) => s.run?.includes("tauri build"));
    assert.ok(step.env.TAURI_SIGNING_PRIVATE_KEY.includes("secrets.TAURI_SIGNING_PRIVATE_KEY"));
    assert.ok(step.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD.includes("secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD"));
  });

  test("assembles one signed latest.json only after every platform artifact is available", () => {
    const download = manifest.steps.find((step) => step.uses?.startsWith("actions/download-artifact"));
    const generate = manifest.steps.find((step) => step.run?.includes("updater-manifest.mjs"));
    const upload = manifest.steps.find((step) => step.run?.includes("release upload"));
    assert.equal(download.with.pattern, "nevaska-release-*");
    assert.equal(download.with["merge-multiple"], true);
    assert.ok(generate.run.includes("--bundle-dir release-assets"));
    assert.ok(upload.run.includes("latest.json"));
    assert.ok(release.jobs.publish.needs.includes("manifest"));
  });

  test("a test build publishes nothing", () => {
    const upload = manifest.steps.find((s) => s.run?.includes("release upload"));
    const artifact = manifest.steps.find((s) => s.uses?.startsWith("actions/upload-artifact"));
    assert.ok(upload.if.includes("publish == 'true'"));
    assert.ok(artifact.if.includes("publish != 'true'"));
    assert.ok(release.jobs.publish.if.includes("publish == 'true'"));
  });

  test("opens the GitHub release as a draft before any asset is uploaded", () => {
    assert.ok(releaseText.includes("gh release create"));
    assert.ok(releaseText.includes("--draft"));
    const versionJob = release.jobs.version;
    const create = versionJob.steps.find((s) => s.run?.includes("gh release create"));
    assert.ok(create);
    assert.ok(create.run.includes("--draft"));
  });
});

describe("CI workflow", () => {
  test("covers the branches the release workflow ignores", () => {
    assert.deepEqual(ci.on.push["branches-ignore"], ["main", "testing"]);
    assert.ok("pull_request" in ci.on);
  });

  test("cannot publish a release", () => {
    assert.ok(!read(".github/workflows/ci.yml").includes("gh release"));
    assert.equal(ci.permissions, undefined);
  });

  test("runs the same checks the release build runs", () => {
    const commands = runSteps(ci).map((s) => s.run.trim());
    assert.ok(commands.some((c) => c.includes("npm run typecheck")));
    assert.ok(commands.some((c) => c.includes("npm test")));
    assert.ok(commands.some((c) => c.includes("cargo test --locked --manifest-path src-tauri/Cargo.toml")));
  });
});

describe("the shipped app configuration", () => {
  test("reads the endpoint of the channel its version belongs to, and only that one", () => {
    const endpoints = tauriConfig.plugins.updater.endpoints;
    assert.equal(endpoints.length, 1);
    const repo = /github\.com\/([^/]+\/[^/]+)\//.exec(endpoints[0])?.[1];
    assert.ok(repo);
    assert.equal(endpoints[0], endpointFor(channelOf(tauriConfig.version), repo));
  });

  test("carries a public key, so an unsigned update is rejected", () => {
    assert.match(tauriConfig.plugins.updater.pubkey, /^[A-Za-z0-9+/=]{40,}$/);
  });

  test("produces the artifacts the updater downloads", () => {
    assert.equal(tauriConfig.bundle.createUpdaterArtifacts, true);
    assert.ok(["nsis", "deb", "appimage", "dmg"].every((t) => tauriConfig.bundle.targets.includes(t)));
  });

  test("installs per user, so neither installing nor updating asks for admin", () => {
    assert.equal(tauriConfig.bundle.windows.nsis.installMode, "currentUser");
    assert.equal(tauriConfig.plugins.updater.windows.installMode, "passive");
  });

  test("the version in the repository is a version the release scripts understand", () => {
    const pkg = JSON.parse(read("package.json"));
    assert.equal(pkg.version, tauriConfig.version);
    assert.ok(read("src-tauri/Cargo.toml").includes(`version = "${pkg.version}"`));
  });

  test("the app can call the updater and restart itself", () => {
    const capabilities = JSON.parse(read("src-tauri/capabilities/default.json"));
    assert.ok(capabilities.permissions.includes("updater:default"));
    assert.ok(capabilities.permissions.includes("process:allow-restart"));
  });

  test("the release workflow is the only workflow that touches versions", () => {
    assert.ok(releaseText.includes("apply-version.mjs"));
    assert.ok(!read(".github/workflows/ci.yml").includes("apply-version"));
  });
});

describe("blizzard chrome", () => {
  test("dark and light tokens are the ones the brief named", () => {
    assert.match(styles, /--night:\s*#151515/i);
    assert.match(styles, /--snow:\s*#F5F5F5/i);
  });

  test("the shell has no eyebrow copy", () => {
    assert.doesNotMatch(app, /eyebrow/i);
    assert.doesNotMatch(styles, /eyebrow/i);
  });

  test("engines can be added with Stockfish and lc0 called out", () => {
    assert.match(app, /Stockfish/);
    assert.match(app, /lc0/);
    assert.match(app, /pickEngine/);
  });

  test("there is a control to check and install updates", () => {
    assert.match(app, /doCheck/);
    assert.match(app, /doInstall/);
    assert.match(app, /Updates/);
  });
});

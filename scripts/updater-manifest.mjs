/**
 * Builds the `latest.json` the Tauri updater reads, from the signed artifacts
 * `tauri build` just produced.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { parseVersion } from "../src/lib/version.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BUNDLE_DIR = "src-tauri/target/release/bundle";

const WINDOWS_ARTIFACT = /-setup\.exe(\.zip)?$|\.nsis\.zip$/;
const LINUX_ARTIFACT = /\.AppImage(?:\.tar\.gz)?$/;
const DEB_ARTIFACT = /\.deb$/;
const MACOS_ARTIFACT = /\.app\.tar\.gz$/;

export const REQUIRED_PLATFORMS = [
  "windows-x86_64",
  "windows-x86_64-nsis",
  "linux-x86_64",
  "linux-x86_64-appimage",
  "linux-x86_64-deb",
  "darwin-x86_64",
  "darwin-x86_64-app",
  "darwin-aarch64",
  "darwin-aarch64-app",
];

export function downloadUrl(repo, tag, assetName) {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
}

export function collectAssets(dir, { readdir = readdirSync, readFile } = {}) {
  const read = readFile ?? ((file) => readFileSync(file, "utf8"));
  const entries = readdir(dir, { recursive: true, withFileTypes: false });
  return entries
    .map((entry) => String(entry).split(path.sep).join("/"))
    .filter((entry) => entry.endsWith(".sig"))
    .map((entry) => ({
      name: entry.slice(entry.lastIndexOf("/") + 1, -".sig".length),
      signature: read(path.join(dir, entry)).trim(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function platformsForAsset(name) {
  if (WINDOWS_ARTIFACT.test(name)) return ["windows-x86_64", "windows-x86_64-nsis"];
  if (LINUX_ARTIFACT.test(name)) {
    if (/(?:aarch64|arm64)/i.test(name)) return ["linux-aarch64", "linux-aarch64-appimage"];
    return ["linux-x86_64", "linux-x86_64-appimage"];
  }
  if (DEB_ARTIFACT.test(name)) {
    if (/(?:aarch64|arm64)/i.test(name)) return ["linux-aarch64-deb"];
    return ["linux-x86_64-deb"];
  }
  if (MACOS_ARTIFACT.test(name)) {
    if (/universal/i.test(name)) {
      return ["darwin-x86_64", "darwin-x86_64-app", "darwin-aarch64", "darwin-aarch64-app"];
    }
    if (/(?:aarch64|arm64)/i.test(name)) return ["darwin-aarch64", "darwin-aarch64-app"];
    if (/(?:x86_64|x64|amd64)/i.test(name)) return ["darwin-x86_64", "darwin-x86_64-app"];
  }
  return [];
}

export function buildManifest({ version, repo, tag, notes = "", pubDate = new Date().toISOString(), assets }) {
  if (!parseVersion(version)) throw new Error(`not a Nevaska version: ${version}`);
  const platforms = {};

  for (const asset of assets) {
    const entry = { signature: asset.signature, url: downloadUrl(repo, tag, asset.name) };
    for (const platform of platformsForAsset(asset.name)) {
      if (platforms[platform]) {
        throw new Error(`multiple signed updater artifacts for ${platform}`);
      }
      platforms[platform] = entry;
    }
  }

  const missing = REQUIRED_PLATFORMS.filter((platform) => !platforms[platform]);
  if (missing.length) {
    throw new Error(
      `missing signed updater artifacts for ${missing.join(", ")} among: ${
        assets.map((asset) => asset.name).join(", ") || "(none)"
      }`,
    );
  }

  return {
    version,
    notes,
    pub_date: pubDate,
    platforms,
  };
}

export function parseArgs(argv) {
  const args = {
    repo: process.env.GITHUB_REPOSITORY || "MusicMaster4/Nevaska",
    bundleDir: DEFAULT_BUNDLE_DIR,
    out: "latest.json",
    notes: "",
  };
  const keys = { "--version": "version", "--tag": "tag", "--repo": "repo", "--notes": "notes", "--bundle-dir": "bundleDir", "--out": "out" };
  for (let i = 0; i < argv.length; i += 1) {
    const key = keys[argv[i]];
    if (!key) throw new Error(`unknown argument: ${argv[i]}`);
    args[key] = argv[++i];
  }
  if (!args.version) throw new Error("--version is required");
  if (!args.tag) args.tag = `v${args.version}`;
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = path.isAbsolute(args.bundleDir) ? args.bundleDir : path.join(ROOT, args.bundleDir);
  const assets = collectAssets(dir);
  const manifest = buildManifest({ ...args, assets });
  writeFileSync(path.isAbsolute(args.out) ? args.out : path.join(ROOT, args.out), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${args.out} → ${REQUIRED_PLATFORMS.length} updater platforms`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();

/**
 * Resolves the version the next release should carry, from the tags already in
 * the repository.
 *
 *   node scripts/release-version.mjs --branch testing [--bump patch|minor|major]
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { channelForBranch, resolveVersion } from "../src/lib/version.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseArgs(argv) {
  const args = { channel: "stable", bump: "patch" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--channel" || arg === "--bump" || arg === "--branch") args[arg.slice(2)] = argv[++i];
    else if (arg === "--dry-run") args.dryRun = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.bump) args.bump = "patch";
  if (args.branch) {
    const channel = channelForBranch(args.branch);
    if (!channel) throw new Error(`branch ${args.branch} does not publish releases (only main and testing do)`);
    args.channel = channel;
  }
  if (!["stable", "testing"].includes(args.channel)) {
    throw new Error(`--channel must be stable or testing, got: ${args.channel}`);
  }
  if (!["patch", "minor", "major"].includes(args.bump)) {
    throw new Error(`--bump must be patch, minor or major, got: ${args.bump}`);
  }
  return args;
}

function gitTags() {
  return execFileSync("git", ["tag", "--list"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const packageVersion = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  const version = resolveVersion({
    channel: args.channel,
    tags: gitTags(),
    packageVersion,
    level: args.bump,
  });

  const output = [`version=${version}`, `tag=v${version}`, `channel=${args.channel}`];
  console.log(output.join("\n"));
  if (process.env.GITHUB_OUTPUT && !args.dryRun) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${output.join("\n")}\n`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();

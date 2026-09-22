import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import https from "node:https";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destDir = path.join(root, "src-tauri", "resources", "stockfish");
const TAG = "sf_19";

function asset() {
  const base = `https://github.com/official-stockfish/Stockfish/releases/download/${TAG}`;
  if (process.platform === "win32") {
    const arch = process.arch === "arm64" ? "arm64" : "x86-64";
    return { url: `${base}/stockfish-windows-${arch}-universal.zip`, name: "stockfish.exe" };
  }
  if (process.platform === "darwin") {
    return { url: `${base}/stockfish-macos-universal.tar.gz`, name: "stockfish" };
  }
  const arch = process.arch === "arm64" ? "arm64" : "x86-64";
  return { url: `${base}/stockfish-linux-${arch}-universal.tar.gz`, name: "stockfish" };
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "nevaska" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        download(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Stockfish download failed (${res.statusCode})`));
        return;
      }
      const file = createWriteStream(dest);
      res.pipe(file);
      file.on("finish", () => file.close((err) => (err ? reject(err) : resolve())));
      file.on("error", reject);
    });
    req.on("error", reject);
  });
}

async function extract(archive, destDir) {
  // Git for Windows puts GNU tar first on PATH. That tar reads "C:" as a remote
  // host ("Cannot connect to C: resolve failed") and does not unpack zip files.
  // Windows ships bsdtar, which extracts the Stockfish zip from a drive path.
  if (process.platform === "win32") {
    const systemTar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    await exec(systemTar, ["-xf", archive, "-C", destDir]);
    return;
  }
  await exec("tar", ["-xf", path.basename(archive)], { cwd: destDir });
}

async function findBinary(dir) {
  const { readdir } = await import("node:fs/promises");
  const found = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/^stockfish/i.test(entry.name) && !/\.(txt|md|cff)$/i.test(entry.name)) found.push(full);
    }
  }
  await walk(dir);
  if (!found.length) throw new Error("Stockfish archive did not contain a binary");
  const sized = await Promise.all(found.map(async (file) => ({ file, size: (await stat(file)).size })));
  sized.sort((a, b) => b.size - a.size);
  return sized[0].file;
}

const { url, name } = asset();
const dest = path.join(destDir, name);
await mkdir(destDir, { recursive: true });
try {
  if ((await stat(dest)).size > 5_000_000) {
    console.log(`Stockfish 19 already at ${dest}`);
    process.exit(0);
  }
} catch {
  /* download */
}

const tmp = await mkdtemp(path.join(tmpdir(), "nevaska-stockfish-"));
try {
  const archive = path.join(tmp, path.basename(url));
  console.log(`Downloading Stockfish 19 from ${url}`);
  await download(url, archive);
  await extract(archive, tmp);
  await copyFile(await findBinary(tmp), dest);
  if (process.platform !== "win32") await chmod(dest, 0o755);
  console.log(`Stockfish 19 ready at ${dest}`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}

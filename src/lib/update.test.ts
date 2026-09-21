import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { channelLabel, checkForUpdateWith, selectUpdate, type UpdateIo } from "./update.ts";

function io(current: string, served: { version: string; body?: string; date?: string } | null): UpdateIo & {
  installed: number;
  relaunched: number;
  length?: number;
} {
  const state = { installed: 0, relaunched: 0, length: 200 as number | undefined };
  const fake: UpdateIo & { installed: number; relaunched: number; length?: number } = {
    get installed() {
      return state.installed;
    },
    get relaunched() {
      return state.relaunched;
    },
    getVersion: async () => current,
    check: async () =>
      served && {
        ...served,
        downloadAndInstall: async (onEvent) => {
          state.installed += 1;
          onEvent?.({ event: "Started", data: { contentLength: state.length } });
          onEvent?.({ event: "Progress", data: { chunkLength: 100 } });
          onEvent?.({ event: "Finished", data: {} });
        },
      },
    relaunch: async () => {
      state.relaunched += 1;
    },
  };
  Object.defineProperty(fake, "length", {
    get: () => state.length,
    set: (v) => {
      state.length = v;
    },
  });
  return fake;
}

describe("what the app accepts as an update", () => {
  test("a stable install takes a newer stable release", async () => {
    const update = await checkForUpdateWith(io("1.0.0", { version: "1.0.1", body: "notes", date: "2026-01-01" }));
    assert.equal(update?.version, "1.0.1");
    assert.equal(update?.notes, "notes");
  });

  test("a stable install refuses a beta, even a newer one", async () => {
    assert.equal(await checkForUpdateWith(io("1.0.0", { version: "9.9.9-testing.1" })), null);
    assert.equal(selectUpdate("1.0.0", { version: "9.9.9-testing.1" }), null);
  });

  test("a beta install takes a newer beta", async () => {
    const update = await checkForUpdateWith(io("1.0.1-testing.1", { version: "1.0.1-testing.2" }));
    assert.equal(update?.version, "1.0.1-testing.2");
  });

  test("a beta install refuses a stable release", async () => {
    assert.equal(await checkForUpdateWith(io("1.0.1-testing.1", { version: "1.0.1" })), null);
  });

  test("nothing to install when the plugin reports no update", async () => {
    assert.equal(await checkForUpdateWith(io("1.0.0", null)), null);
  });

  test("a manifest with a version we cannot read is ignored", async () => {
    assert.equal(await checkForUpdateWith(io("1.0.0", { version: "2026.07-nightly" })), null);
  });
});

describe("installing", () => {
  test("reports progress and hands over to the installer", async () => {
    const fake = io("1.0.0", { version: "1.0.1" });
    const update = await checkForUpdateWith(fake);
    const seen: Array<number | null> = [];
    await update!.install((fraction) => seen.push(fraction));
    assert.equal(fake.installed, 1);
    assert.deepEqual(seen, [0, 0.5, 1]);
    assert.equal(fake.relaunched, 1);
  });

  test("a download of unknown size reports indeterminate progress, not 0%", async () => {
    const fake = io("1.0.0", { version: "1.0.1" });
    fake.length = undefined;
    const update = await checkForUpdateWith(fake);
    const seen: Array<number | null> = [];
    await update!.install((fraction) => seen.push(fraction));
    assert.deepEqual(seen, [null, null, 1]);
  });
});

describe("channel labelling", () => {
  test("names the channel the build belongs to", () => {
    assert.equal(channelLabel("1.0.0"), "stable");
    assert.equal(channelLabel("1.0.1-testing.3"), "beta");
  });
});

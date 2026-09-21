import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  bump,
  channelForBranch,
  channelOf,
  compareVersions,
  formatVersion,
  isUpdateFor,
  latestIteration,
  latestStable,
  parseVersion,
  resolveVersion,
} from "./version.ts";

const v = (input: string) => {
  const parsed = parseVersion(input);
  if (!parsed) throw new Error(`bad test fixture: ${input}`);
  return parsed;
};

describe("parsing", () => {
  test("reads stable and beta versions, with or without the tag prefix", () => {
    assert.deepEqual(parseVersion("1.2.3"), { major: 1, minor: 2, patch: 3, channel: "stable", iteration: 0 });
    assert.deepEqual(parseVersion("v1.2.3"), { major: 1, minor: 2, patch: 3, channel: "stable", iteration: 0 });
    assert.deepEqual(parseVersion("v10.0.99-testing.7"), {
      major: 10,
      minor: 0,
      patch: 99,
      channel: "testing",
      iteration: 7,
    });
  });

  test("rejects anything that is not one of our two shapes", () => {
    for (const input of ["", "1.2", "1.2.3.4", "1.2.3-beta.1", "1.2.3-testing", "1.2.3-testing.x", "nightly"]) {
      assert.equal(parseVersion(input), null);
    }
  });

  test("round-trips through formatVersion", () => {
    for (const input of ["0.0.0", "1.2.3", "1.2.3-testing.1", "99.99.99-testing.100"]) {
      assert.equal(formatVersion(v(input)), input);
    }
  });

  test("an unrecognised version counts as stable, never as beta", () => {
    assert.equal(channelOf("1.2.3"), "stable");
    assert.equal(channelOf("1.2.3-testing.4"), "testing");
    assert.equal(channelOf("banana"), "stable");
  });
});

describe("odometer", () => {
  test("patch fills up to 99 then carries into minor", () => {
    assert.equal(formatVersion(bump(v("1.0.0"), "patch")), "1.0.1");
    assert.equal(formatVersion(bump(v("1.0.98"), "patch")), "1.0.99");
    assert.equal(formatVersion(bump(v("1.0.99"), "patch")), "1.1.0");
  });

  test("minor fills up to 99 then carries into major", () => {
    assert.equal(formatVersion(bump(v("1.99.0"), "minor")), "2.0.0");
    assert.equal(formatVersion(bump(v("1.99.99"), "patch")), "2.0.0");
    assert.equal(formatVersion(bump(v("0.99.99"), "patch")), "1.0.0");
  });

  test("explicit minor and major bumps reset what sits below them", () => {
    assert.equal(formatVersion(bump(v("1.2.34"), "minor")), "1.3.0");
    assert.equal(formatVersion(bump(v("1.2.34"), "major")), "2.0.0");
    assert.equal(formatVersion(bump(v("9.99.99"), "major")), "10.0.0");
  });

  test("a bump off a beta lands on a plain stable version", () => {
    assert.equal(formatVersion(bump(v("1.0.3-testing.9"), "patch")), "1.0.4");
  });
});

describe("channel isolation", () => {
  test("a beta install is offered newer betas only", () => {
    assert.equal(isUpdateFor("1.0.3-testing.1", "1.0.3-testing.2"), true);
    assert.equal(isUpdateFor("1.0.3-testing.2", "1.0.3-testing.2"), false);
    assert.equal(isUpdateFor("1.0.3-testing.2", "1.0.3-testing.1"), false);
  });

  test("a beta install never sees a stable release, even a newer one", () => {
    assert.equal(isUpdateFor("1.0.3-testing.1", "1.0.3"), false);
    assert.equal(isUpdateFor("1.0.3-testing.1", "9.9.9"), false);
  });

  test("a stable install never sees a beta, even a newer one", () => {
    assert.equal(isUpdateFor("1.0.2", "1.0.3-testing.4"), false);
    assert.equal(isUpdateFor("1.0.2", "9.9.9-testing.1"), false);
  });

  test("a stable install is offered newer stable releases only", () => {
    assert.equal(isUpdateFor("1.0.2", "1.0.3"), true);
    assert.equal(isUpdateFor("1.0.99", "1.1.0"), true);
    assert.equal(isUpdateFor("1.0.3", "1.0.2"), false);
  });
});

describe("ordering", () => {
  test("a beta sorts below the stable release it leads to", () => {
    assert.ok(compareVersions(v("1.0.3-testing.99"), v("1.0.3")) < 0);
    assert.equal(compareVersions(v("1.0.3"), v("1.0.3")), 0);
  });
});

describe("reading the tag list", () => {
  const tags = ["v0.9.0", "v1.0.0", "v1.0.1-testing.1", "v1.0.1-testing.2", "not-a-tag", "v1.0.1-testing.10"];

  test("the latest stable ignores betas and junk", () => {
    assert.equal(formatVersion(latestStable(tags)!), "1.0.0");
    assert.equal(latestStable(["nightly", "v1.0.1-testing.1"]), null);
  });

  test("the beta counter is per base version and compares numerically", () => {
    assert.equal(latestIteration(tags, v("1.0.1")), 10);
    assert.equal(latestIteration(tags, v("1.0.2")), 0);
  });
});

describe("resolving the next release", () => {
  test("the first main release is 1.0.0 while testing still comes from package.json", () => {
    assert.equal(resolveVersion({ channel: "stable", tags: [], packageVersion: "0.1.0" }), "1.0.0");
    assert.equal(resolveVersion({ channel: "testing", tags: [], packageVersion: "0.1.0" }), "0.1.0-testing.1");
  });

  test("beta tags do not stop the first main merge from becoming 1.0.0", () => {
    const tags = ["v0.1.0-testing.1", "v0.1.0-testing.17"];
    assert.equal(resolveVersion({ channel: "stable", tags, packageVersion: "0.1.0" }), "1.0.0");
  });

  test("stable releases after 1.0.0 increment the patch", () => {
    assert.equal(resolveVersion({ channel: "stable", tags: ["v1.0.0"], packageVersion: "0.1.0" }), "1.0.1");
    assert.equal(
      resolveVersion({ channel: "stable", tags: ["v1.0.0", "v1.0.1"], packageVersion: "0.1.0" }),
      "1.0.2",
    );
  });

  test("betas count up against the stable release they lead to", () => {
    const tags = ["v1.0.0"];
    assert.equal(resolveVersion({ channel: "testing", tags, packageVersion: "0.1.0" }), "1.0.1-testing.1");
    assert.equal(
      resolveVersion({ channel: "testing", tags: [...tags, "v1.0.1-testing.1"], packageVersion: "0.1.0" }),
      "1.0.1-testing.2",
    );
  });

  test("publishing stable does not reuse a beta counter", () => {
    const tags = ["v1.0.0", "v1.0.1-testing.1", "v1.0.1-testing.2"];
    assert.equal(resolveVersion({ channel: "stable", tags, packageVersion: "0.1.0" }), "1.0.1");
  });

  test("a higher package.json version wins on both channels after stable releases begin", () => {
    const tags = ["v1.0.0"];
    assert.equal(resolveVersion({ channel: "stable", tags, packageVersion: "2.5.0" }), "2.5.0");
    assert.equal(resolveVersion({ channel: "testing", tags, packageVersion: "2.5.0" }), "2.5.0-testing.1");
  });

  test("only main and testing map to a channel", () => {
    assert.equal(channelForBranch("main"), "stable");
    assert.equal(channelForBranch("refs/heads/main"), "stable");
    assert.equal(channelForBranch("testing"), "testing");
    assert.equal(channelForBranch("refs/heads/testing"), "testing");
    for (const branch of ["master", "develop", "feature/x", "release", "main-2", "testing/x"]) {
      assert.equal(channelForBranch(branch), null);
    }
  });
});

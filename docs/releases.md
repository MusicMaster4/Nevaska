# Releases and updates

This pipeline follows [Duckweed's desktop release flow](https://github.com/MusicMaster4/Duckweed/blob/main/docs/releases.md).
The production repository is `MusicMaster4/Nevaska`. Local builds default to
that repository; CI stamps the actual repository into the app configuration.

Nevaska ships from two branches, on two update channels that never see each
other's releases.

| Branch    | Channel  | Version              | GitHub release | Who gets it                     |
| --------- | -------- | -------------------- | -------------- | ------------------------------- |
| `main`    | stable   | `1.0.4`              | Latest         | Everyone on a stable install    |
| `testing` | beta     | `1.0.4-testing.2`    | Pre-release    | Everyone on a beta install      |

Every push to one of those two branches builds Windows, macOS, and Linux
packages, tags them, and publishes them together. No other branch publishes
anything. The channel is derived from the branch name and the run stops if the
branch is not one of these two.

## One-time setup

The updater only installs updates that are signed with the project's key, so the
repository needs two secrets before the first release.

1. Generate a key pair (once, ever — losing it means shipped installs can no
   longer be updated):

   ```bash
   npx tauri signer generate -w nevaska-updater.key
   ```

   Keep `nevaska-updater.key` out of the repository. The matching public key is
   already committed in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`;
   if you generate a new pair, replace it there.

2. Add the secrets in **Settings → Secrets and variables → Actions**:

   | Secret                               | Value                                              |
   | ------------------------------------ | -------------------------------------------------- |
   | `TAURI_SIGNING_PRIVATE_KEY`          | the whole contents of `nevaska-updater.key`        |
   | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the password you chose (leave empty if you set none) |

3. In **Settings → Actions → General**, make sure workflows have
   *Read and write permissions* so the release job can push tags and create
   releases.

That is enough for signed updater artifacts on every platform. The first push to
`main` or `testing` after that can publish a release.

### Optional macOS Developer ID signing and notarization

The macOS job uses an ad-hoc signature when Apple credentials are absent. Add
these repository secrets when a Developer ID certificate is available:

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64-encoded Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | Password used when exporting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | Full Developer ID Application identity |
| `KEYCHAIN_PASSWORD` | Temporary CI keychain password |
| `APPLE_ID` | Apple developer account email |
| `APPLE_PASSWORD` | App-specific password for that Apple ID |
| `APPLE_TEAM_ID` | Apple Developer team ID |

Missing Apple secrets never block the Windows or Linux jobs.

## Version numbers

Versions are `major.minor.patch` and roll like an odometer:

- patch fills `0..99`, then carries: `1.0.99` → `1.1.0`
- minor fills `0..99`, then carries: `1.99.99` → `2.0.0`
- major is unbounded

Both channels count from the newest **stable** tag. A beta is the next stable
version plus a counter:

```
main:     v1.0.3 ───────────────────────────────────► v1.0.4 ──────────► v1.0.5
testing:         └─► v1.0.4-testing.1 ─► …-testing.2 ─┘  └─► v1.0.5-testing.1
```

Publishing `v1.0.4` from `main` restarts the beta counter, because the betas now
work toward `v1.0.5`.

Before any stable tag exists, the first PR merged into `main` publishes
`v1.0.0`. Later merges publish `v1.0.1`, `v1.0.2`, and so on.

Two ways to steer it:

- **A bigger jump for one release**: run the workflow by hand
  (Actions → Release → Run workflow) and pick `minor` or `major`.
- **An exact number**: set it in `package.json` on the release branch, higher
  than the newest stable tag. That run uses it as-is (`2.5.0` on `testing`
  becomes `2.5.0-testing.1`).

Preview what the next release would be called, without publishing:

```bash
npm run version:next -- --channel testing
```

## What a release run does

1. **Resolve version** (`scripts/release-version.mjs`) — reads every tag, works
   out the next version for the branch's channel, pushes the tag, and opens a
   **draft** release. Drafts are invisible to the updater, so a half-finished
   release can never be handed to an app.
2. **Validate** (Linux runner) stamps the version and channel, runs the
   TypeScript check, Node tests, and `cargo test` / `cargo check`, and stops the
   build matrix if any source-level check fails.
3. **Build** (native runner matrix) stamps the same version and channel into
   each checkout, then builds and updater-signs Windows x64 NSIS, a universal
   macOS DMG, and Linux x64 deb plus AppImage packages.
4. **Assemble** downloads every matrix artifact into one job. It writes a single
   `latest.json` with default and installer-specific entries for Windows x64,
   Linux x64 AppImage and deb, macOS Intel, and macOS Apple Silicon. The
   manifest script refuses a partial or ambiguous matrix.
   Only this job uploads assets to the draft GitHub Release.
5. **Publish** flips the draft off. Stable becomes the repository's *Latest*;
   beta stays a *Pre-release* and is explicitly never marked latest. The
   permanent `channel-testing` release then receives the new beta manifest and
   a copy of its installer under the fixed name `nevaska-beta-setup.exe`.

Nothing is committed back to the branch: the version lives in the tags, and the
stamped files only exist inside the build.

## How the two channels stay apart

Each build is compiled with exactly **one** update endpoint:

| Channel | Endpoint                                                        |
| ------- | --------------------------------------------------------------- |
| stable  | `…/releases/latest/download/latest.json`                          |
| beta    | `…/releases/download/channel-testing/latest.json`                 |

GitHub's `/releases/latest` resolves to the newest release that is **not** a
prerelease, and every beta is a prerelease — so a stable install cannot reach a
beta even in principle. Beta installs read a manifest that only beta runs ever
write, and which is itself attached to a prerelease so it stays out of the stable
lookup.

On top of that, the app checks the channel of any update it is offered
(`src/lib/update.ts` and `src-tauri/src/channel.rs`) and refuses one from the
other channel. Both locks are covered by tests.

**Switching channels** is done by installing the other build by hand.

## Checking for updates in the app

Open **Updates** in the top-right corner, then **Check for updates**. The panel
shows the installed version and its stable or beta channel. **Download and
install** downloads the signed package, shows progress, installs it and restarts
the app. Failed checks and installations show an error and can be retried.
The native updater and frontend both reject versions from the other channel.

Before a channel's first published release, its update URL returns an error
because no manifest exists yet. Draft releases are not available to installed
apps. The release workflow checks for the signing key before creating a tag or
draft; the private key must match the public key already embedded in the app.

## Testing the pipeline

```bash
npm test
npm run typecheck
npm run test:rust
```

The fake UCI engine is enabled only by the `test-support` Cargo feature and lives
under `tests/support`. CI enables that feature for tests, but release packaging
does not: test executables must not be shipped in native installers (in
particular the universal macOS bundle).

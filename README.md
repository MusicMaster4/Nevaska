# Nevaska

A local chess GUI. Play against Stockfish or lc0, pit engines against each other, or sit on a position and watch the lines come in.

The board is the whole point. Dark `#151515`, snow `#F5F5F5`, a quiet frost rim. Engines, clocks, and PGN stay off to the side.

## Run

You need [Node 24+](https://nodejs.org/), [Rust](https://www.rust-lang.org/tools/install), and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
npm install
npm run tauri dev
```

## Engines

Nevaska does not bundle Stockfish or lc0. Add a UCI binary from the engines panel:

- **Stockfish** — pick the executable. Threads, Hash, a custom NNUE (`EvalFile`), and `UCI_Elo` when the engine advertises them.
- **lc0** — same path, with `WeightsFile` for the network.
- **UCI** — any other UCI engine.

Human vs engine, engine vs engine, and analysis all use the same process pipe.

## Updates

Stable builds come from `main`. Beta builds come from `testing`. A stable install only receives stable updates; a beta install only receives beta updates. The in-app Updates panel checks, downloads, and installs.

See [docs/releases.md](docs/releases.md) for signing keys, versioning, and the GitHub Actions flow.

## Checks

```bash
npm test
npm run typecheck
npm run test:rust
```

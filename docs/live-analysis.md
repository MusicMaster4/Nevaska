# Board and live engine analysis

Drag a piece to a legal destination, or click its origin and destination. Promotion opens a piece chooser. A drop outside the board or on an illegal square does not play a move.

Right-drag draws another arrow without clearing previous annotations. Any other mouse button clears annotations, including clicks outside the board. Engine arrows are optional in the analysis panel and are also hidden by that interaction until enabled again or the position changes.

The chart icon opens the analysis panel. Closing it leaves the evaluation bar and the engine running. With registered engines, Stockfish is selected at startup when available. Evaluation and WDL are normalized to White's perspective; flipping the board also flips the evaluation bar. Depth counts individual plies, not pairs of moves or guaranteed predictions. Missing engine statistics display a dash.

The panel reports principal variations in SAN, depth and selective depth, nodes, nodes per second, search time, hash occupancy, tablebase hits, legal moves, WDL when advertised, and the current FEN. Configure one to four variations in the engine settings.

Searches use the original FEN plus move history, including for imported positions. Position changes invalidate and terminate old searches before launching new ones. Separate processes support an analysis engine alongside an engine playing a move. Engine processes run with their executable directory as working directory so bundled neural networks are found.

## Verification

- `npm test`: existing frontend/release tests and board rendering probe.
- `npm run test:ui`: browser interaction tests with an IPC fixture.
- `npm run test:rust`: chess rules, UCI process tests, statistics parsing and imported FEN searches.
- `node scripts/check-engine.mjs <executable>`: a real UCI handshake and timed search.
- `node scripts/check-native-app.mjs`: optional local integration check against a Nevaska WebView2 instance started with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223 --remote-debugging-address=127.0.0.1`. Requires the two local engine IDs used by this workstation. Restart normally afterwards to remove the debugging endpoint.

On the development workstation, Stockfish 19 universal x86-64 and Lc0 0.32.1 CUDA 12 were installed outside the repository. SHA-256 matched the official release assets. Real searches returned legal moves; Lc0 reported the RTX 3070 and cuda-fp16 backend. The native integration test exercised both installed engines, MultiPV, drag/drop, arrows, undo and the always-visible evaluation bar. Computer Use checked the browser UI; the native Windows Computer Use service was unavailable, so native interaction verification used the local WebView2 test connection instead.

Sources: [Stockfish downloads](https://stockfishchess.org/download/) and [Lc0 downloads](https://lczero.org/play/download/). Engine binaries, neural networks and machine-specific registration are not part of the repository.

## Visual assets

Pieces are provided by `react-chessboard` (MIT, Ryan Gregory); toolbar icons by `lucide-react` (ISC). The existing dark/ice palette and typography are retained.

The logo was edited with the built-in image generation tool and saved to `public/icon.png`; platform icons were regenerated with `tauri icon`. Edit brief: preserve the ice chess king, snowflake and dark rounded square; replace only the white outside corners with real alpha transparency. The original generated image remains in the local generation output directory.

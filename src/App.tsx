import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import { Board } from "./Board";
import {
  addArrow,
  addEngine,
  channelInfo,
  clearArrows,
  configurePlay,
  exportPgn,
  gameState,
  listArrows,
  listEngines,
  loadFen,
  loadPgn,
  newGame,
  playMove,
  removeEngine,
  stopSearch,
  undoMove,
  updateEngine,
} from "./lib/ipc";
import type {
  BoardArrow,
  ChannelInfo,
  EngineConfig,
  GameState,
  InfoLine,
  PlayMode,
} from "./lib/types";
import { EMPTY_GAME } from "./lib/types";
import { checkForUpdate, channelLabel, type AvailableUpdate } from "./lib/update";

type Panel = "none" | "engines" | "game" | "updates" | "pgn";

const TIMES = [
  { label: "1+0", initial: 60_000, inc: 0 },
  { label: "3+2", initial: 180_000, inc: 2_000 },
  { label: "5+0", initial: 300_000, inc: 0 },
  { label: "10+0", initial: 600_000, inc: 0 },
  { label: "15+10", initial: 900_000, inc: 10_000 },
];

function Icon({ d, title }: { d: string; title: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-label={title}>
      <path d={d} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function formatClock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function evalHeight(info: InfoLine | undefined) {
  if (!info) return 50;
  if (info.score_mate != null) return info.score_mate > 0 ? 96 : 4;
  const cp = info.score_cp ?? 0;
  const n = 1 / (1 + Math.exp(-cp / 280));
  return Math.min(96, Math.max(4, n * 100));
}

function scoreText(info: InfoLine) {
  if (info.score_mate != null) return `M${info.score_mate}`;
  if (info.score_cp != null) return (info.score_cp / 100).toFixed(2);
  return "·";
}

function resultText(game: GameState) {
  const r = game.result;
  if (r.kind === "playing") return null;
  if (r.kind === "checkmate") return r.winner === "white" ? "1–0" : "0–1";
  return "½–½";
}

export default function App() {
  const [game, setGame] = useState<GameState>(EMPTY_GAME);
  const [flipped, setFlipped] = useState(false);
  const [engines, setEngines] = useState<EngineConfig[]>([]);
  const [arrows, setArrows] = useState<BoardArrow[]>([]);
  const [lines, setLines] = useState<InfoLine[]>([]);
  const [panel, setPanel] = useState<Panel>("none");
  const [whiteMs, setWhiteMs] = useState(600_000);
  const [blackMs, setBlackMs] = useState(600_000);
  const [time, setTime] = useState(TIMES[3]);
  const [mode, setMode] = useState<PlayMode>("human_human");
  const [whiteEngine, setWhiteEngine] = useState<string | null>(null);
  const [blackEngine, setBlackEngine] = useState<string | null>(null);
  const [analysisEngine, setAnalysisEngine] = useState<string | null>(null);
  const [pgn, setPgn] = useState("");
  const [fen, setFen] = useState(EMPTY_GAME.fen);
  const [channel, setChannel] = useState<ChannelInfo | null>(null);
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [updateMsg, setUpdateMsg] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    gameState().then(setGame).catch(() => setGame(EMPTY_GAME));
    listEngines().then(setEngines).catch(() => {});
    listArrows().then(setArrows).catch(() => {});
    channelInfo().then(setChannel).catch(() => {});
    const unsubs: Array<() => void> = [];
    listen<GameState>("game-state", (e) => setGame(e.payload)).then((u) => unsubs.push(u)).catch(() => {});
    listen<InfoLine>("engine-info", (e) => {
      const info = e.payload;
      setLines((prev) => {
        const key = info.multipv ?? 1;
        const next = prev.filter((l) => (l.multipv ?? 1) !== key);
        next.push(info);
        next.sort((a, b) => (a.multipv ?? 1) - (b.multipv ?? 1));
        return next.slice(0, 4);
      });
    }).then((u) => unsubs.push(u)).catch(() => {});
    return () => unsubs.forEach((u) => u());
  }, []);

  useEffect(() => {
    if (game.result.kind !== "playing") return;
    const t = setInterval(() => {
      if (game.turn === "white") setWhiteMs((ms) => Math.max(0, ms - 200));
      else setBlackMs((ms) => Math.max(0, ms - 200));
    }, 200);
    return () => clearInterval(t);
  }, [game.turn, game.result, game.ply]);

  const topClock = flipped ? whiteMs : blackMs;
  const botClock = flipped ? blackMs : whiteMs;
  const topActive = flipped ? game.turn === "white" : game.turn === "black";

  const best = lines[0];
  const engineArrows: BoardArrow[] = useMemo(() => {
    return lines.flatMap((line, i) => {
      const mv = line.pv[0];
      if (!mv || mv.length < 4) return [];
      const colors = ["#9EC9D9", "#6FA3B5", "#C5D4DC"];
      return [{ from: mv.slice(0, 2), to: mv.slice(2, 4), color: colors[i % 3], source: "engine" }];
    });
  }, [lines]);

  const shownArrows = [...arrows.filter((a) => a.source === "user"), ...engineArrows];

  async function refresh() {
    try {
      setGame(await gameState());
      setArrows(await listArrows());
    } catch {
      /* running without Tauri */
    }
  }

  async function onPlay(uci: string) {
    try {
      setLines([]);
      setGame(await playMove(uci));
      setArrows(await listArrows());
    } catch {
      /* illegal or disconnected */
    }
  }

  async function onArrow(from: string, to: string) {
    try {
      setArrows(await addArrow(from, to, "#9EC9D9"));
    } catch {
      setArrows((a) => [...a, { from, to, color: "#9EC9D9", source: "user" }]);
    }
  }

  async function pickEngine() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Engine", extensions: ["exe", "bin", "*"] }],
    });
    if (!selected || Array.isArray(selected)) return;
    const added = await addEngine(selected);
    setEngines(await listEngines());
    return added;
  }

  async function applyPlay(nextMode: PlayMode = mode) {
    setLines([]);
    const state = await configurePlay({
      mode: nextMode,
      white_engine: whiteEngine,
      black_engine: blackEngine,
      analysis_engine: analysisEngine,
      initial_ms: time.initial,
      increment_ms: time.inc,
      infinite: false,
    });
    setMode(nextMode);
    setWhiteMs(time.initial);
    setBlackMs(time.initial);
    setGame(state);
    setPanel("none");
  }

  async function doCheck() {
    setBusy(true);
    setUpdateMsg("");
    setUpdate(null);
    try {
      const found = await checkForUpdate();
      if (!found) setUpdateMsg("Up to date");
      else {
        setUpdate(found);
        setUpdateMsg(found.version);
      }
    } catch (err) {
      setUpdateMsg(err instanceof Error ? err.message : "Check failed");
    } finally {
      setBusy(false);
    }
  }

  async function doInstall() {
    if (!update) return;
    setBusy(true);
    try {
      await update.install(setProgress);
    } catch (err) {
      setUpdateMsg(err instanceof Error ? err.message : "Install failed");
      setBusy(false);
    }
  }

  const flakes = useMemo(
    () =>
      Array.from({ length: 18 }, (_, i) => ({
        left: `${(i * 53) % 100}%`,
        delay: `${(i * 0.7) % 8}s`,
        duration: `${10 + (i % 7)}s`,
        opacity: 0.15 + (i % 5) * 0.05,
      })),
    [],
  );

  return (
    <div className="app">
      <div className="snow" aria-hidden>
        {flakes.map((f, i) => (
          <span
            key={i}
            className="flake"
            style={{ left: f.left, animationDelay: f.delay, animationDuration: f.duration, opacity: f.opacity }}
          />
        ))}
      </div>
      <header className="topbar">
        <div className="wordmark">Nevaska</div>
        <div className="icon-row">
          <button className="icon-btn" title="New" onClick={async () => { setLines([]); setGame(await newGame().catch(() => EMPTY_GAME)); setWhiteMs(time.initial); setBlackMs(time.initial); }}>
            <Icon title="New" d="M5 12h14M12 5v14" />
          </button>
          <button className="icon-btn" title="Flip" onClick={() => setFlipped((v) => !v)}>
            <Icon title="Flip" d="M7 7h10v4H7zM7 13h10v4H7zM4 12h16" />
          </button>
          <button className="icon-btn" title="Undo" onClick={async () => { try { setGame(await undoMove()); } catch { /* */ } }}>
            <Icon title="Undo" d="M9 7H5v4M5 11c2.5-4 11-6 14 2" />
          </button>
          <button className={`icon-btn ${panel === "game" ? "active" : ""}`} title="Play" onClick={() => setPanel(panel === "game" ? "none" : "game")}>
            <Icon title="Play" d="M8 6v12l10-6z" />
          </button>
          <button className={`icon-btn ${panel === "engines" ? "active" : ""}`} title="Engines" onClick={() => setPanel(panel === "engines" ? "none" : "engines")}>
            <Icon title="Engines" d="M12 8v8M8 12h8M7 4h10l2 4H5zM7 20h10l2-4H5z" />
          </button>
          <button className={`icon-btn ${panel === "pgn" ? "active" : ""}`} title="PGN" onClick={async () => { setPanel(panel === "pgn" ? "none" : "pgn"); try { setPgn(await exportPgn()); setFen(game.fen); } catch { /* */ } }}>
            <Icon title="PGN" d="M7 4h10v16H7zM10 8h4M10 12h4M10 16h3" />
          </button>
          <button className={`icon-btn ${panel === "updates" ? "active" : ""}`} title="Updates" onClick={() => setPanel(panel === "updates" ? "none" : "updates")}>
            <Icon title="Updates" d="M12 5v6l4 2M20 12a8 8 0 1 1-2.2-5.5" />
          </button>
        </div>
      </header>
      <main className="stage">
        <section className="board-col">
          <div className="board-frame">
            <div className="eval-bar" title={best ? scoreText(best) : undefined}>
              <div className="eval-fill" style={{ height: `${evalHeight(best)}%` }} />
            </div>
            <Board game={game} flipped={flipped} arrows={shownArrows} onPlay={onPlay} onArrow={onArrow} />
          </div>
        </section>
        <aside className="dock">
          <div className={`clock ${topActive ? "" : "dim"}`}>{formatClock(topClock)}</div>
          <div className="moves">
            {game.moves.map((m, i) => (
              <span key={`${m.uci}-${i}`}>
                {i % 2 === 0 && <span className="move-n">{i / 2 + 1}.</span>}
                <span className="move-san">{m.san}</span>
                {i % 2 === 1 && <br />}
              </span>
            ))}
          </div>
          <div className="lines">
            {lines.map((line, i) => (
              <div className="line" key={i}>
                <span className="score">{scoreText(line)}</span>
                <span className="depth">{line.depth ?? ""}</span>
                <span className="pv">{(line.pv_san.length ? line.pv_san : line.pv).join(" ")}</span>
              </div>
            ))}
          </div>
          <div>
            {resultText(game) && <div className="over">{resultText(game)}</div>}
            <div className={`clock ${topActive ? "dim" : ""}`}>{formatClock(botClock)}</div>
          </div>
        </aside>
      </main>

      {panel === "engines" && (
        <div className="panel">
          <h2>Engines</h2>
          <div className="row">
            <button className="solid" onClick={pickEngine}>Stockfish</button>
            <button className="ghost" onClick={pickEngine}>lc0</button>
            <button className="ghost" onClick={pickEngine}>UCI</button>
          </div>
          {engines.map((engine) => (
            <div className="engine-card" key={engine.id}>
              <header>
                <strong>{engine.name}</strong>
                <span className="kind">{engine.kind}</span>
              </header>
              <div className="field">
                <input
                  type="range"
                  min={1}
                  max={32}
                  value={engine.threads}
                  onChange={(e) => {
                    const next = { ...engine, threads: Number(e.target.value) };
                    setEngines((all) => all.map((x) => (x.id === engine.id ? next : x)));
                  }}
                  onPointerUp={() => updateEngine(engines.find((x) => x.id === engine.id) ?? engine).then(setEngines)}
                />
              </div>
              <div className="row">
                <span className="kind">{engine.threads} cores</span>
                <span className="kind">{engine.hash_mb} MB</span>
                <span className="kind">pv {engine.multipv}</span>
                <label className="kind">
                  <input
                    type="checkbox"
                    checked={engine.limit_strength}
                    onChange={async (e) => {
                      const next = { ...engine, limit_strength: e.target.checked };
                      setEngines(await updateEngine(next));
                    }}
                  />
                  elo {engine.elo}
                </label>
              </div>
              <input
                type="range"
                min={16}
                max={1024}
                step={16}
                value={engine.hash_mb}
                onChange={(e) => {
                  const next = { ...engine, hash_mb: Number(e.target.value) };
                  setEngines((all) => all.map((x) => (x.id === engine.id ? next : x)));
                }}
                onPointerUp={() => updateEngine(engines.find((x) => x.id === engine.id) ?? engine).then(setEngines)}
              />
              {engine.limit_strength && (
                <input
                  type="range"
                  min={1320}
                  max={2400}
                  value={engine.elo}
                  onChange={(e) => {
                    const next = { ...engine, elo: Number(e.target.value) };
                    setEngines((all) => all.map((x) => (x.id === engine.id ? next : x)));
                  }}
                  onPointerUp={() => updateEngine(engines.find((x) => x.id === engine.id) ?? engine).then(setEngines)}
                />
              )}
              <div className="row">
                <button
                  className="ghost"
                  onClick={async () => {
                    const file = await open({ multiple: false });
                    if (!file || Array.isArray(file)) return;
                    const key = engine.kind === "lc0" ? "weights_file" : "eval_file";
                    setEngines(await updateEngine({ ...engine, [key]: file }));
                  }}
                >
                  {engine.kind === "lc0" ? "Weights" : "NNUE"}
                </button>
                <button className="ghost" onClick={async () => setEngines(await removeEngine(engine.id))}>
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {panel === "game" && (
        <div className="panel">
          <h2>Play</h2>
          <div className="row">
            {TIMES.map((t) => (
              <button key={t.label} className={`chip ${time.label === t.label ? "active" : ""}`} onClick={() => setTime(t)}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="field">
            <select value={whiteEngine ?? ""} onChange={(e) => setWhiteEngine(e.target.value || null)}>
              <option value="">White</option>
              {engines.map((en) => (
                <option key={en.id} value={en.id}>{en.name}</option>
              ))}
            </select>
            <select value={blackEngine ?? ""} onChange={(e) => setBlackEngine(e.target.value || null)}>
              <option value="">Black</option>
              {engines.map((en) => (
                <option key={en.id} value={en.id}>{en.name}</option>
              ))}
            </select>
            <select value={analysisEngine ?? ""} onChange={(e) => setAnalysisEngine(e.target.value || null)}>
              <option value="">Analyze</option>
              {engines.map((en) => (
                <option key={en.id} value={en.id}>{en.name}</option>
              ))}
            </select>
          </div>
          <div className="row">
            <button className="solid" onClick={() => applyPlay(whiteEngine && blackEngine ? "engine_engine" : whiteEngine ? "human_black" : blackEngine ? "human_white" : "human_human")}>
              Start
            </button>
            <button className="ghost" onClick={() => applyPlay("analysis")}>Analyze</button>
            <button className="ghost" onClick={() => stopSearch()}>Stop</button>
          </div>
        </div>
      )}

      {panel === "pgn" && (
        <div className="panel">
          <h2>PGN</h2>
          <div className="field">
            <textarea value={pgn} onChange={(e) => setPgn(e.target.value)} />
            <input value={fen} onChange={(e) => setFen(e.target.value)} />
          </div>
          <div className="row">
            <button className="solid" onClick={async () => { setGame(await loadPgn(pgn)); setPanel("none"); }}>Load</button>
            <button className="ghost" onClick={async () => { setGame(await loadFen(fen)); setPanel("none"); }}>FEN</button>
            <button className="ghost" onClick={async () => { setPgn(await exportPgn()); }}>Copy</button>
            <button className="ghost" onClick={async () => { await clearArrows(); await refresh(); }}>Clear</button>
          </div>
        </div>
      )}

      {panel === "updates" && (
        <div className="panel">
          <h2>Updates</h2>
          <div className="update-status">
            {channel ? `${channel.version} · ${channelLabel(channel.version)}` : "…"}
          </div>
          <div className="row">
            <button className="solid" disabled={busy} onClick={doCheck}>Check</button>
            {update && (
              <button className="ghost" disabled={busy} onClick={doInstall}>Install</button>
            )}
          </div>
          {updateMsg && <div className="update-status">{updateMsg}</div>}
          {progress != null && (
            <div className="progress"><span style={{ width: `${Math.round(progress * 100)}%` }} /></div>
          )}
        </div>
      )}
    </div>
  );
}

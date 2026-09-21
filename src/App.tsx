import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, FlipVertical2, Undo2, Play, Cpu, FileText, RefreshCw, ChartNoAxesCombined, X, type LucideIcon } from "lucide-react";
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

type Panel = "none" | "engines" | "game" | "updates" | "pgn" | "analysis";

const TIMES = [
  { label: "1+0", initial: 60_000, inc: 0 },
  { label: "3+2", initial: 180_000, inc: 2_000 },
  { label: "5+0", initial: 300_000, inc: 0 },
  { label: "10+0", initial: 600_000, inc: 0 },
  { label: "15+10", initial: 900_000, inc: 10_000 },
];

function Icon({ title }: { title: string }) {
  const icons: Record<string, LucideIcon> = { New: Plus, Flip: FlipVertical2, Undo: Undo2, Play, Engines: Cpu, PGN: FileText, Updates: RefreshCw };
  const Symbol = icons[title];
  return <Symbol aria-label={title} strokeWidth={1.8} />;
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
  const updateOperation = useRef(false);
  const [engineError, setEngineError] = useState("");
  const [showEngineArrows, setShowEngineArrows] = useState(false);
  const [arrowsHidden, setArrowsHidden] = useState(false);
  const fenRef = useRef(game.fen);
  fenRef.current = game.fen;
  const arrowRevision = useRef(0);

  useEffect(() => {
    setLines((prev) => prev.filter((line) => line.fen === game.fen));
    setArrows([]);
    setArrowsHidden(false);
  }, [game.fen]);

  useEffect(() => {
    const clear = (event: MouseEvent) => {
      if (event.button === 2) return;
      arrowRevision.current++;
      setArrows([]);
      setArrowsHidden(true);
      void clearArrows().catch(() => {});
    };
    window.addEventListener("pointerdown", clear, true);
    // Also handle an additional button pressed while another button is held.
    window.addEventListener("mousedown", clear, true);
    return () => { window.removeEventListener("mousedown", clear, true); window.removeEventListener("pointerdown", clear, true); };
  }, []);

  useEffect(() => {
    let disposed = false;
    gameState().then(setGame).catch(() => setGame(EMPTY_GAME));
    listEngines().then(async (installed) => {
      if (disposed) return;
      setEngines(installed);
      const defaultEngine = installed.find((engine) => engine.kind === "stockfish") ?? installed[0];
      if (defaultEngine) {
        setAnalysisEngine(defaultEngine.id);
        await configurePlay({ mode: "human_human", white_engine: null, black_engine: null, analysis_engine: defaultEngine.id, initial_ms: 600_000, increment_ms: 0, infinite: false });
      }
    }).catch((err) => { if (isTauri()) setEngineError(String(err)); });
    listArrows().then(setArrows).catch(() => {});
    channelInfo().then(setChannel).catch(() => {});
    const unsubs: Array<() => void> = [];
    const subscribe = (u: () => void) => { if (disposed) u(); else unsubs.push(u); };
    listen<GameState>("game-state", (e) => { fenRef.current = e.payload.fen; setGame(e.payload); }).then(subscribe).catch(() => {});
    listen<InfoLine>("engine-info", (e) => {
      const info = e.payload;
      if (info.fen !== fenRef.current || !info.pv.length) return;
      setEngineError("");
      setLines((prev) => {
        const key = info.multipv ?? 1;
        const next = prev.filter((l) => (l.multipv ?? 1) !== key);
        next.push(info);
        next.sort((a, b) => (a.multipv ?? 1) - (b.multipv ?? 1));
        return next.slice(0, 4);
      });
    }).then(subscribe).catch(() => {});
    listen<string>("engine-error", (e) => setEngineError(e.payload)).then(subscribe).catch(() => {});
    return () => { disposed = true; unsubs.forEach((u) => u()); };
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

  const currentLines = lines.filter((line) => line.fen === game.fen);
  const best = currentLines[0];
  const engineArrows: BoardArrow[] = useMemo(() => {
    return lines.filter((line) => line.fen === game.fen).flatMap((line, i) => {
      const mv = line.pv[0];
      if (!mv || mv.length < 4) return [];
      const colors = ["#9EC9D9", "#6FA3B5", "#C5D4DC"];
      return [{ from: mv.slice(0, 2), to: mv.slice(2, 4), color: colors[i % 3], source: "engine" }];
    });
  }, [lines, game.fen]);

  const shownArrows = [...arrows.filter((a) => a.source === "user"), ...(showEngineArrows && !arrowsHidden ? engineArrows : [])];

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
    const revision = arrowRevision.current;
    try {
      const next = await addArrow(from, to, "#9EC9D9");
      if (revision === arrowRevision.current) setArrows(next);
    } catch {
      if (revision === arrowRevision.current) setArrows((a) => [...a, { from, to, color: "#9EC9D9", source: "user" }]);
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
    if (updateOperation.current) return;
    updateOperation.current = true;
    setBusy(true);
    setProgress(null);
    setUpdateMsg("Checking for updates…");
    setUpdate(null);
    try {
      const found = await checkForUpdate();
      if (!found) setUpdateMsg("You are up to date on this channel.");
      else {
        setUpdate(found);
        setUpdateMsg(found.version);
      }
    } catch (err) {
      setUpdateMsg(err instanceof Error ? err.message : typeof err === "string" ? err : "Check failed");
    } finally {
      updateOperation.current = false;
      setBusy(false);
    }
  }

  async function doInstall() {
    if (!update || updateOperation.current) return;
    updateOperation.current = true;
    setBusy(true);
    setProgress(null);
    setUpdateMsg("Downloading update… The app will restart after installation.");
    try {
      await update.install((fraction) => {
        setProgress(fraction);
        if (fraction === 1) setUpdateMsg("Installing update… The app will restart.");
      });
    } catch (err) {
      setUpdateMsg(err instanceof Error ? err.message : typeof err === "string" ? err : "Install failed");
      setProgress(null);
    } finally {
      updateOperation.current = false;
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
    <div className={`app ${panel !== "none" ? "panel-open" : ""}`}>
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
        <div className="wordmark"><img src="/icon.png" alt="" />Nevaska</div>
        <div className="icon-row">
          <button className="icon-btn" title="New" onClick={async () => { setLines([]); setGame(await newGame().catch(() => EMPTY_GAME)); setWhiteMs(time.initial); setBlackMs(time.initial); }}>
            <Icon title="New" />
          </button>
          <button className="icon-btn" title="Flip" onClick={() => setFlipped((v) => !v)}>
            <Icon title="Flip" />
          </button>
          <button className="icon-btn" title="Undo" onClick={async () => { try { setGame(await undoMove()); } catch { /* */ } }}>
            <Icon title="Undo" />
          </button>
          <button className={`icon-btn ${panel === "game" ? "active" : ""}`} title="Play" onClick={() => setPanel(panel === "game" ? "none" : "game")}>
            <Icon title="Play" />
          </button>
          <button className={`icon-btn ${panel === "engines" ? "active" : ""}`} title="Engines" onClick={() => setPanel(panel === "engines" ? "none" : "engines")}>
            <Icon title="Engines" />
          </button>
          <button className={`icon-btn ${panel === "analysis" ? "active" : ""}`} title="Análise ao vivo" aria-label="Análise ao vivo" aria-expanded={panel === "analysis"} onClick={() => setPanel(panel === "analysis" ? "none" : "analysis")}>
            <ChartNoAxesCombined strokeWidth={1.8} />
          </button>
          <button className={`icon-btn ${panel === "pgn" ? "active" : ""}`} title="PGN" onClick={async () => { setPanel(panel === "pgn" ? "none" : "pgn"); try { setPgn(await exportPgn()); setFen(game.fen); } catch { /* */ } }}>
            <Icon title="PGN" />
          </button>
          <button className={`icon-btn ${panel === "updates" ? "active" : ""}`} title="Updates" onClick={() => setPanel(panel === "updates" ? "none" : "updates")}>
            <Icon title="Updates" />
          </button>
        </div>
      </header>
      <main className="stage">
        <section className="board-col">
          <div className="board-frame">
            <div className={`eval-bar ${flipped ? "flipped" : ""}`} aria-label={`Avaliação das brancas: ${best ? scoreText(best) : "aguardando engine"}`} title={best ? `Brancas: ${scoreText(best)}` : "Aguardando análise"}>
              <div className="eval-fill" style={{ height: `${evalHeight(best)}%` }} />
              <span className="eval-score">{best ? scoreText(best) : "—"}</span>
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
          <button className="analysis-summary" onClick={() => setPanel("analysis")}>
            <ChartNoAxesCombined size={20} /><span>Análise ao vivo<small>{best ? `${scoreText(best)} · profundidade ${best.depth ?? "—"}` : "Abrir estatísticas do engine"}</small></span>
          </button>
          <div>
            {resultText(game) && <div className="over">{resultText(game)}</div>}
            <div className={`clock ${topActive ? "dim" : ""}`}>{formatClock(botClock)}</div>
          </div>
        </aside>
      </main>

      {panel !== "none" && <button className="close-panel icon-btn" title="Fechar painel" aria-label="Fechar painel" onClick={() => setPanel("none")}><X /></button>}
      {panel === "analysis" && (
        <section className="panel analysis-panel" aria-label="Análise ao vivo">
          <h2>Análise</h2>
          <div className="field">
            <label htmlFor="analysis-engine">Engine de avaliação</label>
            <select id="analysis-engine" value={analysisEngine ?? ""} onChange={async (e) => {
              const id = e.target.value || null;
              setAnalysisEngine(id); setLines([]); setEngineError("");
              try { await configurePlay({ mode, white_engine: whiteEngine, black_engine: blackEngine, analysis_engine: id, initial_ms: time.initial, increment_ms: time.inc, infinite: false }); } catch (err) { setEngineError(String(err)); }
            }}>
              <option value="">Selecione um engine</option>
              {engines.map((engine) => <option key={engine.id} value={engine.id}>{engine.name}</option>)}
            </select>
          </div>
          {engineError && <p className="engine-error" role="alert">{engineError}</p>}
          {!engines.length && <div className="empty-analysis">Adicione um engine para acompanhar a avaliação e os melhores lances.<button className="ghost" onClick={() => setPanel("engines")}>Adicionar engine</button></div>}
          <div className="position-verdict"><strong>{best ? scoreText(best) : "—"}</strong><span>{best?.score_mate != null ? `Mate a favor das ${best.score_mate >= 0 ? "brancas" : "pretas"}` : best?.score_cp != null ? Math.abs(best.score_cp) < 30 ? "Posição equilibrada" : `Vantagem das ${best.score_cp > 0 ? "brancas" : "pretas"}` : "Aguardando avaliação"}<small>Avaliação pela perspectiva das brancas</small></span></div>
          {best?.wdl && <div className="wdl"><div className="wdl-bar">{best.wdl.map((value, i) => <span key={i} style={{ flex: value }} />)}</div><div className="wdl-labels"><span>Brancas {best.wdl[0] / 10}%</span><span>Empate {best.wdl[1] / 10}%</span><span>Pretas {best.wdl[2] / 10}%</span></div></div>}
          <dl className="analysis-stats">
            {[
              ["Profundidade", best?.depth != null ? `${best.depth} meios-lances` : "—"],
              ["Linha mais profunda", best?.seldepth != null ? `${best.seldepth} meios-lances` : "—"],
              ["Posições analisadas", best?.nodes?.toLocaleString("pt-BR") ?? "—"],
              ["Posições / segundo", best?.nps?.toLocaleString("pt-BR") ?? "—"],
              ["Tempo de busca", best?.time_ms != null ? `${(best.time_ms / 1000).toFixed(1)} s` : "—"],
              ["Cache ocupado", best?.hashfull != null ? `${best.hashfull / 10}%` : "—"],
              ["Consultas a finais", best?.tbhits?.toLocaleString("pt-BR") ?? "—"],
              ["Lances legais", game.legal.length.toString()],
            ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
          <p className="analysis-note">Um meio-lance é uma jogada de um dos lados. Profundidade não significa previsão garantida.</p>
          <div className="analysis-heading"><h3>Melhores continuações</h3><label><input type="checkbox" checked={showEngineArrows} onChange={(e) => { setShowEngineArrows(e.target.checked); setArrowsHidden(false); }} /> Setas</label></div>
          <div className="variations">{currentLines.map((line, i) => <article key={line.multipv ?? i}><header><span>#{line.multipv ?? i + 1} · {line.pv_san[0] ?? line.pv[0]}</span><strong>{scoreText(line)}</strong></header><p>{(line.pv_san.length ? line.pv_san : line.pv).join(" ")}</p><small>Profundidade {line.depth ?? "—"}</small></article>)}</div>
          <div className="position-details"><span>{game.turn === "white" ? "Brancas" : "Pretas"} jogam{game.in_check ? " · Xeque" : ""}</span><label htmlFor="position-fen">Posição FEN</label><textarea id="position-fen" readOnly value={game.fen} /></div>
        </section>
      )}

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
                <label className="kind">Variantes <select aria-label={`Variantes ${engine.name}`} value={engine.multipv} onChange={async (e) => {
                  setLines([]);
                  setEngines(await updateEngine({ ...engine, multipv: Number(e.target.value) }));
                }}>{[1, 2, 3, 4].map((n) => <option value={n} key={n}>{n}</option>)}</select></label>
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
            <button className="solid" disabled={busy} onClick={doCheck}>Check for updates</button>
            {update && (
              <button className="ghost" disabled={busy} onClick={doInstall}>Download and install</button>
            )}
          </div>
          {update?.notes && <p>{update.notes}</p>}
          {updateMsg && <div className="update-status" role="status">{updateMsg}</div>}
          {progress != null && (
            <div className="progress"><span style={{ width: `${Math.round(progress * 100)}%` }} /></div>
          )}
        </div>
      )}
    </div>
  );
}

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
  setPlayTuning,
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
  PlaySetup,
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

const LINE_TONE = [
  { color: "#2EAE6A", opacity: 0.96 },
  { color: "#D4534E", opacity: 0.92 },
  { color: "#D4534E", opacity: 0.5 },
];

const ELO_MIN = 1320;
const ELO_MAX = 3190;

function toneFor(index: number) {
  return LINE_TONE[Math.min(index, LINE_TONE.length - 1)];
}

function embeddedNet(engine: EngineConfig) {
  if (engine.eval_file) {
    const parts = engine.eval_file.split(/[/\\]/);
    return parts[parts.length - 1] || engine.eval_file;
  }
  if (engine.nnue_name) return engine.nnue_name;
  if (/stockfish\s*19/i.test(engine.name)) return "nn-1a298aa575a0.nnue";
  return "embutida no executável";
}

function moveTokens(sans: string[], ply: number) {
  const out: { key: string; kind: "num" | "mv"; text: string; first?: boolean }[] = [];
  sans.forEach((san, i) => {
    const p = ply + i;
    if (p % 2 === 0) out.push({ key: `n${i}`, kind: "num", text: `${p / 2 + 1}.` });
    else if (i === 0) out.push({ key: `n${i}`, kind: "num", text: `${Math.floor(p / 2) + 1}…` });
    out.push({ key: `m${i}`, kind: "mv", text: san, first: i === 0 });
  });
  return out;
}

function clampSeconds(value: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(120, Math.max(1, Math.round(value)));
}

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
  const [limitElo, setLimitElo] = useState(false);
  const [opponentElo, setOpponentElo] = useState(1600);
  const [thinkMin, setThinkMin] = useState(2);
  const [thinkMax, setThinkMax] = useState(5);
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
        await configurePlay({ mode: "human_human", white_engine: null, black_engine: null, analysis_engine: defaultEngine.id, initial_ms: 600_000, increment_ms: 0, infinite: false, opponent_elo: null, think_min_ms: 2_000, think_max_ms: 5_000 });
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
      const tone = toneFor(i);
      return [{ from: mv.slice(0, 2), to: mv.slice(2, 4), color: tone.color, opacity: tone.opacity, source: "engine" }];
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

  function tuning() {
    const lo = clampSeconds(Math.min(thinkMin, thinkMax));
    const hi = clampSeconds(Math.max(thinkMin, thinkMax));
    return {
      opponent_elo: limitElo ? opponentElo : null,
      think_min_ms: lo * 1000,
      think_max_ms: hi * 1000,
    };
  }

  function playSetup(partial: Partial<PlaySetup> = {}): PlaySetup {
    return {
      mode,
      white_engine: whiteEngine,
      black_engine: blackEngine,
      analysis_engine: analysisEngine,
      initial_ms: time.initial,
      increment_ms: time.inc,
      infinite: false,
      ...tuning(),
      ...partial,
    };
  }

  async function commitEngine(next: EngineConfig) {
    setEngines((all) => all.map((engine) => (engine.id === next.id ? next : engine)));
    try {
      setEngines(await updateEngine(next));
    } catch (err) {
      setEngineError(String(err));
    }
  }

  function commitTuning(next?: { limit?: boolean; elo?: number; min?: number; max?: number }) {
    const limit = next?.limit ?? limitElo;
    const elo = next?.elo ?? opponentElo;
    const min = clampSeconds(next?.min ?? thinkMin);
    const max = clampSeconds(next?.max ?? thinkMax);
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    setLimitElo(limit);
    setOpponentElo(elo);
    setThinkMin(lo);
    setThinkMax(hi);
    void setPlayTuning({
      opponent_elo: limit ? elo : null,
      think_min_ms: lo * 1000,
      think_max_ms: hi * 1000,
    }).catch(() => {});
  }

  async function onPlay(uci: string) {
    try {
      setLines([]);
      setGame(await playMove(uci));
      setArrows(await listArrows());
      return true;
    } catch {
      return false;
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
    const state = await configurePlay(playSetup({ mode: nextMode }));
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
              <div className="eval-track">
                <div className="eval-fill" style={{ height: `${evalHeight(best)}%` }} />
              </div>
              <span className="eval-score" style={flipped ? { top: `${Math.min(92, Math.max(8, evalHeight(best)))}%` } : { bottom: `${Math.min(92, Math.max(8, evalHeight(best)))}%` }}>{best ? scoreText(best) : "—"}</span>
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
              try { await configurePlay(playSetup({ analysis_engine: id })); } catch (err) { setEngineError(String(err)); }
            }}>
              <option value="">Selecione um engine</option>
              {engines.map((engine) => <option key={engine.id} value={engine.id}>{engine.name}</option>)}
            </select>
          </div>
          {engineError && <p className="engine-error" role="alert">{engineError}</p>}
          {analysisEngine && engines.find((engine) => engine.id === analysisEngine) && (() => {
            const engine = engines.find((item) => item.id === analysisEngine)!;
            return (
              <div className="tune">
                <label className="tune-label" htmlFor="analysis-threads">Núcleos<strong>{engine.threads}</strong></label>
                <input id="analysis-threads" type="range" min={1} max={32} value={engine.threads} onChange={(e) => {
                  const next = { ...engine, threads: Number(e.target.value) };
                  setEngines((all) => all.map((item) => (item.id === engine.id ? next : item)));
                }} onPointerUp={(e) => void commitEngine({ ...engine, threads: Number(e.currentTarget.value) })} />
                <label className="tune-label" htmlFor="analysis-cache">Cache<strong>{engine.hash_mb} MB</strong></label>
                <input id="analysis-cache" type="range" min={16} max={4096} step={16} value={engine.hash_mb} onChange={(e) => {
                  const next = { ...engine, hash_mb: Number(e.target.value) };
                  setEngines((all) => all.map((item) => (item.id === engine.id ? next : item)));
                }} onPointerUp={(e) => void commitEngine({ ...engine, hash_mb: Number(e.currentTarget.value) })} />
                {engine.kind === "stockfish" && (
                  <div className="nnue-line">
                    <label className="check-line">
                      <input
                        type="checkbox"
                        checked={!engine.eval_file}
                        onChange={async (e) => {
                          if (e.target.checked) {
                            await commitEngine({ ...engine, eval_file: null });
                            return;
                          }
                          const file = await open({ multiple: false });
                          if (!file || Array.isArray(file)) return;
                          await commitEngine({ ...engine, eval_file: file });
                        }}
                      />
                      Rede neural embutida
                    </label>
                    <span className="net-name">{embeddedNet(engine)}</span>
                  </div>
                )}
              </div>
            );
          })()}
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
          <div className="variations">{currentLines.map((line, i) => {
            const tone = toneFor(i);
            const sans = line.pv_san.length ? line.pv_san : line.pv;
            return (
              <article className="pv" key={line.multipv ?? i} style={{ borderLeftColor: tone.color }}>
                <header>
                  <span className="pv-kicker"><i style={{ background: tone.color, opacity: tone.opacity }} />{line.multipv ?? i + 1}</span>
                  <strong className="pv-score">{scoreText(line)}</strong>
                </header>
                <p className="pv-line">{moveTokens(sans, game.ply).map((token) => <span key={token.key} className={token.kind === "num" ? "num" : token.first ? "mv first" : "mv"}>{token.text}</span>)}</p>
                <small>Profundidade {line.depth ?? "—"}</small>
              </article>
            );
          })}</div>
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
              <label className="tune-label">Núcleos<strong>{engine.threads}</strong></label>
              <input
                type="range"
                min={1}
                max={32}
                aria-label={`Núcleos ${engine.name}`}
                value={engine.threads}
                onChange={(e) => {
                  const next = { ...engine, threads: Number(e.target.value) };
                  setEngines((all) => all.map((x) => (x.id === engine.id ? next : x)));
                }}
                onPointerUp={(e) => void commitEngine({ ...engine, threads: Number(e.currentTarget.value) })}
              />
              <label className="tune-label">Cache<strong>{engine.hash_mb} MB</strong></label>
              <input
                type="range"
                min={16}
                max={4096}
                step={16}
                aria-label={`Cache ${engine.name}`}
                value={engine.hash_mb}
                onChange={(e) => {
                  const next = { ...engine, hash_mb: Number(e.target.value) };
                  setEngines((all) => all.map((x) => (x.id === engine.id ? next : x)));
                }}
                onPointerUp={(e) => void commitEngine({ ...engine, hash_mb: Number(e.currentTarget.value) })}
              />
              <div className="row">
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
              {engine.limit_strength && (
                <input
                  type="range"
                  min={ELO_MIN}
                  max={ELO_MAX}
                  aria-label={`Elo ${engine.name}`}
                  value={engine.elo}
                  onChange={(e) => {
                    const next = { ...engine, elo: Number(e.target.value) };
                    setEngines((all) => all.map((x) => (x.id === engine.id ? next : x)));
                  }}
                  onPointerUp={(e) => void commitEngine({ ...engine, elo: Number(e.currentTarget.value) })}
                />
              )}
              <div className="row">
                {engine.kind === "stockfish" && (
                  <span className="net-name">{engine.eval_file ? "NNUE personalizada" : embeddedNet(engine)}</span>
                )}
                <button
                  className="ghost"
                  onClick={async () => {
                    const file = await open({ multiple: false });
                    if (!file || Array.isArray(file)) return;
                    const key = engine.kind === "lc0" ? "weights_file" : "eval_file";
                    await commitEngine({ ...engine, [key]: file });
                  }}
                >
                  {engine.kind === "lc0" ? "Weights" : "NNUE"}
                </button>
                {engine.kind === "stockfish" && engine.eval_file && (
                  <button className="ghost" onClick={() => void commitEngine({ ...engine, eval_file: null })}>Usar rede embutida</button>
                )}
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
          <h2>Jogar</h2>
          <div className="row">
            {TIMES.map((t) => (
              <button key={t.label} className={`chip ${time.label === t.label ? "active" : ""}`} onClick={() => setTime(t)}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="field">
            <label htmlFor="play-white">Brancas</label>
            <select id="play-white" value={whiteEngine ?? ""} onChange={(e) => setWhiteEngine(e.target.value || null)}>
              <option value="">Humano</option>
              {engines.map((en) => (
                <option key={en.id} value={en.id}>{en.name}</option>
              ))}
            </select>
            <label htmlFor="play-black">Pretas</label>
            <select id="play-black" value={blackEngine ?? ""} onChange={(e) => setBlackEngine(e.target.value || null)}>
              <option value="">Humano</option>
              {engines.map((en) => (
                <option key={en.id} value={en.id}>{en.name}</option>
              ))}
            </select>
            <label htmlFor="play-analysis">Análise durante a partida</label>
            <select id="play-analysis" value={analysisEngine ?? ""} onChange={(e) => setAnalysisEngine(e.target.value || null)}>
              <option value="">Nenhuma</option>
              {engines.map((en) => (
                <option key={en.id} value={en.id}>{en.name}</option>
              ))}
            </select>
          </div>
          <div className="tune">
            <label className="check-line">
              <input
                type="checkbox"
                checked={limitElo}
                onChange={(e) => commitTuning({ limit: e.target.checked })}
              />
              Limitar o Elo do oponente
            </label>
            {limitElo && (
              <>
                <label className="tune-label" htmlFor="opponent-elo">Elo<strong>{opponentElo}</strong></label>
                <input
                  id="opponent-elo"
                  type="range"
                  min={ELO_MIN}
                  max={ELO_MAX}
                  value={opponentElo}
                  onChange={(e) => setOpponentElo(Number(e.target.value))}
                  onPointerUp={(e) => commitTuning({ elo: Number(e.currentTarget.value) })}
                />
              </>
            )}
            <p className="hint">Desmarcado, a engine joga na força máxima. O limite vale só para quem está jogando a partida.</p>
            <div className="time-range">
              <label>De
                <input
                  aria-label="Tempo mínimo da engine"
                  type="number"
                  min={1}
                  max={120}
                  value={thinkMin}
                  onChange={(e) => setThinkMin(Number(e.target.value))}
                  onBlur={() => commitTuning()}
                />
              </label>
              <label>Até
                <input
                  aria-label="Tempo máximo da engine"
                  type="number"
                  min={1}
                  max={120}
                  value={thinkMax}
                  onChange={(e) => setThinkMax(Number(e.target.value))}
                  onBlur={() => commitTuning()}
                />
              </label>
            </div>
            <p className="hint">Segundos. A cada lance, a engine sorteia um tempo nesse intervalo, espera, e joga o melhor lance que tiver naquele momento.</p>
          </div>
          <div className="row">
            <button className="solid" onClick={() => applyPlay(whiteEngine && blackEngine ? "engine_engine" : whiteEngine ? "human_black" : blackEngine ? "human_white" : "human_human")}>
              Começar
            </button>
            <button className="ghost" onClick={() => applyPlay("analysis")}>Analisar</button>
            <button className="ghost" onClick={() => stopSearch()}>Parar</button>
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

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { playTracked, preserveIds, seedPieces, type TrackedPiece } from "./lib/motion";
import { ChessPiece } from "./pieces";
import type { BoardArrow, GameState } from "./lib/types";

const FILES = "abcdefgh";

function sqName(col: number, row: number, flipped: boolean) {
  const file = flipped ? 7 - col : col;
  const rank = flipped ? row : 7 - row;
  return `${FILES[file]}${rank + 1}`;
}

function squareOrigin(square: string, flipped: boolean) {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  const col = flipped ? 7 - file : file;
  const row = flipped ? rank : 7 - rank;
  return { left: col * 12.5, top: row * 12.5 };
}

function squareCenter(square: string, flipped: boolean) {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  const col = flipped ? 7 - file : file;
  const row = flipped ? rank : 7 - rank;
  return { x: col + 0.5, y: row + 0.5 };
}

function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface ArrowShape {
  shaft: string;
  head: string;
}

/** Thin shaft and a small head, in a 0–8 board. Short moves shrink so the head still fits. */
function arrowShape(from: string, to: string, flipped: boolean): ArrowShape | null {
  const s = squareCenter(from, flipped);
  const t = squareCenter(to, flipped);
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.2) return null;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  let tailPad = 0.34;
  let tipPad = 0.3;
  let headLen = 0.2;
  const minShaft = 0.06;
  const budget = tailPad + tipPad + headLen + minShaft;
  if (budget > len) {
    const scale = len / budget;
    tailPad *= scale;
    tipPad *= scale;
    headLen *= scale;
  }
  const headW = headLen * 0.42;
  const tailX = s.x + ux * tailPad;
  const tailY = s.y + uy * tailPad;
  const tipX = t.x - ux * tipPad;
  const tipY = t.y - uy * tipPad;
  const baseX = tipX - ux * headLen;
  const baseY = tipY - uy * headLen;
  const shaft = `M ${tailX} ${tailY} L ${baseX} ${baseY}`;
  const head = `M ${tipX} ${tipY} L ${baseX + px * headW} ${baseY + py * headW} L ${baseX - px * headW} ${baseY - py * headW} Z`;
  return { shaft, head };
}

export function Board({
  game,
  flipped,
  arrows,
  onPlay,
  onArrow,
}: {
  game: GameState;
  flipped: boolean;
  arrows: BoardArrow[];
  onPlay: (uci: string) => Promise<boolean> | void;
  onArrow: (from: string, to: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [promo, setPromo] = useState<{ from: string; to: string } | null>(null);
  const [drag, setDrag] = useState<{ square: string; x: number; y: number } | null>(null);
  const [ghost, setGhost] = useState<{ from: string; to: string } | null>(null);
  const [visual, setVisual] = useState<TrackedPiece[]>(() => seedPieces(game.pieces));
  const [motion, setMotion] = useState(true);
  const [glide, setGlide] = useState<{ id: string; x: number; y: number; live: boolean } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const visualRef = useRef(visual);
  visualRef.current = visual;
  const seen = useRef(game);
  const pendingMove = useRef<string | null>(null);
  const suppressLost = useRef(false);

  useEffect(() => { setSelected(null); setPromo(null); }, [game.fen, flipped]);

  useEffect(() => {
    setMotion(false);
    const id = requestAnimationFrame(() => setMotion(true));
    return () => cancelAnimationFrame(id);
  }, [flipped]);

  useEffect(() => {
    const prev = seen.current;
    seen.current = game;
    if (prev.fen === game.fen) return;
    const local = pendingMove.current;
    if (local && game.last_move === local) pendingMove.current = null;
    const played = game.ply === prev.ply + 1 ? game.last_move : game.ply + 1 === prev.ply ? prev.last_move : null;
    const back = played != null && game.ply < prev.ply;
    if (played && (local === played || game.ply !== prev.ply)) {
      setMotion(true);
      setVisual((current) => {
        const next = preserveIds(current, game.pieces, played, back);
        visualRef.current = next;
        return next;
      });
      return;
    }
    setMotion(false);
    setVisual(() => {
      const next = preserveIds(visualRef.current, game.pieces, null, false);
      visualRef.current = next;
      return next;
    });
    const id = requestAnimationFrame(() => setMotion(true));
    return () => cancelAnimationFrame(id);
  }, [game]);

  useEffect(() => {
    if (!glide || glide.live) return;
    const id = requestAnimationFrame(() => {
      setGlide((current) => (current && !current.live ? { ...current, x: 0, y: 0, live: true } : current));
    });
    return () => cancelAnimationFrame(id);
  }, [glide]);

  useEffect(() => {
    if (!glide?.live) return;
    const id = window.setTimeout(() => setGlide(null), 240);
    return () => window.clearTimeout(id);
  }, [glide]);

  const pieceAt = useMemo(() => {
    const map = new Map<string, string>();
    for (const piece of visual) map.set(piece.square, piece.code);
    return map;
  }, [visual]);

  const last = game.last_move;
  const lastFrom = last?.slice(0, 2);
  const lastTo = last?.slice(2, 4);

  const kingSq = useMemo(() => {
    if (!game.in_check && game.result.kind !== "checkmate") return null;
    const code = game.turn === "white" ? "wK" : "bK";
    return game.pieces.find((piece) => piece.code === code)?.square ?? null;
  }, [game]);
  const mated = game.result.kind === "checkmate";

  const dests = useMemo(() => {
    if (!selected) return new Set<string>();
    return new Set(game.legal.filter((move) => move.startsWith(selected)).map((move) => move.slice(2, 4)));
  }, [selected, game.legal]);

  function pointToSquare(clientX: number, clientY: number) {
    const el = root.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    if (x < 0 || y < 0 || x >= 1 || y >= 1) return null;
    const col = Math.min(7, Math.max(0, Math.floor(x * 8)));
    const row = Math.min(7, Math.max(0, Math.floor(y * 8)));
    return sqName(col, row, flipped);
  }

  function squareClientCenter(square: string) {
    const el = root.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const origin = squareOrigin(square, flipped);
    return {
      x: rect.left + ((origin.left + 6.25) / 100) * rect.width,
      y: rect.top + ((origin.top + 6.25) / 100) * rect.height,
    };
  }

  function settleHome(square: string, x: number, y: number) {
    if (reducedMotion()) return;
    const piece = visualRef.current.find((item) => item.square === square);
    const center = squareClientCenter(square);
    if (!piece || !center) return;
    setGlide({ id: piece.id, x: x - center.x, y: y - center.y, live: false });
  }

  function launch(uci: string, from: string, to: string, drop: { x: number; y: number } | null) {
    const current = visualRef.current;
    const piece = current.find((item) => item.square === from);
    const next = playTracked(current, uci);
    const backup = current;
    if (drop && piece && !reducedMotion()) {
      const center = squareClientCenter(to);
      if (center) setGlide({ id: piece.id, x: drop.x - center.x, y: drop.y - center.y, live: false });
    }
    visualRef.current = next;
    setVisual(next);
    setSelected(null);
    pendingMove.current = uci;
    void Promise.resolve(onPlay(uci)).then((ok) => {
      if (pendingMove.current === uci) pendingMove.current = null;
      if (ok === false) {
        visualRef.current = backup;
        setVisual(backup);
        setGlide(null);
      }
    });
  }

  function tryMove(from: string, to: string, drop: { x: number; y: number } | null = null) {
    if (from === to) {
      setSelected(from);
      if (drop) settleHome(from, drop.x, drop.y);
      return;
    }
    const matches = game.legal.filter((move) => move.startsWith(from + to));
    if (matches.length === 0) {
      if (drop) settleHome(from, drop.x, drop.y);
      if (pieceAt.has(to)) setSelected(to);
      else setSelected(null);
      return;
    }
    const promoMoves = matches.filter((move) => move.length === 5);
    if (promoMoves.length) {
      setPromo({ from, to });
      setSelected(null);
      if (drop) settleHome(from, drop.x, drop.y);
      return;
    }
    launch(matches[0], from, to, drop);
  }

  function onPointerDown(e: PointerEvent, square: string) {
    if (e.button === 2) {
      e.preventDefault();
      setGhost({ from: square, to: square });
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    if (promo || pendingMove.current) return;
    e.preventDefault();
    if (selected && selected !== square && dests.has(square)) {
      tryMove(selected, square);
      return;
    }
    if (!game.legal.some((move) => move.startsWith(square))) {
      setSelected(null);
      return;
    }
    setSelected(square);
    setDrag({ square, x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (ghost) {
      const square = pointToSquare(e.clientX, e.clientY);
      if (square) setGhost({ ...ghost, to: square });
      return;
    }
    if (drag) setDrag({ ...drag, x: e.clientX, y: e.clientY });
  }

  function onPointerUp(e: PointerEvent) {
    suppressLost.current = true;
    if (ghost) {
      if (ghost.from !== ghost.to) onArrow(ghost.from, ghost.to);
      setGhost(null);
      return;
    }
    if (!drag) return;
    const to = pointToSquare(e.clientX, e.clientY);
    const from = drag.square;
    setDrag(null);
    if (to) tryMove(from, to, { x: e.clientX, y: e.clientY });
    else settleHome(from, e.clientX, e.clientY);
  }

  const squares = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const name = sqName(col, row, flipped);
      const file = flipped ? 7 - col : col;
      const rank = flipped ? row : 7 - row;
      const dark = (file + rank) % 2 === 0;
      const occupied = pieceAt.has(name);
      squares.push(
        <div
          key={name}
          data-square={name}
          data-occupied={occupied ? "1" : "0"}
          className={[
            "sq",
            dark ? "dark" : "light",
            selected === name ? "selected" : "",
            lastFrom === name || lastTo === name ? "last" : "",
            kingSq === name ? (mated ? "mated" : "check") : "",
          ].join(" ")}
          onPointerDown={(e) => onPointerDown(e, name)}
        >
          {dests.has(name) && (occupied ? <span className="capture-ring" /> : <span className="dot" />)}
        </div>,
      );
    }
  }

  const allArrows = ghost && ghost.from !== ghost.to
    ? [...arrows, { from: ghost.from, to: ghost.to, color: "#9EC9D9", source: "draft" }]
    : arrows;

  const dragged = drag ? visual.find((piece) => piece.square === drag.square) : undefined;

  return (
    <div
      className="board-wrap"
      onContextMenu={(e) => e.preventDefault()}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { setDrag(null); setGhost(null); }}
      onLostPointerCapture={() => {
        if (suppressLost.current) {
          suppressLost.current = false;
          return;
        }
        setDrag(null);
        setGhost(null);
      }}
    >
      <div className="board" id="chess-board" ref={root} data-piece-count={visual.length}>
        {squares}
        <div className="piece-layer">
          {visual.map((piece) => {
            const origin = squareOrigin(piece.square, flipped);
            const landing = glide?.id === piece.id ? glide : null;
            const hidden = drag?.square === piece.square;
            return (
              <span
                key={piece.id}
                className={[
                  "piece",
                  motion && !landing ? "slide" : "",
                  landing ? (landing.live ? "settle" : "no-slide") : "",
                  hidden ? "dragging" : "",
                ].filter(Boolean).join(" ")}
                style={{
                  left: `${origin.left}%`,
                  top: `${origin.top}%`,
                  transform: landing ? `translate(${landing.x}px, ${landing.y}px)` : undefined,
                }}
              >
                <ChessPiece code={piece.code} />
              </span>
            );
          })}
        </div>
        <svg className="arrows" viewBox="0 0 8 8">
          {allArrows.map((arrow, i) => {
            const shape = arrowShape(arrow.from, arrow.to, flipped);
            if (!shape) return null;
            const opacity = arrow.opacity ?? (arrow.source === "engine" ? 0.92 : 0.9);
            return (
              <g key={`${arrow.from}${arrow.to}${i}`} className="arrow" opacity={opacity}>
                <path d={shape.shaft} stroke="rgba(8, 12, 14, 0.55)" strokeWidth="0.09" fill="none" strokeLinecap="round" />
                <path d={shape.head} fill="rgba(8, 12, 14, 0.55)" />
                <path d={shape.shaft} stroke={arrow.color} strokeWidth="0.045" fill="none" strokeLinecap="round" />
                <path d={shape.head} fill={arrow.color} />
              </g>
            );
          })}
        </svg>
      </div>
      {promo && (
        <div className="promo" style={{ left: "50%", top: "50%", transform: "translate(-50%, -50%)" }}>
          {["q", "r", "n", "b"].map((piece) => {
            const code = `${game.turn === "white" ? "w" : "b"}${piece.toUpperCase()}`;
            return (
              <button
                key={piece}
                onClick={() => {
                  const uci = `${promo.from}${promo.to}${piece}`;
                  launch(uci, promo.from, promo.to, null);
                  setPromo(null);
                }}
              >
                <ChessPiece code={code} />
              </button>
            );
          })}
        </div>
      )}
      {drag && dragged && (
        <div
          className="piece ghost-piece"
          style={{
            position: "fixed",
            inset: "auto",
            left: drag.x,
            top: drag.y,
            width: (root.current?.clientWidth ?? 512) / 8,
            height: (root.current?.clientHeight ?? 512) / 8,
            transform: "translate(-50%, -50%)",
            pointerEvents: "none",
            zIndex: 20,
          }}
        >
          <ChessPiece code={dragged.code} />
        </div>
      )}
    </div>
  );
}

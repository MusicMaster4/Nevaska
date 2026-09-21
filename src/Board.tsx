import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { ChessPiece } from "./pieces";
import type { BoardArrow, GameState } from "./lib/types";

const FILES = "abcdefgh";

function sqName(col: number, row: number, flipped: boolean) {
  const file = flipped ? 7 - col : col;
  const rank = flipped ? row : 7 - row;
  return `${FILES[file]}${rank + 1}`;
}

function squareCenter(square: string, flipped: boolean) {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  const col = flipped ? 7 - file : file;
  const row = flipped ? rank : 7 - rank;
  return { x: (col + 0.5) / 8, y: (row + 0.5) / 8 };
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
  onPlay: (uci: string) => void;
  onArrow: (from: string, to: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [promo, setPromo] = useState<{ from: string; to: string } | null>(null);
  const [drag, setDrag] = useState<{ square: string; x: number; y: number } | null>(null);
  const [ghost, setGhost] = useState<{ from: string; to: string } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { setSelected(null); setPromo(null); setDrag(null); setGhost(null); }, [game.fen, flipped]);

  const pieces = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of game.pieces) map.set(p.square, p.code);
    return map;
  }, [game.pieces]);

  const last = game.last_move;
  const lastFrom = last?.slice(0, 2);
  const lastTo = last?.slice(2, 4);

  const kingSq = useMemo(() => {
    if (!game.in_check) return null;
    const code = game.turn === "white" ? "wK" : "bK";
    return game.pieces.find((p) => p.code === code)?.square ?? null;
  }, [game]);

  const dests = useMemo(() => {
    if (!selected) return new Set<string>();
    return new Set(
      game.legal.filter((m) => m.startsWith(selected)).map((m) => m.slice(2, 4)),
    );
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

  function tryMove(from: string, to: string) {
    if (from === to) {
      setSelected(from);
      return;
    }
    const matches = game.legal.filter((m) => m.startsWith(from + to));
    if (matches.length === 0) {
      if (pieces.has(to)) setSelected(to);
      else setSelected(null);
      return;
    }
    const promoMoves = matches.filter((m) => m.length === 5);
    if (promoMoves.length) {
      setPromo({ from, to });
      setSelected(null);
      return;
    }
    onPlay(matches[0]);
    setSelected(null);
  }

  function onPointerDown(e: PointerEvent, square: string) {
    if (e.button === 2) {
      e.preventDefault();
      setGhost({ from: square, to: square });
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    if (promo) return;
    e.preventDefault();
    if (selected && selected !== square && dests.has(square)) {
      tryMove(selected, square);
      return;
    }
    if (!game.legal.some((m) => m.startsWith(square))) { setSelected(null); return; }
    setSelected(square);
    setDrag({ square, x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (ghost) {
      const sq = pointToSquare(e.clientX, e.clientY);
      if (sq) setGhost({ ...ghost, to: sq });
      return;
    }
    if (drag) setDrag({ ...drag, x: e.clientX, y: e.clientY });
  }

  function onPointerUp(e: PointerEvent) {
    if (ghost) {
      if (ghost.from !== ghost.to) onArrow(ghost.from, ghost.to);
      setGhost(null);
      return;
    }
    if (!drag) return;
    const to = pointToSquare(e.clientX, e.clientY);
    if (to) tryMove(drag.square, to);
    setDrag(null);
  }

  const squares = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const name = sqName(col, row, flipped);
      const file = flipped ? 7 - col : col;
      const rank = flipped ? row : 7 - row;
      const dark = (file + rank) % 2 === 0;
      const occupied = pieces.has(name);
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
            kingSq === name ? "check" : "",
          ].join(" ")}
          onPointerDown={(e) => onPointerDown(e, name)}
        >
          {dests.has(name) && (occupied ? <span className="capture-ring" /> : <span className="dot" />)}
          {pieces.has(name) && (
            <span className={`piece ${drag?.square === name ? "dragging" : ""}`}>
              <ChessPiece code={pieces.get(name)!} />
            </span>
          )}
        </div>,
      );
    }
  }

  const allArrows = ghost && ghost.from !== ghost.to
    ? [...arrows, { from: ghost.from, to: ghost.to, color: "#9EC9D9", source: "draft" }]
    : arrows;

  return (
    <div
      className="board-wrap"
      onContextMenu={(e) => e.preventDefault()}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { setDrag(null); setGhost(null); }}
      onLostPointerCapture={() => { setDrag(null); setGhost(null); }}
    >
      <div className="board" id="chess-board" ref={root} data-piece-count={game.pieces.length}>
        {squares}
        <svg className="arrows" viewBox="0 0 8 8">
          <defs>
            <marker id="head" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 z" fill="#9EC9D9" />
            </marker>
          </defs>
          {allArrows.map((a, i) => {
            const s = squareCenter(a.from, flipped);
            const t = squareCenter(a.to, flipped);
            return (
              <line
                key={`${a.from}${a.to}${i}`}
                x1={s.x * 8}
                y1={s.y * 8}
                x2={t.x * 8}
                y2={t.y * 8}
                stroke={a.color}
                strokeWidth="0.18"
                strokeLinecap="round"
                markerEnd="url(#head)"
                opacity="0.85"
              />
            );
          })}
        </svg>
      </div>
      {promo && (
        <div className="promo" style={{ left: "50%", top: "50%", transform: "translate(-50%, -50%)" }}>
          {["q", "r", "n", "b"].map((p) => {
            const code = `${game.turn === "white" ? "w" : "b"}${p.toUpperCase()}`;
            return (
              <button
                key={p}
                onClick={() => {
                  onPlay(`${promo.from}${promo.to}${p}`);
                  setPromo(null);
                }}
              >
                <ChessPiece code={code} />
              </button>
            );
          })}
        </div>
      )}
      {drag && (
        <div
          className="piece"
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
          <ChessPiece code={pieces.get(drag.square) ?? "wP"} />
        </div>
      )}
    </div>
  );
}

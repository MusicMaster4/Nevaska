export interface TrackedPiece {
  id: string;
  square: string;
  code: string;
}

export interface PieceSpot {
  square: string;
  code: string;
}

/** King move (uci without promotion) → rook from, rook to. */
const CASTLES: Record<string, [string, string]> = {
  e1g1: ["h1", "f1"],
  e1c1: ["a1", "d1"],
  e8g8: ["h8", "f8"],
  e8c8: ["a8", "d8"],
};

let nextId = 1;

function fresh(): string {
  nextId += 1;
  return `p${nextId}`;
}

export function seedPieces(pieces: PieceSpot[]): TrackedPiece[] {
  return pieces.map((piece) => ({ id: fresh(), square: piece.square, code: piece.code }));
}

function pieceCode(color: string, promo: string): string {
  return `${color}${promo.toUpperCase()}`;
}

/** Local piece list after `uci`, keeping ids so the board can slide. */
export function playTracked(prev: TrackedPiece[], uci: string): TrackedPiece[] {
  if (uci.length < 4) return prev;
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const mover = prev.find((piece) => piece.square === from);
  if (!mover) return prev;

  let next = prev.filter((piece) => piece.id !== mover.id && piece.square !== to);
  const castle = mover.code.endsWith("K") ? CASTLES[from + to] : undefined;
  if (castle) {
    const rook = prev.find((piece) => piece.square === castle[0]);
    next = next.filter((piece) => piece.square !== castle[0]);
    if (rook) next.push({ ...rook, square: castle[1] });
  } else if (mover.code.endsWith("P") && from[0] !== to[0] && !prev.some((piece) => piece.square === to)) {
    const captured = `${to[0]}${from[1]}`;
    next = next.filter((piece) => piece.square !== captured);
  }

  const promo = uci.length >= 5 ? uci[4] : "";
  const code = promo ? pieceCode(mover.code[0], promo) : mover.code;
  next.push({ ...mover, square: to, code });
  return next;
}

function adoptExact(prev: TrackedPiece[], next: PieceSpot[]): TrackedPiece[] {
  const pool = [...prev];
  return next.map((spot) => {
    const index = pool.findIndex((piece) => piece.square === spot.square && piece.code === spot.code);
    if (index >= 0) return pool.splice(index, 1)[0];
    return { id: fresh(), square: spot.square, code: spot.code };
  });
}

/**
 * Carry ids across a position change.
 * `playedUci` is the move that was made on the board.
 * `back` rewinds that move (undo).
 */
export function preserveIds(prev: TrackedPiece[], next: PieceSpot[], playedUci: string | null, back: boolean): TrackedPiece[] {
  if (!playedUci || playedUci.length < 4) return adoptExact(prev, next);
  let from = playedUci.slice(0, 2);
  let to = playedUci.slice(2, 4);
  const castle = CASTLES[from + to];
  let rookFrom = castle?.[0];
  let rookTo = castle?.[1];
  if (back) {
    [from, to] = [to, from];
    if (rookFrom && rookTo) [rookFrom, rookTo] = [rookTo, rookFrom];
  }

  const mover = prev.find((piece) => piece.square === from);
  if (!mover) return adoptExact(prev, next);

  const placed = new Map<string, TrackedPiece>();
  const used = new Set<string>([mover.id]);
  const dest = next.find((spot) => spot.square === to);
  if (dest) placed.set(to, { ...mover, square: to, code: dest.code });

  if (rookFrom && rookTo) {
    const rook = prev.find((piece) => piece.square === rookFrom);
    const rookDest = next.find((spot) => spot.square === rookTo);
    if (rook && rookDest) {
      placed.set(rookTo, { ...rook, square: rookTo, code: rookDest.code });
      used.add(rook.id);
    }
  }

  const pool = prev.filter((piece) => !used.has(piece.id));
  return next.map((spot) => {
    const moved = placed.get(spot.square);
    if (moved) return moved;
    const index = pool.findIndex((piece) => piece.square === spot.square && piece.code === spot.code);
    if (index >= 0) return pool.splice(index, 1)[0];
    return { id: fresh(), square: spot.square, code: spot.code };
  });
}

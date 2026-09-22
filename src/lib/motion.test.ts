import assert from "node:assert/strict";
import test from "node:test";
import { playTracked, preserveIds, seedPieces, type TrackedPiece } from "./motion.ts";

function squares(pieces: TrackedPiece[]) {
  return Object.fromEntries(pieces.map((piece) => [piece.square, piece.code]));
}

function idAt(pieces: TrackedPiece[], square: string) {
  return pieces.find((piece) => piece.square === square)?.id;
}

test("a pawn keeps its id and leaves the origin", () => {
  const start = seedPieces([
    { square: "e2", code: "wP" },
    { square: "e7", code: "bP" },
  ]);
  const pawn = idAt(start, "e2");
  const next = playTracked(start, "e2e4");
  assert.equal(idAt(next, "e4"), pawn);
  assert.equal(squares(next).e2, undefined);
  assert.equal(squares(next).e4, "wP");
});

test("castling moves the king and the rook", () => {
  const start = seedPieces([
    { square: "e1", code: "wK" },
    { square: "h1", code: "wR" },
    { square: "a1", code: "wR" },
  ]);
  const king = idAt(start, "e1");
  const rook = idAt(start, "h1");
  const next = playTracked(start, "e1g1");
  assert.equal(idAt(next, "g1"), king);
  assert.equal(idAt(next, "f1"), rook);
  assert.equal(squares(next).e1, undefined);
  assert.equal(squares(next).h1, undefined);
  assert.equal(idAt(next, "a1"), idAt(start, "a1"));
});

test("en passant removes the passed pawn", () => {
  const start = seedPieces([
    { square: "e5", code: "wP" },
    { square: "d5", code: "bP" },
  ]);
  const next = playTracked(start, "e5d6");
  assert.deepEqual(squares(next), { d6: "wP" });
});

test("promotion changes the piece on the same id", () => {
  const start = seedPieces([{ square: "e7", code: "wP" }]);
  const pawn = idAt(start, "e7");
  const next = playTracked(start, "e7e8q");
  assert.equal(idAt(next, "e8"), pawn);
  assert.equal(squares(next).e8, "wQ");
});

test("undo sends the piece back without a new id", () => {
  const start = seedPieces([
    { square: "e2", code: "wP" },
    { square: "d2", code: "wP" },
  ]);
  const played = playTracked(start, "e2e4");
  const back = preserveIds(played, start, "e2e4", true);
  assert.equal(idAt(back, "e2"), idAt(start, "e2"));
  assert.equal(squares(back).e4, undefined);
});

test("an already-applied move does not invent a second traveler", () => {
  const start = seedPieces([{ square: "g1", code: "wN" }]);
  const played = playTracked(start, "g1f3");
  const spots = played.map(({ square, code }) => ({ square, code }));
  const again = preserveIds(played, spots, "g1f3", false);
  assert.equal(idAt(again, "f3"), idAt(played, "f3"));
  assert.equal(again.length, 1);
});

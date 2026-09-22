import assert from "node:assert/strict";
import test from "node:test";
import { describeOutcome } from "./outcome.ts";

test("checkmate names the winner", () => {
  assert.deepEqual(describeOutcome({ kind: "checkmate", winner: "white" }), {
    tone: "mate",
    title: "Xeque-mate",
    detail: "As brancas vencem",
    score: "1–0",
  });
  assert.equal(describeOutcome({ kind: "checkmate", winner: "black" })?.detail, "As pretas vencem");
});

test("draws explain why the game ended", () => {
  assert.equal(describeOutcome({ kind: "playing" }), null);
  assert.equal(describeOutcome({ kind: "stalemate" })?.detail, "Afogamento — não há lance legal");
  assert.equal(describeOutcome({ kind: "fifty_move" })?.title, "Empate");
  assert.equal(describeOutcome({ kind: "threefold" })?.score, "½–½");
  assert.match(describeOutcome({ kind: "insufficient_material" })?.detail ?? "", /insuficiente/);
});

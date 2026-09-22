import type { GameResult } from "./types";

export interface Outcome {
  tone: "mate" | "draw";
  title: string;
  detail: string;
  score: string;
}

export function describeOutcome(result: GameResult): Outcome | null {
  if (result.kind === "playing") return null;
  if (result.kind === "checkmate") {
    const white = result.winner === "white";
    return {
      tone: "mate",
      title: "Xeque-mate",
      detail: white ? "As brancas vencem" : "As pretas vencem",
      score: white ? "1–0" : "0–1",
    };
  }
  const detail = {
    stalemate: "Afogamento — não há lance legal",
    fifty_move: "Cinquenta lances sem captura nem peão",
    threefold: "A posição se repetiu três vezes",
    insufficient_material: "Material insuficiente para dar mate",
  }[result.kind];
  return { tone: "draw", title: "Empate", detail, score: "½–½" };
}

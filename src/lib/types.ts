export type Side = "white" | "black";

export type GameResult =
  | { kind: "playing" }
  | { kind: "checkmate"; winner: Side }
  | { kind: "stalemate" }
  | { kind: "fifty_move" }
  | { kind: "threefold" }
  | { kind: "insufficient_material" };

export interface PlayedMove {
  uci: string;
  san: string;
}

export interface PieceOnBoard {
  square: string;
  code: string;
}

export interface GameState {
  fen: string;
  turn: Side;
  pieces: PieceOnBoard[];
  legal: string[];
  last_move: string | null;
  in_check: boolean;
  result: GameResult;
  moves: PlayedMove[];
  ply: number;
  halfmove_clock: number;
  ep: string | null;
  castling: string;
}

export type EngineKind = "stockfish" | "lc0" | "uci";

export interface EngineConfig {
  id: string;
  name: string;
  path: string;
  kind: EngineKind;
  threads: number;
  hash_mb: number;
  eval_file: string | null;
  weights_file: string | null;
  limit_strength: boolean;
  elo: number;
  multipv: number;
  /** Default EvalFile advertised by the engine. Null while unknown. */
  nnue_name?: string | null;
}

export type PlayMode = "human_human" | "human_white" | "human_black" | "engine_engine" | "analysis";

export interface PlaySetup {
  mode: PlayMode;
  white_engine: string | null;
  black_engine: string | null;
  analysis_engine: string | null;
  initial_ms: number;
  increment_ms: number;
  infinite: boolean;
  /** Null keeps the opponent at full strength. */
  opponent_elo: number | null;
  think_min_ms: number;
  think_max_ms: number;
}

export interface PlayTuning {
  opponent_elo: number | null;
  think_min_ms: number;
  think_max_ms: number;
}

export interface InfoLine {
  fen: string | null;
  engine_id: string | null;
  hashfull: number | null;
  tbhits: number | null;
  wdl: [number, number, number] | null;
  depth: number | null;
  seldepth: number | null;
  multipv: number | null;
  score_cp: number | null;
  score_mate: number | null;
  nodes: number | null;
  nps: number | null;
  time_ms: number | null;
  pv: string[];
  pv_san: string[];
  string: string | null;
  raw: string;
}

export interface BoardArrow {
  from: string;
  to: string;
  color: string;
  source: string;
  opacity?: number;
}

export interface ChannelInfo {
  version: string;
  channel: string;
  label: string;
  endpoint: string;
}

export const START_PIECES: PieceOnBoard[] = [
  ...(["a", "b", "c", "d", "e", "f", "g", "h"] as const).flatMap((file, i) => {
    const back = ["R", "N", "B", "Q", "K", "B", "N", "R"][i];
    return [
      { square: `${file}1`, code: `w${back}` },
      { square: `${file}2`, code: "wP" },
      { square: `${file}7`, code: "bP" },
      { square: `${file}8`, code: `b${back}` },
    ];
  }),
];

export const EMPTY_GAME: GameState = {
  fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  turn: "white",
  pieces: START_PIECES,
  legal: [],
  last_move: null,
  in_check: false,
  result: { kind: "playing" },
  moves: [],
  ply: 0,
  halfmove_clock: 0,
  ep: null,
  castling: "KQkq",
};

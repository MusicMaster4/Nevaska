import { invoke } from "@tauri-apps/api/core";
import type {
  BoardArrow,
  ChannelInfo,
  EngineConfig,
  GameState,
  PlaySetup,
} from "./types";

export async function gameState(): Promise<GameState> {
  return invoke("game_state");
}

export async function newGame(): Promise<GameState> {
  return invoke("new_game");
}

export async function playMove(uci: string): Promise<GameState> {
  return invoke("play_move", { uci });
}

export async function undoMove(): Promise<GameState> {
  return invoke("undo_move");
}

export async function gotoPly(ply: number): Promise<GameState> {
  return invoke("goto_ply", { ply });
}

export async function loadFen(fen: string): Promise<GameState> {
  return invoke("load_fen", { fen });
}

export async function loadPgn(pgn: string): Promise<GameState> {
  return invoke("load_pgn", { pgn });
}

export async function exportPgn(): Promise<string> {
  return invoke("export_pgn");
}

export async function exportFen(): Promise<string> {
  return invoke("export_fen");
}

export async function listEngines(): Promise<EngineConfig[]> {
  return invoke("list_engines");
}

export async function addEngine(path: string): Promise<EngineConfig> {
  return invoke("add_engine", { path });
}

export async function updateEngine(config: EngineConfig): Promise<EngineConfig[]> {
  return invoke("update_engine", { config });
}

export async function removeEngine(id: string): Promise<EngineConfig[]> {
  return invoke("remove_engine", { id });
}

export async function configurePlay(setup: PlaySetup): Promise<GameState> {
  return invoke("configure_play", { setup });
}

export async function stopSearch(): Promise<void> {
  return invoke("stop_search");
}

export async function addArrow(from: string, to: string, color: string): Promise<BoardArrow[]> {
  return invoke("add_arrow", { from, to, color });
}

export async function clearArrows(): Promise<BoardArrow[]> {
  return invoke("clear_arrows");
}

export async function listArrows(): Promise<BoardArrow[]> {
  return invoke("list_arrows");
}

export async function channelInfo(): Promise<ChannelInfo> {
  return invoke("channel_info");
}

export async function evaluateUpdatePayload(offer: {
  runningVersion: string;
  payloadVersion: string;
  runningEndpoint: string;
  payloadEndpoint: string;
}): Promise<boolean> {
  return invoke("evaluate_update_payload", {
    offer: {
      running_version: offer.runningVersion,
      payload_version: offer.payloadVersion,
      running_endpoint: offer.runningEndpoint,
      payload_endpoint: offer.payloadEndpoint,
    },
  });
}

export async function setClocks(whiteMs: number, blackMs: number): Promise<void> {
  return invoke("set_clocks", { white_ms: whiteMs, black_ms: blackMs });
}

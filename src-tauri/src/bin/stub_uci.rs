//! Tiny UCI engine used as the in-repo fixture. Speaks real stdin/stdout UCI.

use std::io::{self, BufRead, Write};

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    let mut threads = "1".to_string();
    let mut eval_file = "<empty>".to_string();
    let mut weights_file = "<empty>".to_string();
    let mut limit_strength = "false".to_string();
    let mut elo = "1350".to_string();
    let mut hash = "16".to_string();
    let mut multipv = "1".to_string();
    let mut moves: Vec<String> = Vec::new();

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }
        if line == "uci" {
            writeln!(stdout, "id name Nevaska Stub").unwrap();
            writeln!(stdout, "id author Nevaska").unwrap();
            writeln!(stdout, "option name Threads type spin default 1 min 1 max 256").unwrap();
            writeln!(stdout, "option name Hash type spin default 16 min 1 max 1024").unwrap();
            writeln!(stdout, "option name EvalFile type string default <empty>").unwrap();
            writeln!(stdout, "option name WeightsFile type string default <empty>").unwrap();
            writeln!(stdout, "option name UCI_LimitStrength type check default false").unwrap();
            writeln!(stdout, "option name UCI_Elo type spin default 1350 min 1320 max 3190").unwrap();
            writeln!(stdout, "option name MultiPV type spin default 1 min 1 max 8").unwrap();
            writeln!(stdout, "uciok").unwrap();
        } else if line == "isready" {
            writeln!(stdout, "readyok").unwrap();
        } else if line == "ucinewgame" {
            moves.clear();
        } else if let Some(rest) = line.strip_prefix("setoption name ") {
            if let Some((name, value)) = rest.split_once(" value ") {
                match name {
                    "Threads" => threads = value.to_string(),
                    "Hash" => hash = value.to_string(),
                    "EvalFile" => eval_file = value.to_string(),
                    "WeightsFile" => weights_file = value.to_string(),
                    "UCI_LimitStrength" => limit_strength = value.to_string(),
                    "UCI_Elo" => elo = value.to_string(),
                    "MultiPV" => multipv = value.to_string(),
                    _ => {}
                }
            }
        } else if let Some(rest) = line.strip_prefix("position ") {
            moves.clear();
            if let Some(idx) = rest.find(" moves ") {
                let mv = rest[idx + " moves ".len()..].trim();
                if !mv.is_empty() {
                    moves = mv.split_whitespace().map(|s| s.to_string()).collect();
                }
            }
        } else if line.starts_with("go") {
            writeln!(
                stdout,
                "info string set Threads={threads} Hash={hash} EvalFile={eval_file} WeightsFile={weights_file} UCI_LimitStrength={limit_strength} UCI_Elo={elo} MultiPV={multipv} go={line}"
            )
            .unwrap();
            let reply = reply_move(&moves);
            let ponder = ponder_move(&reply);
            writeln!(
                stdout,
                "info depth 8 seldepth 12 multipv 1 score cp 32 nodes 1234 nps 10000 time 12 pv {reply} {ponder}"
            )
            .unwrap();
            writeln!(
                stdout,
                "info depth 8 seldepth 10 multipv 2 score cp 20 nodes 1234 nps 10000 time 12 pv {alt}",
                alt = alt_move(&moves)
            )
            .unwrap();
            writeln!(stdout, "bestmove {reply} ponder {ponder}").unwrap();
        } else if line == "stop" {
            let reply = reply_move(&moves);
            writeln!(stdout, "bestmove {reply}").unwrap();
        } else if line == "quit" {
            break;
        }
        stdout.flush().unwrap();
    }
}

fn white_to_move(moves: &[String]) -> bool {
    moves.len() % 2 == 0
}

fn reply_move(moves: &[String]) -> &'static str {
    if white_to_move(moves) {
        if !moves.iter().any(|m| m.starts_with("e2")) {
            "e2e4"
        } else if !moves.iter().any(|m| m.starts_with("d2")) {
            "d2d4"
        } else {
            "g1f3"
        }
    } else if !moves.iter().any(|m| m.starts_with("e7")) {
        "e7e5"
    } else if !moves.iter().any(|m| m.starts_with("d7")) {
        "d7d5"
    } else {
        "g8f6"
    }
}

fn alt_move(moves: &[String]) -> &'static str {
    if white_to_move(moves) {
        "d2d4"
    } else {
        "c7c5"
    }
}

fn ponder_move(best: &str) -> &'static str {
    match best {
        "e2e4" => "e7e5",
        "d2d4" => "d7d5",
        "e7e5" => "g1f3",
        _ => "g1f3",
    }
}

//! Human-vs-engine, engine-vs-engine, and analysis orchestration on top of
//! [`crate::chess::Game`] and [`crate::uci::UciSession`].

use crate::chess::{ChessError, Game, Side};
use crate::uci::{GoLimits, GoResult, InfoLine, UciError, UciSession};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlayMode {
    HumanHuman,
    HumanWhite,
    HumanBlack,
    EngineEngine,
    Analysis,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TimeControl {
    pub initial_ms: u64,
    pub increment_ms: u64,
    pub infinite: bool,
}

impl TimeControl {
    pub fn classical_ten() -> Self {
        Self {
            initial_ms: 10 * 60 * 1000,
            increment_ms: 0,
            infinite: false,
        }
    }

    pub fn go_limits(&self, white_ms: u64, black_ms: u64) -> GoLimits {
        if self.infinite {
            return GoLimits {
                infinite: false,
                movetime: Some(1000),
                ..GoLimits::default()
            };
        }
        GoLimits {
            wtime: Some(white_ms),
            btime: Some(black_ms),
            winc: Some(self.increment_ms),
            binc: Some(self.increment_ms),
            ..GoLimits::default()
        }
    }
}

pub fn analysis_limits() -> GoLimits {
    GoLimits {
        infinite: true,
        ..GoLimits::default()
    }
}

/// Send the current game to the engine and search. The caller applies `bestmove`.
pub fn engine_search(
    session: &UciSession,
    game: &Game,
    limits: &GoLimits,
    mut on_info: impl FnMut(InfoLine),
) -> Result<GoResult, UciError> {
    let moves: Vec<String> = game.moves().iter().map(|m| m.uci.clone()).collect();
    session.position_startpos(&moves)?;
    session.go(limits, &mut on_info)
}

pub fn apply_bestmove(game: &mut Game, bestmove: &str) -> Result<(), ChessError> {
    game.play(bestmove).map(|_| ())
}

/// One human ply followed by one engine ply. Used by tests and the GUI.
pub fn human_then_engine(
    game: &mut Game,
    human_uci: &str,
    engine: &UciSession,
    limits: &GoLimits,
) -> Result<GoResult, Box<dyn std::error::Error>> {
    game.play(human_uci)?;
    let result = engine_search(engine, game, limits, |_| {})?;
    apply_bestmove(game, &result.bestmove)?;
    Ok(result)
}

/// One white-engine ply then one black-engine ply.
pub fn engine_versus_engine_ply(
    game: &mut Game,
    white: &UciSession,
    black: &UciSession,
    limits: &GoLimits,
) -> Result<(GoResult, GoResult), Box<dyn std::error::Error>> {
    let side = game.side_to_move();
    let (first, second) = match side {
        Side::White => (white, black),
        Side::Black => (black, white),
    };
    let a = engine_search(first, game, limits, |_| {})?;
    apply_bestmove(game, &a.bestmove)?;
    if game.result().is_over() {
        return Ok((a.clone(), a));
    }
    let b = engine_search(second, game, limits, |_| {})?;
    apply_bestmove(game, &b.bestmove)?;
    Ok((a, b))
}

//! Shipped FIDE chess rules used by the GUI.
//!
//! All legality, game-end, and notation work goes through this module. The
//! implementation wraps `shakmaty` so tests and the window drive the same API.

use serde::{Deserialize, Serialize};
use shakmaty::fen::Fen;
use shakmaty::san::San;
use shakmaty::uci::UciMove;
use shakmaty::{
    CastlingMode, CastlingSide, Chess, Color, EnPassantMode, Move, Position, Rank, Role, Square,
};
use std::collections::HashMap;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ChessError {
    #[error("illegal move: {0}")]
    Illegal(String),
    #[error("the game is already over")]
    GameOver,
    #[error("pawn promotion piece required")]
    NeedsPromotion,
    #[error("invalid FEN: {0}")]
    Fen(String),
    #[error("invalid PGN: {0}")]
    Pgn(String),
    #[error("no move to undo")]
    EmptyHistory,
    #[error("{0}")]
    Other(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    White,
    Black,
}

impl From<Color> for Side {
    fn from(color: Color) -> Self {
        match color {
            Color::White => Side::White,
            Color::Black => Side::Black,
        }
    }
}

impl From<Side> for Color {
    fn from(side: Side) -> Self {
        match side {
            Side::White => Color::White,
            Side::Black => Color::Black,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GameResult {
    Playing,
    Checkmate { winner: Side },
    Stalemate,
    FiftyMove,
    Threefold,
    InsufficientMaterial,
}

impl GameResult {
    pub fn is_over(&self) -> bool {
        !matches!(self, GameResult::Playing)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlayedMove {
    pub uci: String,
    pub san: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PieceOnBoard {
    pub square: String,
    pub code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GameState {
    pub fen: String,
    pub turn: Side,
    pub pieces: Vec<PieceOnBoard>,
    pub legal: Vec<String>,
    pub last_move: Option<String>,
    pub in_check: bool,
    pub result: GameResult,
    pub moves: Vec<PlayedMove>,
    pub ply: usize,
    pub halfmove_clock: u32,
    pub ep: Option<String>,
    pub castling: String,
}

/// A complete FIDE game: current position, move list, and repetition table.
#[derive(Debug, Clone)]
pub struct Game {
    start_fen: String,
    pos: Chess,
    moves: Vec<PlayedMove>,
    /// Counts of repetition keys (FEN without clocks) after each ply, including start.
    seen: HashMap<String, u32>,
}

impl Default for Game {
    fn default() -> Self {
        Self::startpos()
    }
}

impl Game {
    pub fn startpos() -> Self {
        let pos = Chess::new();
        let mut game = Self {
            start_fen: fen_string(&pos),
            pos,
            moves: Vec::new(),
            seen: HashMap::new(),
        };
        game.note_current();
        game
    }

    pub fn from_fen(fen: &str) -> Result<Self, ChessError> {
        let pos = parse_fen(fen)?;
        let mut game = Self {
            start_fen: fen_string(&pos),
            pos,
            moves: Vec::new(),
            seen: HashMap::new(),
        };
        game.note_current();
        Ok(game)
    }

    pub fn fen(&self) -> String {
        fen_string(&self.pos)
    }

    pub fn start_fen(&self) -> &str {
        &self.start_fen
    }

    pub fn side_to_move(&self) -> Side {
        self.pos.turn().into()
    }

    pub fn legal_moves(&self) -> Vec<String> {
        self.pos
            .legal_moves()
            .iter()
            .map(|m| move_uci(m))
            .collect()
    }

    pub fn is_legal(&self, uci: &str) -> bool {
        self.decode_uci(uci).is_ok()
    }

    pub fn in_check(&self) -> bool {
        self.pos.is_check()
    }

    pub fn can_castle(&self, side: Side, king_side: bool) -> bool {
        let color = Color::from(side);
        let which = if king_side {
            CastlingSide::KingSide
        } else {
            CastlingSide::QueenSide
        };
        self.pos.castles().has(color, which)
    }

    pub fn en_passant_square(&self) -> Option<String> {
        self.pos.ep_square(EnPassantMode::Legal).map(|sq| sq.to_string())
    }

    pub fn halfmove_clock(&self) -> u32 {
        self.pos.halfmoves()
    }

    pub fn play(&mut self, uci: &str) -> Result<PlayedMove, ChessError> {
        if self.result().is_over() {
            return Err(ChessError::GameOver);
        }
        let mv = self.decode_uci(uci)?;
        let played = PlayedMove {
            uci: move_uci(&mv),
            san: San::from_move(&self.pos, &mv).to_string(),
        };
        self.pos = self
            .pos
            .clone()
            .play(&mv)
            .map_err(|_| ChessError::Illegal(uci.to_string()))?;
        self.moves.push(played.clone());
        self.note_current();
        Ok(played)
    }

    pub fn play_san(&mut self, san: &str) -> Result<PlayedMove, ChessError> {
        if self.result().is_over() {
            return Err(ChessError::GameOver);
        }
        let parsed: San = san
            .parse()
            .map_err(|e| ChessError::Pgn(format!("{san}: {e}")))?;
        let mv = parsed
            .to_move(&self.pos)
            .map_err(|_| ChessError::Illegal(san.to_string()))?;
        self.play(&move_uci(&mv))
    }

    pub fn undo(&mut self) -> Result<PlayedMove, ChessError> {
        let last = self.moves.pop().ok_or(ChessError::EmptyHistory)?;
        self.rebuild()?;
        Ok(last)
    }

    pub fn goto_ply(&mut self, ply: usize) -> Result<(), ChessError> {
        if ply > self.moves.len() {
            return Err(ChessError::Other(format!("ply {ply} is past the end")));
        }
        let kept: Vec<String> = self.moves.iter().take(ply).map(|m| m.uci.clone()).collect();
        *self = Self::from_fen(&self.start_fen)?;
        for uci in kept {
            self.play(&uci)?;
        }
        Ok(())
    }

    pub fn moves(&self) -> &[PlayedMove] {
        &self.moves
    }

    pub fn result(&self) -> GameResult {
        if self.pos.is_checkmate() {
            let winner = match self.pos.turn() {
                Color::White => Side::Black,
                Color::Black => Side::White,
            };
            return GameResult::Checkmate { winner };
        }
        if self.pos.is_stalemate() {
            return GameResult::Stalemate;
        }
        if is_insufficient(&self.pos) {
            return GameResult::InsufficientMaterial;
        }
        if self.current_repetitions() >= 3 {
            return GameResult::Threefold;
        }
        if self.pos.halfmoves() >= 100 {
            return GameResult::FiftyMove;
        }
        GameResult::Playing
    }

    pub fn pieces(&self) -> Vec<PieceOnBoard> {
        Square::ALL
            .into_iter()
            .filter_map(|sq| {
                self.pos.board().piece_at(sq).map(|piece| PieceOnBoard {
                    square: sq.to_string(),
                    code: piece_code(piece.color, piece.role),
                })
            })
            .collect()
    }

    pub fn state(&self) -> GameState {
        let castling = {
            let mut s = String::new();
            if self.can_castle(Side::White, true) {
                s.push('K');
            }
            if self.can_castle(Side::White, false) {
                s.push('Q');
            }
            if self.can_castle(Side::Black, true) {
                s.push('k');
            }
            if self.can_castle(Side::Black, false) {
                s.push('q');
            }
            if s.is_empty() {
                s.push('-');
            }
            s
        };
        GameState {
            fen: self.fen(),
            turn: self.side_to_move(),
            pieces: self.pieces(),
            legal: self.legal_moves(),
            last_move: self.moves.last().map(|m| m.uci.clone()),
            in_check: self.in_check(),
            result: self.result(),
            moves: self.moves.clone(),
            ply: self.moves.len(),
            halfmove_clock: self.halfmove_clock(),
            ep: self.en_passant_square(),
            castling,
        }
    }

    pub fn pgn(&self) -> String {
        let mut out = String::from("[Event \"Nevaska\"]\n[Site \"Local\"]\n");
        out.push_str(&format!("[FEN \"{}\"]\n", self.start_fen));
        out.push_str("[SetUp \"1\"]\n\n");
        for (i, mv) in self.moves.iter().enumerate() {
            if i % 2 == 0 {
                out.push_str(&format!("{}. {}", i / 2 + 1, mv.san));
            } else {
                out.push_str(&format!(" {}", mv.san));
                if i + 1 != self.moves.len() {
                    out.push(' ');
                }
            }
            if i % 2 == 0 && i + 1 == self.moves.len() {
                // last move was white; no extra space needed
            }
        }
        let term = match self.result() {
            GameResult::Checkmate { winner: Side::White } => " 1-0",
            GameResult::Checkmate { winner: Side::Black } => " 0-1",
            GameResult::Playing => " *",
            _ => " 1/2-1/2",
        };
        out.push_str(term);
        out.push('\n');
        out
    }

    pub fn from_pgn(pgn: &str) -> Result<Self, ChessError> {
        let mut start = None;
        let mut body = String::new();
        for line in pgn.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix('[') {
                if rest.to_ascii_uppercase().starts_with("FEN ") {
                    start = Some(extract_tag_value(trimmed).ok_or_else(|| {
                        ChessError::Pgn("malformed FEN tag".into())
                    })?);
                }
                continue;
            }
            body.push_str(trimmed);
            body.push(' ');
        }
        let mut game = match start {
            Some(fen) => Self::from_fen(&fen)?,
            None => Self::startpos(),
        };
        for token in pgn_tokens(&body) {
            if matches!(
                token.as_str(),
                "*" | "1-0" | "0-1" | "1/2-1/2" | "½-½"
            ) {
                break;
            }
            game.play_san(&token)?;
        }
        Ok(game)
    }

    fn decode_uci(&self, uci: &str) -> Result<Move, ChessError> {
        let trimmed = uci.trim();
        if looks_like_promotion(trimmed, &self.pos) && trimmed.len() == 4 {
            return Err(ChessError::NeedsPromotion);
        }
        let parsed = UciMove::from_ascii(trimmed.as_bytes())
            .map_err(|_| ChessError::Illegal(trimmed.to_string()))?;
        parsed
            .to_move(&self.pos)
            .map_err(|_| ChessError::Illegal(trimmed.to_string()))
    }

    fn note_current(&mut self) {
        let key = repetition_key(&self.pos);
        *self.seen.entry(key).or_insert(0) += 1;
    }

    fn current_repetitions(&self) -> u32 {
        self.seen
            .get(&repetition_key(&self.pos))
            .copied()
            .unwrap_or(0)
    }

    pub fn pv_san(&self, pv: &[String]) -> Vec<String> {
        let mut fork = self.clone();
        let mut out = Vec::new();
        for uci in pv {
            match fork.play(uci) {
                Ok(played) => out.push(played.san),
                Err(_) => break,
            }
        }
        out
    }

    fn rebuild(&mut self) -> Result<(), ChessError> {
        let moves = self.moves.clone();
        *self = Self::from_fen(&self.start_fen)?;
        for mv in moves {
            self.play(&mv.uci)?;
        }
        Ok(())
    }
}

fn parse_fen(fen: &str) -> Result<Chess, ChessError> {
    let parsed = Fen::from_ascii(fen.trim().as_bytes())
        .map_err(|e| ChessError::Fen(e.to_string()))?;
    parsed
        .into_position(CastlingMode::Standard)
        .map_err(|e| ChessError::Fen(e.to_string()))
}

fn fen_string(pos: &Chess) -> String {
    Fen::from_position(pos.clone(), EnPassantMode::Legal).to_string()
}

fn repetition_key(pos: &Chess) -> String {
    let fen = fen_string(pos);
    fen.split_whitespace()
        .take(4)
        .collect::<Vec<_>>()
        .join(" ")
}

fn move_uci(mv: &Move) -> String {
    UciMove::from_move(mv, CastlingMode::Standard).to_string()
}

fn piece_code(color: Color, role: Role) -> String {
    let c = if color.is_white() { 'w' } else { 'b' };
    let r = match role {
        Role::Pawn => 'P',
        Role::Knight => 'N',
        Role::Bishop => 'B',
        Role::Rook => 'R',
        Role::Queen => 'Q',
        Role::King => 'K',
    };
    format!("{c}{r}")
}

fn looks_like_promotion(uci: &str, pos: &Chess) -> bool {
    if uci.len() < 4 {
        return false;
    }
    let Ok(from) = Square::from_ascii(&uci.as_bytes()[..2]) else {
        return false;
    };
    let Ok(to) = Square::from_ascii(&uci.as_bytes()[2..4]) else {
        return false;
    };
    let Some(piece) = pos.board().piece_at(from) else {
        return false;
    };
    if piece.role != Role::Pawn {
        return false;
    }
    match pos.turn() {
        Color::White => from.rank() == Rank::Seventh && to.rank() == Rank::Eighth,
        Color::Black => from.rank() == Rank::Second && to.rank() == Rank::First,
    }
}

fn is_insufficient(pos: &Chess) -> bool {
    let board = pos.board();
    let occupied = board.occupied().count();
    if occupied > 4 {
        return false;
    }
    let pawns = board.pawns().count();
    let rooks = board.rooks().count();
    let queens = board.queens().count();
    if pawns + rooks + queens > 0 {
        return false;
    }
    let knights = board.knights().count();
    let bishops = board.bishops().count();
    match occupied {
        2 => true,
        3 => knights + bishops == 1,
        4 => {
            if bishops == 2 && knights == 0 {
                let squares: Vec<Square> = Square::ALL
                    .into_iter()
                    .filter(|sq| board.bishops().contains(*sq))
                    .collect();
                if squares.len() == 2 {
                    return squares[0].is_light() == squares[1].is_light();
                }
            }
            false
        }
        _ => false,
    }
}

fn extract_tag_value(line: &str) -> Option<String> {
    let start = line.find('"')?;
    let rest = &line[start + 1..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn pgn_tokens(body: &str) -> Vec<String> {
    let mut stripped = String::new();
    let mut chars = body.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '{' => {
                for next in chars.by_ref() {
                    if next == '}' {
                        break;
                    }
                }
            }
            '(' => {
                let mut depth = 1;
                for next in chars.by_ref() {
                    if next == '(' {
                        depth += 1;
                    } else if next == ')' {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                }
            }
            ';' => {
                for next in chars.by_ref() {
                    if next == '\n' {
                        break;
                    }
                }
            }
            '$' => {
                while matches!(chars.peek(), Some(c) if c.is_ascii_digit()) {
                    chars.next();
                }
            }
            c => stripped.push(c),
        }
    }
    stripped
        .split_whitespace()
        .filter(|token| {
            !token.chars().all(|c| c.is_ascii_digit() || c == '.')
                && !matches!(*token, "*" | "1-0" | "0-1" | "1/2-1/2" | "½-½")
        })
        .map(|token| token.trim_matches(|c| c == '!' || c == '?').to_string())
        .filter(|token| !token.is_empty())
        .collect()
}

#[cfg(test)]
mod unit_smoke {
    use super::*;

    #[test]
    fn startpos_has_twenty_moves() {
        assert_eq!(Game::startpos().legal_moves().len(), 20);
    }
}

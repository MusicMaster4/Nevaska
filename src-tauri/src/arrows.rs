//! Board arrow geometry. User-drawn arrows and engine PV suggestions share this.

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ArrowError {
    #[error("invalid square: {0}")]
    Square(String),
    #[error("invalid move: {0}")]
    Move(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ArrowGeom {
    pub from: String,
    pub to: String,
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
    pub angle_rad: f64,
    pub length: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BoardArrow {
    pub from: String,
    pub to: String,
    pub color: String,
    pub source: String,
}

pub fn parse_square(square: &str) -> Result<(u8, u8), ArrowError> {
    let bytes = square.as_bytes();
    if bytes.len() != 2 {
        return Err(ArrowError::Square(square.to_string()));
    }
    let file = bytes[0];
    let rank = bytes[1];
    if !(b'a'..=b'h').contains(&file) || !(b'1'..=b'8').contains(&rank) {
        return Err(ArrowError::Square(square.to_string()));
    }
    Ok((file - b'a', rank - b'1'))
}

/// Center of a square in SVG coordinates (origin top-left, y down).
pub fn square_center(square: &str, board_size: f64, flipped: bool) -> Result<(f64, f64), ArrowError> {
    let (mut file, mut rank) = parse_square(square)?;
    if flipped {
        file = 7 - file;
        rank = 7 - rank;
    }
    let sq = board_size / 8.0;
    let x = (f64::from(file) + 0.5) * sq;
    let y = (7.0 - f64::from(rank) + 0.5) * sq;
    Ok((x, y))
}

pub fn arrow_from_squares(
    from: &str,
    to: &str,
    board_size: f64,
    flipped: bool,
) -> Result<ArrowGeom, ArrowError> {
    let (x1, y1) = square_center(from, board_size, flipped)?;
    let (x2, y2) = square_center(to, board_size, flipped)?;
    let dx = x2 - x1;
    let dy = y2 - y1;
    let length = dx.hypot(dy);
    let angle_rad = dy.atan2(dx);
    Ok(ArrowGeom {
        from: from.to_string(),
        to: to.to_string(),
        x1,
        y1,
        x2,
        y2,
        angle_rad,
        length,
    })
}

pub fn arrow_from_move(
    uci: &str,
    board_size: f64,
    flipped: bool,
) -> Result<ArrowGeom, ArrowError> {
    if uci.len() < 4 {
        return Err(ArrowError::Move(uci.to_string()));
    }
    arrow_from_squares(&uci[0..2], &uci[2..4], board_size, flipped)
}

pub fn arrows_from_pv(pv: &[String], board_size: f64, flipped: bool) -> Vec<ArrowGeom> {
    pv.iter()
        .filter_map(|uci| arrow_from_move(uci, board_size, flipped).ok())
        .collect()
}

//! Gating tests for the shipped FIDE rules API (`nevaska_lib::chess`).

use nevaska_lib::chess::{Game, GameResult, Side};

fn play_all(game: &mut Game, moves: &[&str]) {
    for mv in moves {
        game.play(mv).unwrap_or_else(|e| panic!("failed to play {mv}: {e}"));
    }
}

#[test]
fn startpos_is_legal_with_twenty_moves() {
    let game = Game::startpos();
    let legal = game.legal_moves();
    assert_eq!(legal.len(), 20);
    assert!(game.is_legal("e2e4"));
    assert!(game.is_legal("g1f3"));
    assert!(!game.is_legal("e2e5"));
    assert_eq!(game.side_to_move(), Side::White);
    assert!(!game.in_check());
    assert!(matches!(game.result(), GameResult::Playing));
    let fen = game.fen();
    assert!(fen.starts_with("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq"));
    assert_eq!(game.pieces().len(), 32);
}

#[test]
fn castling_kingside_and_queenside() {
    let mut game = Game::from_fen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1").unwrap();
    assert!(game.can_castle(Side::White, true));
    assert!(game.can_castle(Side::White, false));
    assert!(game.is_legal("e1g1"));
    assert!(game.is_legal("e1c1"));
    let played = game.play("e1g1").unwrap();
    assert_eq!(played.san, "O-O");
    assert_eq!(
        game.pieces()
            .iter()
            .find(|p| p.square == "g1")
            .map(|p| p.code.as_str()),
        Some("wK")
    );
    assert_eq!(
        game.pieces()
            .iter()
            .find(|p| p.square == "f1")
            .map(|p| p.code.as_str()),
        Some("wR")
    );
    assert!(!game.can_castle(Side::White, true));

    let mut queenside = Game::from_fen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1").unwrap();
    let played = queenside.play("e1c1").unwrap();
    assert_eq!(played.san, "O-O-O");
    assert_eq!(
        queenside
            .pieces()
            .iter()
            .find(|p| p.square == "c1")
            .map(|p| p.code.as_str()),
        Some("wK")
    );
}

#[test]
fn castling_denied_through_check() {
    let game = Game::from_fen("r3k2r/8/8/8/8/8/4r3/R3K2R w KQkq - 0 1").unwrap();
    assert!(!game.is_legal("e1g1"));
}

#[test]
fn en_passant_capture() {
    let mut game = Game::from_fen("rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3").unwrap();
    assert!(game.is_legal("e5d6"));
    let played = game.play("e5d6").unwrap();
    assert!(played.san.contains("xd6") || played.uci == "e5d6");
    assert!(game
        .pieces()
        .iter()
        .any(|p| p.square == "d6" && p.code == "wP"));
    assert!(!game.pieces().iter().any(|p| p.square == "d5"));
}

#[test]
fn promotion_requires_piece_and_plays() {
    let mut game = Game::from_fen("8/P7/8/8/8/8/8/4K2k w - - 0 1").unwrap();
    let err = game.play("a7a8").unwrap_err();
    assert!(err.to_string().to_ascii_lowercase().contains("promotion"));
    let played = game.play("a7a8q").unwrap();
    assert!(played.san.contains('Q') || played.uci.ends_with('q'));
    assert!(game
        .pieces()
        .iter()
        .any(|p| p.square == "a8" && p.code == "wQ"));
}

#[test]
fn fools_mate_is_checkmate() {
    let mut game = Game::startpos();
    play_all(&mut game, &["f2f3", "e7e5", "g2g4", "d8h4"]);
    match game.result() {
        GameResult::Checkmate { winner } => assert_eq!(winner, Side::Black),
        other => panic!("expected checkmate, got {other:?}"),
    }
}

#[test]
fn stalemate_from_known_position() {
    let game = Game::from_fen("k7/8/1Q6/8/8/8/8/K7 b - - 0 1").unwrap();
    assert!(!game.in_check());
    assert_eq!(game.legal_moves().len(), 0);
    assert!(matches!(game.result(), GameResult::Stalemate));
}

#[test]
fn fifty_move_rule() {
    let mut game = Game::from_fen("4k3/8/8/8/8/8/7R/4K3 w - - 99 80").unwrap();
    assert!(matches!(game.result(), GameResult::Playing));
    game.play("h2h3").unwrap();
    assert!(matches!(game.result(), GameResult::FiftyMove));
}

#[test]
fn threefold_repetition() {
    let mut game = Game::startpos();
    play_all(
        &mut game,
        &[
            "g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1", "f6g8",
        ],
    );
    assert!(matches!(game.result(), GameResult::Threefold));
}

#[test]
fn insufficient_material() {
    let kings = Game::from_fen("4k3/8/8/8/8/8/8/4K3 w - - 0 1").unwrap();
    assert!(matches!(kings.result(), GameResult::InsufficientMaterial));

    let knight = Game::from_fen("4k3/8/8/8/8/8/8/4KN2 w - - 0 1").unwrap();
    assert!(matches!(knight.result(), GameResult::InsufficientMaterial));

    let bishop = Game::from_fen("4k3/8/8/8/8/8/8/4KB2 w - - 0 1").unwrap();
    assert!(matches!(bishop.result(), GameResult::InsufficientMaterial));
}

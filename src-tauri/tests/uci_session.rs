//! Gating tests: shipped UCI session against a real stub process, plus arrows.

use nevaska_lib::arrows::{arrow_from_move, arrow_from_squares};
use nevaska_lib::chess::Game;
use nevaska_lib::play::{engine_versus_engine_ply, human_then_engine, TimeControl};
use nevaska_lib::uci::{apply_engine_config, GoLimits, UciSession};

fn stub_path() -> String {
    env!("CARGO_BIN_EXE_stub_uci").to_string()
}

fn live_engine() -> UciSession {
    let mut session = UciSession::spawn(stub_path()).expect("spawn stub");
    session.handshake().expect("uci handshake");
    session
}

#[test]
fn handshake_advertises_stockfish_and_lc0_options() {
    let engine = live_engine();
    assert_eq!(engine.info.name, "Nevaska Stub");
    for name in [
        "Threads",
        "EvalFile",
        "WeightsFile",
        "UCI_LimitStrength",
        "UCI_Elo",
        "MultiPV",
    ] {
        assert!(
            engine.info.has_option(name),
            "missing advertised option {name}"
        );
    }
}

#[test]
fn setoption_threads_nnue_weights_and_elo_then_go_with_clock() {
    let engine = live_engine();
    let sent = apply_engine_config(
        &engine,
        4,
        Some("/tmp/custom.nnue"),
        Some("/tmp/lc0.pb"),
        true,
        1600,
        Some(64),
        Some(2),
    )
    .expect("apply config");
    assert!(sent.iter().any(|(n, v)| n == "Threads" && v == "4"));
    assert!(sent.iter().any(|(n, v)| n == "EvalFile" && v == "/tmp/custom.nnue"));
    assert!(sent.iter().any(|(n, v)| n == "WeightsFile" && v == "/tmp/lc0.pb"));
    assert!(sent.iter().any(|(n, v)| n == "UCI_LimitStrength" && v == "true"));
    assert!(sent.iter().any(|(n, v)| n == "UCI_Elo" && v == "1600"));

    engine.position_startpos(&[]).unwrap();
    let limits = GoLimits {
        wtime: Some(60_000),
        btime: Some(60_000),
        winc: Some(1_000),
        binc: Some(1_000),
        ..GoLimits::default()
    };
    let result = engine.go(&limits, |_| {}).expect("go");
    let echo = result
        .infos
        .iter()
        .find_map(|i| i.string.as_deref())
        .expect("info string echo");
    assert!(echo.contains("Threads=4"), "{echo}");
    assert!(echo.contains("EvalFile=/tmp/custom.nnue"), "{echo}");
    assert!(echo.contains("WeightsFile=/tmp/lc0.pb"), "{echo}");
    assert!(echo.contains("UCI_LimitStrength=true"), "{echo}");
    assert!(echo.contains("UCI_Elo=1600"), "{echo}");
    assert!(echo.contains("wtime 60000"), "{echo}");
    assert!(echo.contains("btime 60000"), "{echo}");

    let pv = result
        .infos
        .iter()
        .find(|i| i.multipv == Some(1))
        .expect("multipv 1");
    assert_eq!(pv.depth, Some(8));
    assert_eq!(pv.score_cp, Some(32));
    assert!(!pv.pv.is_empty());
    assert_eq!(result.bestmove, "e2e4");
}

#[test]
fn apply_bestmove_onto_the_game() {
    let mut game = Game::startpos();
    let engine = live_engine();
    engine.position_startpos(&[]).unwrap();
    let result = engine
        .go(&GoLimits { movetime: Some(50), ..GoLimits::default() }, |_| {})
        .unwrap();
    game.play(&result.bestmove).unwrap();
    assert_eq!(game.moves()[0].uci, result.bestmove);
    assert_eq!(game.side_to_move(), nevaska_lib::chess::Side::Black);
}

#[test]
fn human_versus_engine_ply() {
    let mut game = Game::startpos();
    let engine = live_engine();
    let limits = TimeControl {
        initial_ms: 5_000,
        increment_ms: 0,
        infinite: false,
    }
    .go_limits(5_000, 5_000);
    let result = human_then_engine(&mut game, "e2e4", &engine, &limits).expect("human vs engine");
    assert_eq!(game.moves()[0].uci, "e2e4");
    assert_eq!(game.moves()[1].uci, result.bestmove);
    assert_eq!(game.moves().len(), 2);
}

#[test]
fn two_engines_play_a_ply() {
    let mut game = Game::startpos();
    let white = live_engine();
    let black = live_engine();
    let limits = GoLimits {
        wtime: Some(1_000),
        btime: Some(1_000),
        ..GoLimits::default()
    };
    let (a, b) = engine_versus_engine_ply(&mut game, &white, &black, &limits).expect("e vs e");
    assert_eq!(game.moves().len(), 2);
    assert_eq!(game.moves()[0].uci, a.bestmove);
    assert_eq!(game.moves()[1].uci, b.bestmove);
}

#[test]
fn arrow_from_move_and_from_squares() {
    let from_move = arrow_from_move("e2e4", 800.0, false).unwrap();
    let from_squares = arrow_from_squares("e2", "e4", 800.0, false).unwrap();
    assert_eq!(from_move, from_squares);
    assert_eq!(from_move.from, "e2");
    assert_eq!(from_move.to, "e4");
    assert!(from_move.length > 0.0);
    // e-file is the 5th file (index 4); unflipped rank 2 is near the bottom.
    let sq = 800.0 / 8.0;
    assert!((from_move.x1 - (4.5 * sq)).abs() < 0.001);
    assert!(from_move.y1 > from_move.y2); // moving up the board in SVG y-down

    let flipped = arrow_from_squares("e2", "e4", 800.0, true).unwrap();
    assert!((flipped.x1 - (3.5 * sq)).abs() < 0.001);
    assert!(flipped.y1 < flipped.y2);
}

#[test]
fn parses_live_statistics_and_wdl() {
    let info = nevaska_lib::uci::parse_info_line("info depth 24 seldepth 38 multipv 2 score cp -40 wdl 100 600 300 nodes 90000 nps 30000 time 3000 hashfull 123 tbhits 9 pv e7e5").unwrap();
    assert_eq!(info.wdl, Some([100, 600, 300]));
    assert_eq!(info.hashfull, Some(123));
    assert_eq!(info.tbhits, Some(9));
    assert_eq!(info.pv, vec!["e7e5"]);
    assert_eq!(info.score_cp, Some(-40));
}

#[test]
fn searches_loaded_fen_instead_of_start_position() {
    let game = Game::from_fen("7k/8/8/8/8/8/6R1/7K b - - 0 1").unwrap();
    let engine = live_engine();
    let result = nevaska_lib::play::engine_search(&engine, &game, &GoLimits { depth: Some(1), ..GoLimits::default() }, |_| {}).unwrap();
    assert!(game.legal_moves().contains(&result.bestmove));
}

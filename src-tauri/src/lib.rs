pub mod arrows;
pub mod channel;
pub mod chess;
pub mod engines;
pub mod play;
pub mod uci;

use arrows::{arrow_from_move, arrow_from_squares, ArrowGeom, BoardArrow};
use channel::{accept_payload, channel_of, endpoint_for, Channel};
use chess::{ChessError, Game, GameState};
use engines::{
    engines_file, load_engines, probe_engine, save_engines, EngineConfig, EngineKind,
};
use play::{analysis_limits, engine_search, PlayMode, TimeControl};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager, State};
use uci::{GoLimits, GoResult, InfoLine, UciSession};

struct Inner {
    game: Game,
    engines: Vec<EngineConfig>,
    arrows: Vec<BoardArrow>,
    mode: PlayMode,
    white_engine: Option<String>,
    black_engine: Option<String>,
    analysis_engine: Option<String>,
    time: TimeControl,
    white_ms: u64,
    black_ms: u64,
}

struct AppState {
    operation: Mutex<()>,
    generation: AtomicU64,
    inner: Mutex<Inner>,
    sessions: Mutex<HashMap<String, Arc<UciSession>>>,
    data_dir: Mutex<Option<std::path::PathBuf>>,
}

impl AppState {
    fn new() -> Self {
        Self {
            operation: Mutex::new(()),
            generation: AtomicU64::new(0),
            inner: Mutex::new(Inner {
                game: Game::startpos(),
                engines: Vec::new(),
                arrows: Vec::new(),
                mode: PlayMode::HumanHuman,
                white_engine: None,
                black_engine: None,
                analysis_engine: None,
                time: TimeControl::classical_ten(),
                white_ms: TimeControl::classical_ten().initial_ms,
                black_ms: TimeControl::classical_ten().initial_ms,
            }),
            sessions: Mutex::new(HashMap::new()),
            data_dir: Mutex::new(None),
        }
    }
}

fn map_chess(err: ChessError) -> String {
    err.to_string()
}

#[tauri::command]
fn game_state(state: State<AppState>) -> GameState {
    state.inner.lock().expect("state").game.state()
}

#[tauri::command]
fn new_game(app: AppHandle, state: State<AppState>) -> GameState {
    let _operation = state.operation.lock().expect("operation");
    cancel_searches(&state);
    let mut inner = state.inner.lock().expect("state");
    inner.game = Game::startpos();
    inner.arrows.clear();
    inner.white_ms = inner.time.initial_ms;
    inner.black_ms = inner.time.initial_ms;
    let snapshot = inner.game.state();
    drop(inner);
    resume_searches(&app, &state);
    snapshot
}

#[tauri::command]
fn play_move(app: AppHandle, state: State<AppState>, uci: String) -> Result<GameState, String> {
    let _operation = state.operation.lock().expect("operation");
    if !state.inner.lock().expect("state").game.is_legal(&uci) { return Err("Illegal move".into()); }
    cancel_searches(&state);
    {
        let mut inner = state.inner.lock().expect("state");
        inner.game.play(&uci).map_err(map_chess)?;
        inner.arrows.retain(|a| a.source != "engine");
    }
    resume_searches(&app, &state);
    Ok(state.inner.lock().expect("state").game.state())
}

#[tauri::command]
fn undo_move(app: AppHandle, state: State<AppState>) -> Result<GameState, String> {
    let _operation = state.operation.lock().expect("operation");
    cancel_searches(&state);
    let mut inner = state.inner.lock().expect("state");
    inner.game.undo().map_err(map_chess)?;
    let snapshot = inner.game.state();
    drop(inner);
    resume_searches(&app, &state);
    Ok(snapshot)
}

#[tauri::command]
fn goto_ply(app: AppHandle, state: State<AppState>, ply: usize) -> Result<GameState, String> {
    let _operation = state.operation.lock().expect("operation");
    cancel_searches(&state);
    let mut inner = state.inner.lock().expect("state");
    inner.game.goto_ply(ply).map_err(map_chess)?;
    let snapshot = inner.game.state();
    drop(inner);
    resume_searches(&app, &state);
    Ok(snapshot)
}

#[tauri::command]
fn load_fen(app: AppHandle, state: State<AppState>, fen: String) -> Result<GameState, String> {
    let _operation = state.operation.lock().expect("operation");
    let game = Game::from_fen(&fen).map_err(map_chess)?;
    cancel_searches(&state);
    let mut inner = state.inner.lock().expect("state");
    inner.game = game;
    inner.arrows.clear();
    let snapshot = inner.game.state();
    drop(inner);
    resume_searches(&app, &state);
    Ok(snapshot)
}

#[tauri::command]
fn load_pgn(app: AppHandle, state: State<AppState>, pgn: String) -> Result<GameState, String> {
    let _operation = state.operation.lock().expect("operation");
    let game = Game::from_pgn(&pgn).map_err(map_chess)?;
    cancel_searches(&state);
    let mut inner = state.inner.lock().expect("state");
    inner.game = game;
    inner.arrows.clear();
    let snapshot = inner.game.state();
    drop(inner);
    resume_searches(&app, &state);
    Ok(snapshot)
}

#[tauri::command]
fn export_pgn(state: State<AppState>) -> String {
    state.inner.lock().expect("state").game.pgn()
}

#[tauri::command]
fn export_fen(state: State<AppState>) -> String {
    state.inner.lock().expect("state").game.fen()
}

#[tauri::command]
fn list_engines(state: State<AppState>) -> Vec<EngineConfig> {
    state.inner.lock().expect("state").engines.clone()
}

#[tauri::command]
fn add_engine(state: State<AppState>, path: String) -> Result<EngineConfig, String> {
    let (info, _kind) = probe_engine(&path).map_err(|e| e.to_string())?;
    let config = EngineConfig::from_probe(&path, &info);
    {
        let mut inner = state.inner.lock().expect("state");
        inner.engines.push(config.clone());
        persist_engines(&state, &inner.engines)?;
    }
    Ok(config)
}

#[tauri::command]
fn update_engine(app: AppHandle, state: State<AppState>, config: EngineConfig) -> Result<Vec<EngineConfig>, String> {
    let _operation = state.operation.lock().expect("operation");
    cancel_searches(&state);
    let mut inner = state.inner.lock().expect("state");
    if let Some(existing) = inner.engines.iter_mut().find(|e| e.id == config.id) {
        *existing = config;
    } else {
        return Err("engine not found".into());
    }
    persist_engines(&state, &inner.engines)?;
    let engines = inner.engines.clone();
    drop(inner);
    resume_searches(&app, &state);
    Ok(engines)
}

#[tauri::command]
fn remove_engine(app: AppHandle, state: State<AppState>, id: String) -> Result<Vec<EngineConfig>, String> {
    let _operation = state.operation.lock().expect("operation");
    cancel_searches(&state);
    let mut inner = state.inner.lock().expect("state");
    inner.engines.retain(|e| e.id != id);
    if inner.analysis_engine.as_ref() == Some(&id) { inner.analysis_engine = None; }
    if inner.white_engine.as_ref() == Some(&id) { inner.white_engine = None; }
    if inner.black_engine.as_ref() == Some(&id) { inner.black_engine = None; }
    persist_engines(&state, &inner.engines)?;
    let engines = inner.engines.clone();
    drop(inner);
    resume_searches(&app, &state);
    Ok(engines)
}

#[tauri::command]
fn probe_engine_path(path: String) -> Result<EngineConfig, String> {
    let (info, _kind) = probe_engine(&path).map_err(|e| e.to_string())?;
    Ok(EngineConfig::from_probe(&path, &info))
}

#[derive(Debug, Deserialize)]
struct PlaySetup {
    mode: PlayMode,
    white_engine: Option<String>,
    black_engine: Option<String>,
    analysis_engine: Option<String>,
    initial_ms: u64,
    increment_ms: u64,
    infinite: bool,
}

#[tauri::command]
fn configure_play(app: AppHandle, state: State<AppState>, setup: PlaySetup) -> Result<GameState, String> {
    let _operation = state.operation.lock().expect("operation");
    cancel_searches(&state);
    {
        let mut inner = state.inner.lock().expect("state");
        inner.mode = setup.mode;
        inner.white_engine = setup.white_engine;
        inner.black_engine = setup.black_engine;
        inner.analysis_engine = setup.analysis_engine;
        inner.time = TimeControl {
            initial_ms: setup.initial_ms,
            increment_ms: setup.increment_ms,
            infinite: setup.infinite,
        };
        inner.white_ms = setup.initial_ms;
        inner.black_ms = setup.initial_ms;
    }
    resume_searches(&app, &state);
    Ok(state.inner.lock().expect("state").game.state())
}

#[tauri::command]
fn stop_search(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let _operation = state.operation.lock().expect("operation");
    cancel_searches(&state);
    state.inner.lock().expect("state").mode = PlayMode::HumanHuman;
    kick_analysis(&app, &state);
    Ok(())
}

fn cancel_searches(state: &AppState) {
    state.generation.fetch_add(1, Ordering::SeqCst);
    for (_, session) in state.sessions.lock().expect("sessions").drain() {
        let _ = session.quit();
    }
}

fn resume_searches(app: &AppHandle, state: &AppState) {
    maybe_kick_engine(app, state);
    // A separate process keeps live evaluation available in every play mode.
    kick_analysis(app, state);
}

#[tauri::command]
fn add_arrow(state: State<AppState>, from: String, to: String, color: String) -> Result<Vec<BoardArrow>, String> {
    let mut inner = state.inner.lock().expect("state");
    inner.arrows.retain(|a| !(a.from == from && a.to == to && a.source == "user"));
    inner.arrows.push(BoardArrow {
        from,
        to,
        color,
        source: "user".into(),
    });
    Ok(inner.arrows.clone())
}

#[tauri::command]
fn clear_arrows(state: State<AppState>) -> Vec<BoardArrow> {
    let mut inner = state.inner.lock().expect("state");
    inner.arrows.clear();
    inner.arrows.clone()
}

#[tauri::command]
fn list_arrows(state: State<AppState>) -> Vec<BoardArrow> {
    state.inner.lock().expect("state").arrows.clone()
}

#[tauri::command]
fn arrow_geometry(from: String, to: String, board_size: f64, flipped: bool) -> Result<ArrowGeom, String> {
    arrow_from_squares(&from, &to, board_size, flipped).map_err(|e| e.to_string())
}

#[tauri::command]
fn arrow_geometry_move(uci: String, board_size: f64, flipped: bool) -> Result<ArrowGeom, String> {
    arrow_from_move(&uci, board_size, flipped).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct ChannelInfo {
    version: String,
    channel: String,
    label: String,
    endpoint: String,
}

#[tauri::command]
fn channel_info(app: AppHandle) -> ChannelInfo {
    let version = app.package_info().version.to_string();
    let channel = channel_of(&version);
    let repo = option_env!("NEVASKA_REPO").unwrap_or(channel::DEFAULT_REPO);
    ChannelInfo {
        version: version.clone(),
        channel: channel.as_str().to_string(),
        label: channel.label().to_string(),
        endpoint: app.config().plugins.0.get("updater")
            .and_then(|config| config.get("endpoints"))
            .and_then(|endpoints| endpoints.get(0))
            .and_then(|endpoint| endpoint.as_str())
            .map(str::to_owned)
            .unwrap_or_else(|| endpoint_for(channel, repo)),
    }
}

#[derive(Deserialize)]
struct UpdateOffer {
    running_version: String,
    payload_version: String,
    running_endpoint: String,
    payload_endpoint: String,
}

#[tauri::command]
fn evaluate_update_payload(offer: UpdateOffer) -> bool {
    accept_payload(
        &offer.running_version,
        &offer.payload_version,
        &offer.running_endpoint,
        &offer.payload_endpoint,
    )
}

#[tauri::command]
fn set_clocks(state: State<AppState>, white_ms: u64, black_ms: u64) {
    let mut inner = state.inner.lock().expect("state");
    inner.white_ms = white_ms;
    inner.black_ms = black_ms;
}

fn persist_engines(state: &State<AppState>, engines: &[EngineConfig]) -> Result<(), String> {
    let dir = state.data_dir.lock().expect("dir").clone();
    if let Some(dir) = dir {
        save_engines(&engines_file(dir), engines).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn ensure_session(state: &AppState, engine_id: &str, analysis: bool) -> Result<Arc<UciSession>, String> {
    let key = format!("{engine_id}:{analysis}");
    {
        let sessions = state.sessions.lock().expect("sessions");
        if let Some(existing) = sessions.get(&key) {
            return Ok(Arc::clone(existing));
        }
    }
    let config = {
        let inner = state.inner.lock().expect("state");
        inner
            .engines
            .iter()
            .find(|e| e.id == engine_id)
            .cloned()
            .ok_or_else(|| "engine not configured".to_string())?
    };
    let mut session = UciSession::spawn(&config.path).map_err(|e| e.to_string())?;
    session.handshake().map_err(|e| e.to_string())?;
    config.apply(&session).map_err(|e| e.to_string())?;
    session.new_game().map_err(|e| e.to_string())?;
    let session = Arc::new(session);
    state
        .sessions
        .lock()
        .expect("sessions")
        .insert(key, Arc::clone(&session));
    Ok(session)
}

fn maybe_kick_engine(app: &AppHandle, state: &AppState) {
    let (mode, white, black, result_over, turn) = {
        let inner = state.inner.lock().expect("state");
        (
            inner.mode,
            inner.white_engine.clone(),
            inner.black_engine.clone(),
            inner.game.result().is_over(),
            inner.game.side_to_move(),
        )
    };
    if result_over {
        return;
    }
    let engine_id = match mode {
        PlayMode::HumanWhite if matches!(turn, chess::Side::Black) => black,
        PlayMode::HumanBlack if matches!(turn, chess::Side::White) => white,
        PlayMode::EngineEngine => match turn {
            chess::Side::White => white,
            chess::Side::Black => black,
        },
        _ => None,
    };
    if let Some(id) = engine_id {
        kick_search(app, state, &id, false);
    }
}

fn kick_analysis(app: &AppHandle, state: &AppState) {
    let id = state.inner.lock().expect("state").analysis_engine.clone();
    if let Some(id) = id {
        kick_search(app, state, &id, true);
    }
}

fn kick_search(app: &AppHandle, state: &AppState, engine_id: &str, analysis: bool) {
    let generation = state.generation.load(Ordering::SeqCst);
    let session = match ensure_session(state, engine_id, analysis) {
        Ok(session) => session,
        Err(err) => { let _ = app.emit("engine-error", err); return; }
    };
    let (game, limits) = {
        let inner = state.inner.lock().expect("state");
        let limits = if analysis {
            analysis_limits()
        } else {
            inner.time.go_limits(inner.white_ms, inner.black_ms)
        };
        (inner.game.clone(), limits)
    };
    let handle = app.clone();
    let engine_id = engine_id.to_string();
    std::thread::spawn(move || {
        let _ = handle.emit("engine-thinking", engine_id.clone());
        let result = engine_search(&session, &game, &limits, |mut info| {
            let state = handle.state::<AppState>();
            if state.generation.load(Ordering::SeqCst) != generation { return; }
            if !analysis && state.inner.lock().expect("state").analysis_engine.is_some() { return; }
            info.fen = Some(game.fen());
            info.engine_id = Some(engine_id.clone());
            if matches!(game.side_to_move(), chess::Side::Black) {
                info.score_cp = info.score_cp.map(|v| -v);
                info.score_mate = info.score_mate.map(|v| -v);
                info.wdl = info.wdl.map(|v| [v[2], v[1], v[0]]);
            }
            info.pv_san = game.pv_san(&info.pv);
            let _ = handle.emit("engine-info", info);
        });
        let app_state = handle.state::<AppState>();
        let _operation = app_state.operation.lock().expect("operation");
        if app_state.generation.load(Ordering::SeqCst) != generation { return; }
        match result {
            Ok(go) => {
                let _ = handle.emit("engine-bestmove", go.clone());
                if !analysis {
                    if let Some(state) = handle.try_state::<AppState>() {
                        let mut inner = state.inner.lock().expect("state");
                        if state.generation.load(Ordering::SeqCst) != generation || inner.game.fen() != game.fen() { return; }
                        if !inner.game.result().is_over() {
                            if inner.game.play(&go.bestmove).is_ok() {
                                inner.arrows.retain(|a| a.source != "engine");
                                if let Some(geom_uci) = go.infos.iter().rev().find_map(|i| i.pv.first())
                                {
                                    if let Ok(_g) = arrow_from_move(geom_uci, 1.0, false) {
                                        inner.arrows.push(BoardArrow {
                                            from: geom_uci[..2].to_string(),
                                            to: geom_uci[2..4].to_string(),
                                            color: "#9EC9D9".into(),
                                            source: "engine".into(),
                                        });
                                    }
                                }
                            }
                        }
                        let snapshot = inner.game.state();
                        drop(inner);
                        let _ = handle.emit("game-state", snapshot);
                        cancel_searches(&state);
                        resume_searches(&handle, &state);
                    }
                }
            }
            Err(err) => {
                let _ = handle.emit("engine-error", err.to_string());
            }
        }
    });
}

fn load_persisted(app: &AppHandle, state: &AppState) {
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        *state.data_dir.lock().expect("dir") = Some(dir.clone());
        if let Ok(engines) = load_engines(&engines_file(dir)) {
            state.inner.lock().expect("state").engines = engines;
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new()
            .default_version_comparator(|current, candidate| {
                channel::accept_update(&current.to_string(), &candidate.version.to_string())
            })
            .build())
        .manage(AppState::new())
        .setup(|app| {
            let state = app.state::<AppState>();
            load_persisted(app.handle(), &state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            game_state,
            new_game,
            play_move,
            undo_move,
            goto_ply,
            load_fen,
            load_pgn,
            export_pgn,
            export_fen,
            list_engines,
            add_engine,
            update_engine,
            remove_engine,
            probe_engine_path,
            configure_play,
            stop_search,
            add_arrow,
            clear_arrows,
            list_arrows,
            arrow_geometry,
            arrow_geometry_move,
            channel_info,
            evaluate_update_payload,
            set_clocks,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nevaska");
}

// Silence unused import in lib when EngineKind is only used via serde.
#[allow(dead_code)]
fn _kind_ref() -> EngineKind {
    EngineKind::Uci
}

#[allow(dead_code)]
fn _limits_ref() -> GoLimits {
    GoLimits::default()
}

#[allow(dead_code)]
fn _info_ref() -> Option<InfoLine> {
    None
}

#[allow(dead_code)]
fn _go_ref() -> Option<GoResult> {
    None
}

#[allow(dead_code)]
fn _ch_ref() -> Channel {
    Channel::Stable
}

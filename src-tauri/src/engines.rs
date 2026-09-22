//! Persisted UCI engine registry. Stockfish and lc0 are first-class kinds.

use crate::uci::{apply_engine_config, EngineInfo, UciSession};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Uci(#[from] crate::uci::UciError),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EngineKind {
    Stockfish,
    Lc0,
    Uci,
}

impl EngineKind {
    pub fn detect(name: &str, path: &str) -> Self {
        let blob = format!("{name} {path}").to_ascii_lowercase();
        if blob.contains("stockfish") {
            EngineKind::Stockfish
        } else if blob.contains("lc0") || blob.contains("leela") {
            EngineKind::Lc0
        } else {
            EngineKind::Uci
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EngineConfig {
    pub id: String,
    pub name: String,
    pub path: String,
    pub kind: EngineKind,
    pub threads: u32,
    pub hash_mb: u32,
    pub eval_file: Option<String>,
    pub weights_file: Option<String>,
    pub limit_strength: bool,
    pub elo: u32,
    pub multipv: u32,
    /// Default `EvalFile` name advertised by the binary. Empty when unknown.
    #[serde(default)]
    pub nnue_name: Option<String>,
}

/// Network embedded in the Stockfish 19 universal binary (`EvalFile` default).
pub const STOCKFISH_19_NNUE: &str = "nn-1a298aa575a0.nnue";

pub fn stockfish_major(name: &str) -> Option<u32> {
    name.split(|c: char| !c.is_ascii_digit())
        .find(|part| !part.is_empty())
        .and_then(|part| part.parse().ok())
}

impl EngineConfig {
    pub fn from_probe(path: &str, info: &EngineInfo) -> Self {
        let kind = EngineKind::detect(&info.name, path);
        Self {
            id: Uuid::new_v4().to_string(),
            name: info.name.clone(),
            path: path.to_string(),
            kind,
            threads: default_threads(),
            hash_mb: 128,
            eval_file: None,
            weights_file: None,
            limit_strength: false,
            elo: 1500,
            multipv: 3,
            nnue_name: info
                .option("EvalFile")
                .and_then(|opt| opt.default.clone())
                .filter(|name| !name.is_empty() && name != "<empty>"),
        }
    }

    pub fn apply(&self, session: &UciSession) -> Result<Vec<(String, String)>, EngineError> {
        Ok(apply_engine_config(
            session,
            self.threads,
            self.eval_file.as_deref(),
            self.weights_file.as_deref(),
            self.limit_strength,
            self.elo,
            Some(self.hash_mb),
            Some(self.multipv),
        )?)
    }
}

pub fn default_threads() -> u32 {
    std::thread::available_parallelism()
        .map(|n| n.get() as u32)
        .unwrap_or(4)
        .clamp(1, 64)
}

pub fn load_engines(path: &Path) -> Result<Vec<EngineConfig>, EngineError> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(path)?;
    Ok(serde_json::from_str(&text)?)
}

pub fn save_engines(path: &Path, engines: &[EngineConfig]) -> Result<(), EngineError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_string_pretty(engines)?)?;
    Ok(())
}

pub fn engines_file(app_data: PathBuf) -> PathBuf {
    app_data.join("engines.json")
}

/// Open the binary, run `uci`, and return advertised options. The process is
/// dropped afterwards — adding an engine does not keep it running.
pub fn probe_engine(path: &str) -> Result<(EngineInfo, EngineKind), EngineError> {
    if !Path::new(path).exists() {
        return Err(EngineError::Message(format!("engine not found: {path}")));
    }
    let mut session = UciSession::spawn(path)?;
    let info = session.handshake()?.clone();
    let kind = EngineKind::detect(&info.name, path);
    let _ = session.quit();
    Ok((info, kind))
}

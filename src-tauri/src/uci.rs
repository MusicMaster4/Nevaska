//! UCI session over a real engine process (stdin/stdout).
//!
//! Tests drive this type against the `stub_uci` binary. The GUI uses the same
//! type to talk to Stockfish, lc0, or any other UCI engine.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum UciError {
    #[error("failed to spawn engine at {path}: {source}")]
    Spawn {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("engine I/O: {0}")]
    Io(#[from] std::io::Error),
    #[error("engine closed the pipe")]
    Closed,
    #[error("engine handshake failed: {0}")]
    Handshake(String),
    #[error("engine did not send bestmove")]
    NoBestMove,
    #[error("{0}")]
    Other(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UciOption {
    pub name: String,
    pub kind: String,
    pub default: Option<String>,
    pub min: Option<i64>,
    pub max: Option<i64>,
    pub vars: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EngineInfo {
    pub name: String,
    pub author: String,
    pub options: Vec<UciOption>,
}

impl EngineInfo {
    pub fn has_option(&self, name: &str) -> bool {
        self.options.iter().any(|o| o.name.eq_ignore_ascii_case(name))
    }

    pub fn option(&self, name: &str) -> Option<&UciOption> {
        self.options
            .iter()
            .find(|o| o.name.eq_ignore_ascii_case(name))
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct GoLimits {
    pub wtime: Option<u64>,
    pub btime: Option<u64>,
    pub winc: Option<u64>,
    pub binc: Option<u64>,
    pub movetime: Option<u64>,
    pub depth: Option<u32>,
    pub nodes: Option<u64>,
    pub infinite: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct InfoLine {
    pub fen: Option<String>,
    pub engine_id: Option<String>,
    pub hashfull: Option<u32>,
    pub tbhits: Option<u64>,
    pub wdl: Option<[u32; 3]>,
    pub depth: Option<u32>,
    pub seldepth: Option<u32>,
    pub multipv: Option<u32>,
    pub score_cp: Option<i32>,
    pub score_mate: Option<i32>,
    pub nodes: Option<u64>,
    pub nps: Option<u64>,
    pub time_ms: Option<u64>,
    pub pv: Vec<String>,
    pub pv_san: Vec<String>,
    pub string: Option<String>,
    pub raw: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GoResult {
    pub bestmove: String,
    pub ponder: Option<String>,
    pub infos: Vec<InfoLine>,
}

/// A live UCI engine process.
pub struct UciSession {
    child: Mutex<Child>,
    stdin: Arc<Mutex<ChildStdin>>,
    stdout: Mutex<BufReader<ChildStdout>>,
    pub info: EngineInfo,
    pub path: PathBuf,
    /// Last `setoption` commands actually sent (name, value).
    pub applied: Mutex<Vec<(String, String)>>,
}

impl UciSession {
    pub fn spawn(path: impl AsRef<Path>) -> Result<Self, UciError> {
        let path = path.as_ref();
        let mut cmd = Command::new(path);
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            cmd.current_dir(parent);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|source| UciError::Spawn {
            path: path.display().to_string(),
            source,
        })?;
        let stdin = child.stdin.take().ok_or_else(|| {
            UciError::Other("engine stdin was not piped".into())
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            UciError::Other("engine stdout was not piped".into())
        })?;
        Ok(Self {
            child: Mutex::new(child),
            stdin: Arc::new(Mutex::new(stdin)),
            stdout: Mutex::new(BufReader::new(stdout)),
            info: EngineInfo {
                name: String::new(),
                author: String::new(),
                options: Vec::new(),
            },
            path: path.to_path_buf(),
            applied: Mutex::new(Vec::new()),
        })
    }

    pub fn handshake(&mut self) -> Result<&EngineInfo, UciError> {
        self.write("uci")?;
        let mut name = String::new();
        let mut author = String::new();
        let mut options = Vec::new();
        loop {
            let line = self.read_line()?;
            if let Some(rest) = line.strip_prefix("id name ") {
                name = rest.to_string();
            } else if let Some(rest) = line.strip_prefix("id author ") {
                author = rest.to_string();
            } else if let Some(rest) = line.strip_prefix("option ") {
                options.push(parse_option(rest));
            } else if line == "uciok" {
                break;
            }
        }
        if name.is_empty() {
            return Err(UciError::Handshake("missing id name".into()));
        }
        self.info = EngineInfo {
            name,
            author,
            options,
        };
        Ok(&self.info)
    }

    pub fn isready(&self) -> Result<(), UciError> {
        self.write("isready")?;
        loop {
            let line = self.read_line()?;
            if line == "readyok" {
                return Ok(());
            }
        }
    }

    pub fn set_option(&self, name: &str, value: &str) -> Result<(), UciError> {
        self.write(&format!("setoption name {name} value {value}"))?;
        self.applied
            .lock()
            .expect("applied lock")
            .push((name.to_string(), value.to_string()));
        Ok(())
    }

    pub fn new_game(&self) -> Result<(), UciError> {
        self.write("ucinewgame")?;
        self.isready()
    }

    pub fn position_startpos(&self, moves: &[String]) -> Result<(), UciError> {
        if moves.is_empty() {
            self.write("position startpos")
        } else {
            self.write(&format!("position startpos moves {}", moves.join(" ")))
        }
    }

    pub fn position_fen(&self, fen: &str, moves: &[String]) -> Result<(), UciError> {
        if moves.is_empty() {
            self.write(&format!("position fen {fen}"))
        } else {
            self.write(&format!(
                "position fen {fen} moves {}",
                moves.join(" ")
            ))
        }
    }

    pub fn go(
        &self,
        limits: &GoLimits,
        mut on_info: impl FnMut(InfoLine),
    ) -> Result<GoResult, UciError> {
        self.write(&format_go(limits))?;
        let mut infos = Vec::new();
        loop {
            let line = self.read_line()?;
            if let Some(info) = parse_info_line(&line) {
                on_info(info.clone());
                // Retain only the latest line per variation during infinite analysis.
                infos.retain(|old: &InfoLine| old.multipv != info.multipv);
                infos.push(info);
            }
            if let Some((bestmove, ponder)) = parse_bestmove(&line) {
                return Ok(GoResult {
                    bestmove,
                    ponder,
                    infos,
                });
            }
        }
    }

    pub fn stop(&self) -> Result<(), UciError> {
        self.write("stop")
    }

    pub fn quit(&self) -> Result<(), UciError> {
        let _ = self.write("quit");
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }

    pub fn write(&self, line: &str) -> Result<(), UciError> {
        let mut stdin = self.stdin.lock().expect("stdin lock");
        writeln!(stdin, "{line}")?;
        stdin.flush()?;
        Ok(())
    }

    fn read_line(&self) -> Result<String, UciError> {
        let mut stdout = self.stdout.lock().expect("stdout lock");
        let mut line = String::new();
        let n = stdout.read_line(&mut line)?;
        if n == 0 {
            return Err(UciError::Closed);
        }
        Ok(line.trim_end_matches(['\r', '\n']).to_string())
    }
}

impl Drop for UciSession {
    fn drop(&mut self) {
        let _ = self.write("quit");
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait_timeout_or_kill();
        }
    }
}

trait WaitKill {
    fn wait_timeout_or_kill(&mut self) -> std::io::Result<()>;
}

impl WaitKill for Child {
    fn wait_timeout_or_kill(&mut self) -> std::io::Result<()> {
        let _ = Duration::from_millis(50);
        match self.try_wait()? {
            Some(_) => Ok(()),
            None => {
                self.kill()?;
                self.wait().map(|_| ())
            }
        }
    }
}

pub fn format_go(limits: &GoLimits) -> String {
    if limits.infinite {
        return "go infinite".into();
    }
    let mut parts = vec!["go".to_string()];
    if let Some(v) = limits.wtime {
        parts.push(format!("wtime {v}"));
    }
    if let Some(v) = limits.btime {
        parts.push(format!("btime {v}"));
    }
    if let Some(v) = limits.winc {
        parts.push(format!("winc {v}"));
    }
    if let Some(v) = limits.binc {
        parts.push(format!("binc {v}"));
    }
    if let Some(v) = limits.movetime {
        parts.push(format!("movetime {v}"));
    }
    if let Some(v) = limits.depth {
        parts.push(format!("depth {v}"));
    }
    if let Some(v) = limits.nodes {
        parts.push(format!("nodes {v}"));
    }
    if parts.len() == 1 {
        parts.push("movetime 1000".into());
    }
    parts.join(" ")
}

pub fn parse_info_line(line: &str) -> Option<InfoLine> {
    let line = line.trim();
    if !line.starts_with("info") {
        return None;
    }
    if line == "info" {
        return Some(InfoLine {
            raw: line.to_string(),
            ..InfoLine::default()
        });
    }
    let tokens: Vec<&str> = line.split_whitespace().collect();
    if tokens.first() != Some(&"info") {
        return None;
    }
    let mut info = InfoLine {
        raw: line.to_string(),
        ..InfoLine::default()
    };
    let mut i = 1;
    while i < tokens.len() {
        match tokens[i] {
            "depth" => {
                info.depth = tokens.get(i + 1).and_then(|s| s.parse().ok());
                i += 2;
            }
            "seldepth" => {
                info.seldepth = tokens.get(i + 1).and_then(|s| s.parse().ok());
                i += 2;
            }
            "multipv" => {
                info.multipv = tokens.get(i + 1).and_then(|s| s.parse().ok());
                i += 2;
            }
            "score" => {
                match tokens.get(i + 1).copied() {
                    Some("cp") => {
                        info.score_cp = tokens.get(i + 2).and_then(|s| s.parse().ok());
                        i += 3;
                    }
                    Some("mate") => {
                        info.score_mate = tokens.get(i + 2).and_then(|s| s.parse().ok());
                        i += 3;
                    }
                    _ => i += 1,
                }
                while matches!(tokens.get(i).copied(), Some("lowerbound" | "upperbound")) {
                    i += 1;
                }
            }
            "nodes" => {
                info.nodes = tokens.get(i + 1).and_then(|s| s.parse().ok());
                i += 2;
            }
            "nps" => {
                info.nps = tokens.get(i + 1).and_then(|s| s.parse().ok());
                i += 2;
            }
            "time" => {
                info.time_ms = tokens.get(i + 1).and_then(|s| s.parse().ok());
                i += 2;
            }
            "pv" => {
                info.pv = tokens[i + 1..].iter().map(|s| (*s).to_string()).collect();
                break;
            }
            "string" => {
                info.string = Some(tokens[i + 1..].join(" "));
                break;
            }
            "hashfull" => { info.hashfull = tokens.get(i + 1).and_then(|s| s.parse().ok()); i += 2; }
            "tbhits" => { info.tbhits = tokens.get(i + 1).and_then(|s| s.parse().ok()); i += 2; }
            "wdl" => {
                info.wdl = tokens.get(i+1..i+4).and_then(|v| Some([v[0].parse().ok()?, v[1].parse().ok()?, v[2].parse().ok()?]));
                i += 4;
            }
            "sbhits" | "cpuload" | "currmovenumber" | "currmove"
            | "refutation" | "currline" => {
                i += 2;
            }
            _ => i += 1,
        }
    }
    Some(info)
}

pub fn parse_bestmove(line: &str) -> Option<(String, Option<String>)> {
    let line = line.trim();
    let rest = line.strip_prefix("bestmove ")?;
    let mut parts = rest.split_whitespace();
    let best = parts.next()?.to_string();
    let ponder = match (parts.next(), parts.next()) {
        (Some("ponder"), Some(mv)) => Some(mv.to_string()),
        _ => None,
    };
    Some((best, ponder))
}

fn parse_option(rest: &str) -> UciOption {
    let tokens: Vec<&str> = rest.split_whitespace().collect();
    let mut name_parts = Vec::new();
    let mut kind = String::from("string");
    let mut default = None;
    let mut min = None;
    let mut max = None;
    let mut vars = Vec::new();
    let mut i = 0;
    if tokens.first() == Some(&"name") {
        i = 1;
        while i < tokens.len() && tokens[i] != "type" {
            name_parts.push(tokens[i]);
            i += 1;
        }
    }
    while i < tokens.len() {
        match tokens[i] {
            "type" => {
                kind = tokens.get(i + 1).unwrap_or(&"string").to_string();
                i += 2;
            }
            "default" => {
                default = tokens.get(i + 1).map(|s| (*s).to_string());
                i += 2;
            }
            "min" => {
                min = tokens.get(i + 1).and_then(|s| s.parse().ok());
                i += 2;
            }
            "max" => {
                max = tokens.get(i + 1).and_then(|s| s.parse().ok());
                i += 2;
            }
            "var" => {
                vars.push(tokens.get(i + 1).unwrap_or(&"").to_string());
                i += 2;
            }
            _ => i += 1,
        }
    }
    UciOption {
        name: name_parts.join(" "),
        kind,
        default,
        min,
        max,
        vars,
    }
}

/// Apply the GUI configuration onto a live session, using only options the
/// engine advertised during `uci`.
pub fn apply_engine_config(
    session: &UciSession,
    threads: u32,
    eval_file: Option<&str>,
    weights_file: Option<&str>,
    limit_strength: bool,
    elo: u32,
    hash_mb: Option<u32>,
    multipv: Option<u32>,
) -> Result<Vec<(String, String)>, UciError> {
    let mut sent = Vec::new();
    let set = |name: &str, value: String, session: &UciSession, sent: &mut Vec<(String, String)>| {
        if session.info.has_option(name) {
            session.set_option(name, &value)?;
            sent.push((name.to_string(), value));
        }
        Ok::<(), UciError>(())
    };
    set("Threads", threads.to_string(), session, &mut sent)?;
    set("UCI_ShowWDL", "true".into(), session, &mut sent)?;
    if let Some(hash) = hash_mb {
        set("Hash", hash.to_string(), session, &mut sent)?;
    }
    if let Some(path) = eval_file {
        // Stockfish NNUE
        set("EvalFile", path.to_string(), session, &mut sent)?;
    }
    if let Some(path) = weights_file {
        // lc0 weights
        set("WeightsFile", path.to_string(), session, &mut sent)?;
    }
    if session.info.has_option("UCI_LimitStrength") {
        let value = if limit_strength { "true" } else { "false" };
        session.set_option("UCI_LimitStrength", value)?;
        sent.push(("UCI_LimitStrength".into(), value.into()));
    }
    if limit_strength && session.info.has_option("UCI_Elo") {
        session.set_option("UCI_Elo", &elo.to_string())?;
        sent.push(("UCI_Elo".into(), elo.to_string()));
    }
    if let Some(pv) = multipv {
        set("MultiPV", pv.to_string(), session, &mut sent)?;
    }
    Ok(sent)
}

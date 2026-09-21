//! Update-channel policy compiled into every build.
//!
//! Stable installs (`X.Y.Z`) only accept stable payloads and the GitHub
//! `/releases/latest/download/latest.json` feed. Beta installs
//! (`X.Y.Z-testing.N`) only accept beta payloads and the permanent
//! `channel-testing` feed. The two populations never see each other.

use serde::{Deserialize, Serialize};

pub const BETA_POINTER_TAG: &str = "channel-testing";
pub const DEFAULT_REPO: &str = "MusicMaster4/Nevaska";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Stable,
    Testing,
}

impl Channel {
    pub fn as_str(self) -> &'static str {
        match self {
            Channel::Stable => "stable",
            Channel::Testing => "testing",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Channel::Stable => "stable",
            Channel::Testing => "beta",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Version {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
    pub channel: Channel,
    pub iteration: u32,
}

pub fn parse_version(input: &str) -> Option<Version> {
    let raw = input.trim().strip_prefix('v').unwrap_or(input.trim());
    let (base, iteration, channel) = if let Some((base, rest)) = raw.split_once("-testing.") {
        let n: u32 = rest.parse().ok()?;
        (base, n, Channel::Testing)
    } else {
        (raw, 0, Channel::Stable)
    };
    let mut parts = base.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(Version {
        major,
        minor,
        patch,
        channel,
        iteration,
    })
}

pub fn channel_of(version: &str) -> Channel {
    parse_version(version)
        .map(|v| v.channel)
        .unwrap_or(Channel::Stable)
}

pub fn endpoint_for(channel: Channel, repo: &str) -> String {
    match channel {
        Channel::Testing => {
            format!("https://github.com/{repo}/releases/download/{BETA_POINTER_TAG}/latest.json")
        }
        Channel::Stable => {
            format!("https://github.com/{repo}/releases/latest/download/latest.json")
        }
    }
}

pub fn endpoint_matches_channel(endpoint: &str, channel: Channel) -> bool {
    match channel {
        Channel::Stable => {
            endpoint.contains("/releases/latest/download/latest.json")
                && !endpoint.contains(BETA_POINTER_TAG)
        }
        Channel::Testing => endpoint.contains(&format!(
            "/releases/download/{BETA_POINTER_TAG}/latest.json"
        )),
    }
}

pub fn compare_versions(a: Version, b: Version) -> i32 {
    if a.major != b.major {
        return a.major as i32 - b.major as i32;
    }
    if a.minor != b.minor {
        return a.minor as i32 - b.minor as i32;
    }
    if a.patch != b.patch {
        return a.patch as i32 - b.patch as i32;
    }
    if a.channel != b.channel {
        return if a.channel == Channel::Stable { 1 } else { -1 };
    }
    a.iteration as i32 - b.iteration as i32
}

/// True when `candidate` is an update the running build should install.
pub fn accept_update(running_version: &str, candidate_version: &str) -> bool {
    let current = match parse_version(running_version) {
        Some(v) => v,
        None => return false,
    };
    let candidate = match parse_version(candidate_version) {
        Some(v) => v,
        None => return false,
    };
    if current.channel != candidate.channel {
        return false;
    }
    compare_versions(candidate, current) > 0
}

/// Full payload check: version channel plus the feed URL the build was pointed at.
pub fn accept_payload(
    running_version: &str,
    payload_version: &str,
    running_endpoint: &str,
    payload_endpoint: &str,
) -> bool {
    let channel = channel_of(running_version);
    endpoint_matches_channel(running_endpoint, channel)
        && endpoint_matches_channel(payload_endpoint, channel)
        && accept_update(running_version, payload_version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_feed_is_github_latest() {
        let url = endpoint_for(Channel::Stable, "nevaska/nevaska");
        assert_eq!(
            url,
            "https://github.com/nevaska/nevaska/releases/latest/download/latest.json"
        );
        assert!(endpoint_matches_channel(&url, Channel::Stable));
        assert!(!endpoint_matches_channel(&url, Channel::Testing));
    }

    #[test]
    fn beta_feed_is_channel_testing() {
        let url = endpoint_for(Channel::Testing, "nevaska/nevaska");
        assert_eq!(
            url,
            "https://github.com/nevaska/nevaska/releases/download/channel-testing/latest.json"
        );
        assert!(endpoint_matches_channel(&url, Channel::Testing));
        assert!(!endpoint_matches_channel(&url, Channel::Stable));
    }

    #[test]
    fn stable_refuses_beta_payload() {
        let stable_ep = endpoint_for(Channel::Stable, "nevaska/nevaska");
        let beta_ep = endpoint_for(Channel::Testing, "nevaska/nevaska");
        assert!(!accept_update("1.0.0", "1.0.1-testing.1"));
        assert!(!accept_payload("1.0.0", "1.0.1-testing.1", &stable_ep, &beta_ep));
        assert!(!accept_payload("1.0.0", "1.0.1", &stable_ep, &beta_ep));
    }

    #[test]
    fn beta_refuses_stable_payload() {
        let stable_ep = endpoint_for(Channel::Stable, "nevaska/nevaska");
        let beta_ep = endpoint_for(Channel::Testing, "nevaska/nevaska");
        assert!(!accept_update("1.0.1-testing.1", "1.0.1"));
        assert!(!accept_payload(
            "1.0.1-testing.1",
            "1.0.1",
            &beta_ep,
            &stable_ep
        ));
    }

    #[test]
    fn same_channel_newer_version_is_accepted() {
        let stable_ep = endpoint_for(Channel::Stable, "nevaska/nevaska");
        let beta_ep = endpoint_for(Channel::Testing, "nevaska/nevaska");
        assert!(accept_update("1.0.0", "1.0.1"));
        assert!(accept_payload("1.0.0", "1.0.1", &stable_ep, &stable_ep));
        assert!(accept_update("1.0.1-testing.1", "1.0.1-testing.2"));
        assert!(accept_payload(
            "1.0.1-testing.1",
            "1.0.1-testing.2",
            &beta_ep,
            &beta_ep
        ));
    }
}

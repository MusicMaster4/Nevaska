//! Gating tests for the shipped update-channel policy.

use nevaska_lib::channel::{
    accept_payload, accept_update, channel_of, endpoint_for, endpoint_matches_channel, Channel,
    BETA_POINTER_TAG,
};

const REPO: &str = "nevaska/nevaska";

#[test]
fn stable_endpoint_is_releases_latest() {
    let url = endpoint_for(Channel::Stable, REPO);
    assert_eq!(
        url,
        "https://github.com/nevaska/nevaska/releases/latest/download/latest.json"
    );
    assert!(endpoint_matches_channel(&url, Channel::Stable));
    assert!(!endpoint_matches_channel(&url, Channel::Testing));
}

#[test]
fn beta_endpoint_is_channel_testing() {
    let url = endpoint_for(Channel::Testing, REPO);
    assert_eq!(
        url,
        format!("https://github.com/{REPO}/releases/download/{BETA_POINTER_TAG}/latest.json")
    );
    assert!(endpoint_matches_channel(&url, Channel::Testing));
    assert!(!endpoint_matches_channel(&url, Channel::Stable));
}

#[test]
fn stable_build_accepts_only_stable() {
    let stable_ep = endpoint_for(Channel::Stable, REPO);
    let beta_ep = endpoint_for(Channel::Testing, REPO);
    assert_eq!(channel_of("1.0.0"), Channel::Stable);
    assert!(accept_update("1.0.0", "1.0.1"));
    assert!(accept_payload("1.0.0", "1.0.1", &stable_ep, &stable_ep));
    assert!(!accept_update("1.0.0", "1.0.1-testing.1"));
    assert!(!accept_payload(
        "1.0.0",
        "1.0.1-testing.1",
        &stable_ep,
        &beta_ep
    ));
    assert!(!accept_payload("1.0.0", "1.0.1", &stable_ep, &beta_ep));
}

#[test]
fn beta_build_accepts_only_beta() {
    let stable_ep = endpoint_for(Channel::Stable, REPO);
    let beta_ep = endpoint_for(Channel::Testing, REPO);
    assert_eq!(channel_of("1.0.1-testing.1"), Channel::Testing);
    assert!(accept_update("1.0.1-testing.1", "1.0.1-testing.2"));
    assert!(accept_payload(
        "1.0.1-testing.1",
        "1.0.1-testing.2",
        &beta_ep,
        &beta_ep
    ));
    assert!(!accept_update("1.0.1-testing.1", "1.0.1"));
    assert!(!accept_payload(
        "1.0.1-testing.1",
        "1.0.1",
        &beta_ep,
        &stable_ep
    ));
    assert!(!accept_payload(
        "1.0.1-testing.1",
        "1.0.1-testing.2",
        &beta_ep,
        &stable_ep
    ));
}

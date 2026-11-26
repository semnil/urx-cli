//! The urx command's Node-API addon over the urx-device transport.

#![deny(unsafe_op_in_unsafe_fn)]

use napi_derive::napi;

// Public so that the items only the exported functions reach stay reachable
// when `cargo test` builds the crate without registering the exports.
pub mod lifecycle;
pub mod records;
pub mod requests;

/// The revision of the interface between this addon and the CLI's
/// JavaScript. The JavaScript side refuses device access when it expects a
/// different one (src/bridge.ts holds its expectation). Both change together
/// whenever an export, a method or a record shape changes.
pub const BRIDGE_REVISION: u32 = 2;

/// What the addon was built from, compared with the JavaScript's embedded
/// expectations before any device access.
#[napi(object)]
pub struct BuildIdentity {
    pub bridge_revision: u32,
    pub common_version: String,
    pub common_commit: String,
}

#[napi]
pub fn build_identity() -> BuildIdentity {
    BuildIdentity {
        bridge_revision: BRIDGE_REVISION,
        common_version: env!("URX_COMMON_VERSION").to_owned(),
        common_commit: env!("URX_COMMON_COMMIT").to_owned(),
    }
}

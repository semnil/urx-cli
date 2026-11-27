//! The lifecycle records the addon returns to JavaScript (K37). Their shape is
//! exactly what urx-device's `validateLifecycle` / `validateDiscovery` accept:
//! `{kind: "success", value}` or `{kind: "failure", failure, cleanup}`, with
//! snake_case cause and phase names and no extra properties.

use napi::bindgen_prelude::{Either, Null};
use napi_derive::napi;
use urx_device_transport::discovery::{DeviceEntry, SystemFirmware};
use urx_device_transport::lifecycle::{Cause, Cleanup, CleanupState, Failure, Phase};

#[napi(string_enum = "snake_case")]
pub enum CauseName {
    ConnectionFailed,
    ConnectionLost,
    DiscoveryTimeout,
    ConnectTimeout,
    DeviceNotFound,
    SendTimeout,
    ResponseTimeout,
    InvalidResponse,
    TeardownTimeout,
    IdentityError,
    DeviceRejected,
    NotConnected,
    PreconditionFailed,
    NotificationOverflow,
    InternalError,
}

impl From<Cause> for CauseName {
    fn from(cause: Cause) -> Self {
        match cause {
            Cause::ConnectionFailed => CauseName::ConnectionFailed,
            Cause::ConnectionLost => CauseName::ConnectionLost,
            Cause::DiscoveryTimeout => CauseName::DiscoveryTimeout,
            Cause::ConnectTimeout => CauseName::ConnectTimeout,
            Cause::DeviceNotFound => CauseName::DeviceNotFound,
            Cause::SendTimeout => CauseName::SendTimeout,
            Cause::ResponseTimeout => CauseName::ResponseTimeout,
            Cause::InvalidResponse => CauseName::InvalidResponse,
            Cause::TeardownTimeout => CauseName::TeardownTimeout,
            Cause::IdentityError => CauseName::IdentityError,
            Cause::DeviceRejected => CauseName::DeviceRejected,
            Cause::NotConnected => CauseName::NotConnected,
            Cause::PreconditionFailed => CauseName::PreconditionFailed,
            Cause::NotificationOverflow => CauseName::NotificationOverflow,
            Cause::InternalError => CauseName::InternalError,
        }
    }
}

#[napi(string_enum = "snake_case")]
pub enum PhaseName {
    Discovery,
    Connect,
    Identity,
    Admission,
    Subscription,
    Teardown,
}

impl From<Phase> for PhaseName {
    fn from(phase: Phase) -> Self {
        match phase {
            Phase::Discovery => PhaseName::Discovery,
            Phase::Connect => PhaseName::Connect,
            Phase::Identity => PhaseName::Identity,
            Phase::Admission => PhaseName::Admission,
            Phase::Subscription => PhaseName::Subscription,
            Phase::Teardown => PhaseName::Teardown,
        }
    }
}

#[napi(string_enum = "snake_case")]
pub enum CleanupStateName {
    Complete,
    ConnectionClosed,
    Incomplete,
}

impl From<CleanupState> for CleanupStateName {
    fn from(state: CleanupState) -> Self {
        match state {
            CleanupState::Complete => CleanupStateName::Complete,
            CleanupState::ConnectionClosed => CleanupStateName::ConnectionClosed,
            CleanupState::Incomplete => CleanupStateName::Incomplete,
        }
    }
}

/// `{kind: "cause", code, phase}` or `{kind: "cancelled", phase}`.
#[napi(discriminant = "kind", discriminant_case = "snake_case")]
pub enum FailureRecord {
    Cause { code: CauseName, phase: PhaseName },
    Cancelled { phase: PhaseName },
}

impl From<Failure> for FailureRecord {
    fn from(failure: Failure) -> Self {
        match failure {
            Failure::Cause { code, phase } => FailureRecord::Cause {
                code: code.into(),
                phase: phase.into(),
            },
            Failure::Cancelled { phase } => FailureRecord::Cancelled {
                phase: phase.into(),
            },
        }
    }
}

/// A cleanup failure is always a cause, never a cancellation (K37).
#[napi(discriminant = "kind", discriminant_case = "snake_case")]
pub enum CleanupFailureRecord {
    Cause { code: CauseName, phase: PhaseName },
}

/// `{state, failure}`, with `failure: null` when cleanup did not fail.
#[napi(object, use_nullable = true)]
pub struct CleanupRecord {
    pub state: CleanupStateName,
    pub failure: Option<CleanupFailureRecord>,
}

impl From<Cleanup> for CleanupRecord {
    fn from(cleanup: Cleanup) -> Self {
        CleanupRecord {
            state: cleanup.state.into(),
            failure: cleanup.failure.map(|failure| match failure {
                Failure::Cause { code, phase } => CleanupFailureRecord::Cause {
                    code: code.into(),
                    phase: phase.into(),
                },
                // The transport records cleanup failures as causes; a
                // cancellation there would be its own internal fault.
                Failure::Cancelled { phase } => CleanupFailureRecord::Cause {
                    code: CauseName::InternalError,
                    phase: phase.into(),
                },
            }),
        }
    }
}

impl CleanupRecord {
    pub fn complete() -> Self {
        Cleanup::COMPLETE.into()
    }
}

/// One discovered unit: `{id, model}`, plus `firmware` (a version or null)
/// when the discovery read metadata. The port stays native.
#[napi(object)]
pub struct DeviceRecord {
    pub id: String,
    pub model: String,
    pub firmware: Option<Either<String, Null>>,
}

impl From<&DeviceEntry> for DeviceRecord {
    fn from(entry: &DeviceEntry) -> Self {
        DeviceRecord {
            id: entry.id.clone(),
            model: entry.model.clone(),
            // Discovery fails an unreadable `firm_list` as invalid_response, so no entry carries one.
            firmware: entry.firmware.as_ref().map(|firmware| match firmware {
                SystemFirmware::Version(version) => Either::A(version.clone()),
                SystemFirmware::Absent | SystemFirmware::Unreadable => Either::B(Null),
            }),
        }
    }
}

/// The outcome of `discover`.
#[napi(discriminant = "kind", discriminant_case = "snake_case")]
pub enum DiscoveryRecord {
    Success {
        value: Vec<DeviceRecord>,
    },
    Failure {
        failure: FailureRecord,
        cleanup: CleanupRecord,
    },
}

/// The outcome of a call whose success carries no value (`close`).
#[napi(discriminant = "kind", discriminant_case = "snake_case")]
pub enum UnitRecord {
    Success {
        value: Null,
    },
    Failure {
        failure: FailureRecord,
        cleanup: CleanupRecord,
    },
}

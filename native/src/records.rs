//! The lifecycle records the addon returns to JavaScript (K37). Their shape is
//! exactly what urx-device's `validateLifecycle` / `validateDiscovery` accept:
//! `{kind: "success", value}` or `{kind: "failure", failure, cleanup}`, with
//! snake_case cause and phase names and no extra properties.

use napi::bindgen_prelude::{Either, Null};
use napi_derive::napi;
use urx_device_transport::discovery::{DeviceEntry, SystemFirmware};
use urx_device_transport::lifecycle::{Cause, Cleanup, CleanupState, Failure, Phase};
use urx_device_transport::request::RequestPhase;

use crate::requests::RequestPhaseName;

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

/// The phase of the request a cause is the failure of, or null where the
/// transport records none; the key is always there.
fn request_name(request: Option<RequestPhase>) -> Either<RequestPhaseName, Null> {
    match request {
        Some(phase) => Either::A(phase.into()),
        None => Either::B(Null),
    }
}

/// `{kind: "cause", code, phase, request}` or `{kind: "cancelled", phase}`;
/// `request` is the phase of the request whose failure the cause is, a
/// subscription call's registration or unregistration, or null.
#[napi(discriminant = "kind", discriminant_case = "snake_case")]
pub enum FailureRecord {
    Cause {
        code: CauseName,
        phase: PhaseName,
        request: Either<RequestPhaseName, Null>,
    },
    Cancelled {
        phase: PhaseName,
    },
}

impl From<Failure> for FailureRecord {
    fn from(failure: Failure) -> Self {
        match failure {
            Failure::Cause {
                code,
                phase,
                request,
            } => FailureRecord::Cause {
                code: code.into(),
                phase: phase.into(),
                request: request_name(request),
            },
            Failure::Cancelled { phase } => FailureRecord::Cancelled {
                phase: phase.into(),
            },
        }
    }
}

/// A cleanup failure is always a cause, never a cancellation (K37), with the
/// phase of the unregistration that failed, or null.
#[napi(discriminant = "kind", discriminant_case = "snake_case")]
pub enum CleanupFailureRecord {
    Cause {
        code: CauseName,
        phase: PhaseName,
        request: Either<RequestPhaseName, Null>,
    },
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
                Failure::Cause {
                    code,
                    phase,
                    request,
                } => CleanupFailureRecord::Cause {
                    code: code.into(),
                    phase: phase.into(),
                    request: request_name(request),
                },
                // The transport records cleanup failures as causes; a
                // cancellation there would be its own internal fault.
                Failure::Cancelled { phase } => CleanupFailureRecord::Cause {
                    code: CauseName::InternalError,
                    phase: phase.into(),
                    request: Either::B(Null),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cause_names_the_phase_of_its_request_or_null() {
        let at = |request| {
            FailureRecord::from(Failure::Cause {
                code: Cause::ConnectionLost,
                phase: Phase::Subscription,
                request,
            })
        };
        assert!(matches!(
            at(Some(RequestPhase::Response)),
            FailureRecord::Cause {
                code: CauseName::ConnectionLost,
                phase: PhaseName::Subscription,
                request: Either::A(RequestPhaseName::Response),
            }
        ));
        assert!(matches!(
            at(None),
            FailureRecord::Cause {
                request: Either::B(Null),
                ..
            }
        ));
    }

    #[test]
    fn a_cleanup_failure_names_the_phase_of_the_unregistration_that_failed() {
        let cleanup = |failure| {
            CleanupRecord::from(Cleanup {
                state: CleanupState::Incomplete,
                failure: Some(failure),
            })
        };
        assert!(matches!(
            cleanup(Failure::Cause {
                code: Cause::DeviceRejected,
                phase: Phase::Subscription,
                request: Some(RequestPhase::Response),
            })
            .failure,
            Some(CleanupFailureRecord::Cause {
                code: CauseName::DeviceRejected,
                request: Either::A(RequestPhaseName::Response),
                ..
            })
        ));
        // A cancellation recorded as a cleanup failure is an internal fault with no request.
        assert!(matches!(
            cleanup(Failure::Cancelled {
                phase: Phase::Subscription
            })
            .failure,
            Some(CleanupFailureRecord::Cause {
                code: CauseName::InternalError,
                request: Either::B(Null),
                ..
            })
        ));
    }
}

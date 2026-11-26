//! Discovery and the connection lifecycle (K37, N2) as JavaScript calls.
//!
//! Each blocking transport call runs as a Node-API async task on the libuv
//! thread pool and settles its Promise with a lifecycle record, never by
//! rejecting. The durations are the CLI's (N2); the transport enforces them.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use napi::bindgen_prelude::{AsyncTask, Either, Null};
use napi::{Env, Task};
use napi_derive::napi;
use urx_device_transport::connection::{self, CloseOutcome, ConnectionOptions};
use urx_device_transport::discovery::{
    self, DeviceEntry, DiscoveryOptions, SystemFirmware, DEVICE_CENTER_LIST_PORT,
};
use urx_device_transport::lifecycle::{self, Cause, Cleanup, CleanupState, Failure, Phase};

use crate::records::{CleanupRecord, DeviceRecord, DiscoveryRecord, FailureRecord, UnitRecord};

/// Whole discovery (N2).
const DISCOVERY_DEADLINE: Duration = Duration::from_secs(10);
/// The selected device's operational connection (N2).
const CONNECT_DEADLINE: Duration = Duration::from_secs(5);
/// Sending one request, and one response once it is sent (N1, N2).
const REQUEST_DEADLINE: Duration = Duration::from_secs(3);
/// Stop and teardown in total (N2).
const TEARDOWN_DEADLINE: Duration = Duration::from_secs(2);

/// The caller-owned control of one discovery and the connection opened from
/// it (K37). Cancelling it stops the discovery or the opening in progress.
/// The ports of the units it discovered stay here, so opening needs neither a
/// global registry nor a second discovery.
#[napi]
pub struct Control {
    inner: lifecycle::Control,
    ports: Arc<Mutex<HashMap<String, u16>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[napi]
impl Control {
    #[napi(constructor)]
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        Control {
            inner: lifecycle::Control::new(),
            ports: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Idempotent: stops the discovery or opening in progress.
    #[napi]
    pub fn cancel(&self) {
        self.inner.cancel();
    }
}

pub struct DiscoverTask {
    control: lifecycle::Control,
    ports: Arc<Mutex<HashMap<String, u16>>>,
    options: DiscoveryOptions,
}

impl Task for DiscoverTask {
    type Output = Result<Vec<DeviceEntry>, Failure>;
    type JsValue = DiscoveryRecord;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let outcome = discovery::discover(&self.options, &self.control);
        if let Ok(entries) = &outcome {
            *lock(&self.ports) = entries
                .iter()
                .map(|entry| (entry.id.clone(), entry.port))
                .collect();
        }
        Ok(outcome)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(match output {
            Ok(entries) => DiscoveryRecord::Success {
                value: entries.iter().map(DeviceRecord::from).collect(),
            },
            Err(failure) => DiscoveryRecord::Failure {
                failure: failure.into(),
                cleanup: CleanupRecord::complete(),
            },
        })
    }
}

/// Lists the online units (D14). `metadata` also reads each one's System
/// firmware. `listPort` is for tests against a local peer; the CLI passes
/// none and Device Center's own list port is used.
#[napi]
pub fn discover(
    control: &Control,
    metadata: bool,
    list_port: Option<u32>,
) -> napi::Result<AsyncTask<DiscoverTask>> {
    let list_port = match list_port {
        None => DEVICE_CENTER_LIST_PORT,
        Some(port) => u16::try_from(port)
            .ok()
            .filter(|&port| port != 0)
            .ok_or_else(|| napi::Error::from_reason("listPort must be a port number"))?,
    };
    Ok(AsyncTask::new(DiscoverTask {
        control: control.inner.clone(),
        ports: Arc::clone(&control.ports),
        options: DiscoveryOptions {
            list_port,
            deadline: DISCOVERY_DEADLINE,
            request_deadline: REQUEST_DEADLINE,
            metadata,
        },
    }))
}

/// One open connection (K31). Closing it is explicit; dropping the JavaScript
/// object is not a close.
#[napi]
pub struct Connection {
    inner: Arc<connection::Connection>,
}

#[napi]
impl Connection {
    /// The System firmware version the opening read, or null when the unit
    /// reports none (D15).
    #[napi(getter)]
    pub fn firmware(&self) -> Either<String, Null> {
        match self.inner.firmware() {
            SystemFirmware::Version(version) => Either::A(version.clone()),
            SystemFirmware::Absent => Either::B(Null),
        }
    }

    /// Closes the connection (K4, N2). Repeated calls join the same close.
    #[napi]
    pub fn close(&self) -> AsyncTask<CloseTask> {
        AsyncTask::new(CloseTask {
            inner: Arc::clone(&self.inner),
        })
    }
}

/// The outcome of `openConnection`.
#[napi(
    discriminant = "kind",
    discriminant_case = "snake_case",
    object_from_js = false
)]
pub enum OpenRecord {
    Success {
        value: Connection,
    },
    Failure {
        failure: FailureRecord,
        cleanup: CleanupRecord,
    },
}

pub struct OpenTask {
    device_id: String,
    control: lifecycle::Control,
    ports: Arc<Mutex<HashMap<String, u16>>>,
}

impl Task for OpenTask {
    type Output = Result<connection::Connection, Failure>;
    type JsValue = OpenRecord;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        // Only a unit this control's discovery found online can be opened.
        let Some(port) = lock(&self.ports).get(&self.device_id).copied() else {
            return Ok(Err(Failure::Cause {
                code: Cause::DeviceNotFound,
                phase: Phase::Connect,
            }));
        };
        let options = ConnectionOptions {
            connect_deadline: CONNECT_DEADLINE,
            handshake_request_deadline: REQUEST_DEADLINE,
            send_deadline: REQUEST_DEADLINE,
            response_deadline: REQUEST_DEADLINE,
        };
        Ok(connection::open(
            port,
            &self.device_id,
            &options,
            &self.control,
        ))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(match output {
            Ok(opened) => OpenRecord::Success {
                value: Connection {
                    inner: Arc::new(opened),
                },
            },
            // A failed open owns nothing afterwards (K37).
            Err(failure) => OpenRecord::Failure {
                failure: failure.into(),
                cleanup: CleanupRecord::complete(),
            },
        })
    }
}

/// Opens the unit `deviceId` that `control`'s discovery found online, and
/// verifies its identity on the operational connection (N2, K4).
#[napi]
pub fn open_connection(device_id: String, control: &Control) -> AsyncTask<OpenTask> {
    AsyncTask::new(OpenTask {
        device_id,
        control: control.inner.clone(),
        ports: Arc::clone(&control.ports),
    })
}

pub struct CloseTask {
    inner: Arc<connection::Connection>,
}

impl Task for CloseTask {
    type Output = CloseOutcome;
    type JsValue = UnitRecord;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        Ok(self.inner.close(TEARDOWN_DEADLINE))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(close_record(output))
    }
}

/// The record of a close (K37): success once every thread finished and the
/// socket closed; otherwise the teardown failure, with the connection closed
/// or its termination unconfirmed.
pub fn close_record(outcome: CloseOutcome) -> UnitRecord {
    let failed = |failure: Failure, state: CleanupState| UnitRecord::Failure {
        failure: failure.into(),
        cleanup: Cleanup {
            state,
            failure: None,
        }
        .into(),
    };
    match outcome {
        CloseOutcome::Closed => UnitRecord::Success { value: Null },
        CloseOutcome::Failed(failure) => failed(failure, CleanupState::ConnectionClosed),
        CloseOutcome::Incomplete(failure) => failed(failure, CleanupState::Incomplete),
        // Only a close called on the connection's own threads starts without
        // finishing; this task runs on the thread pool, never on those.
        CloseOutcome::Started => failed(
            Failure::Cause {
                code: Cause::InternalError,
                phase: Phase::Teardown,
            },
            CleanupState::Incomplete,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::records::{CauseName, CleanupStateName, PhaseName};

    fn teardown(code: Cause) -> Failure {
        Failure::Cause {
            code,
            phase: Phase::Teardown,
        }
    }

    #[test]
    fn a_finished_close_is_a_success() {
        assert!(matches!(
            close_record(CloseOutcome::Closed),
            UnitRecord::Success { .. }
        ));
    }

    #[test]
    fn a_failed_unregistration_reports_its_cause_with_the_connection_closed() {
        let UnitRecord::Failure { failure, cleanup } =
            close_record(CloseOutcome::Failed(teardown(Cause::DeviceRejected)))
        else {
            panic!("a failed close is a failure");
        };
        assert!(matches!(
            failure,
            FailureRecord::Cause {
                code: CauseName::DeviceRejected,
                phase: PhaseName::Teardown
            }
        ));
        assert!(matches!(cleanup.state, CleanupStateName::ConnectionClosed));
        assert!(cleanup.failure.is_none());
    }

    #[test]
    fn an_unfinished_teardown_leaves_termination_unconfirmed() {
        for outcome in [
            CloseOutcome::Incomplete(teardown(Cause::TeardownTimeout)),
            CloseOutcome::Started,
        ] {
            let UnitRecord::Failure { cleanup, .. } = close_record(outcome) else {
                panic!("an unfinished close is a failure");
            };
            assert!(matches!(cleanup.state, CleanupStateName::Incomplete));
        }
    }
}

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
use crate::requests::SharedSlots;
use crate::subscriptions::{Delivery, Handlers};

/// Whole discovery (N2).
const DISCOVERY_DEADLINE: Duration = Duration::from_secs(10);
/// The selected device's operational connection (N2).
const CONNECT_DEADLINE: Duration = Duration::from_secs(5);
/// Sending one request, and one response once it is sent (N1, N2).
const REQUEST_DEADLINE: Duration = Duration::from_secs(3);
/// Stop and teardown in total (N2).
pub const TEARDOWN_DEADLINE: Duration = Duration::from_secs(2);

/// The caller-owned control of one discovery and the connection opened from
/// it (K37). Cancelling it stops the discovery or the opening in progress.
/// The ports of the units it discovered stay here, so opening needs neither a
/// global registry nor a second discovery.
#[napi]
pub struct Control {
    inner: lifecycle::Control,
    ports: Arc<Mutex<HashMap<String, u16>>>,
}

pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
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
        // How a lost link was lost (urx-device 0.2.0's `LinkFailure::lost_link`) is not reported yet; the failure is.
        let outcome =
            discovery::discover(&self.options, &self.control).map_err(|link| link.failure);
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
    pub(crate) inner: Arc<connection::Connection>,
    /// The completion slots of this connection's requests, by ticket.
    pub(crate) slots: SharedSlots,
    /// The last request ticket issued on this connection.
    pub(crate) tickets: std::sync::atomic::AtomicU64,
    /// Hands an undeliverable result's slot to this connection's fatal
    /// thread, which ends the connection; dropping it lets the thread exit.
    pub(crate) fatal: Arc<Mutex<Option<FatalSender>>>,
    /// The notification delivery this connection was opened with.
    pub(crate) delivery: Arc<Delivery>,
}

/// One reason for the fatal thread to end the connection: an undeliverable
/// result's slot, or a notification batch that could not be handed to
/// JavaScript (no slot), and where to report once the connection has ended.
pub struct FatalRequest {
    pub held: Option<urx_device_transport::connection::ResultAdoption>,
    pub done: napi::tokio::sync::oneshot::Sender<bool>,
}

pub type FatalSender = std::sync::mpsc::Sender<FatalRequest>;

/// Starts the thread that ends `connection` for an undeliverable result. It
/// exists from the moment the connection becomes usable, so ending one never
/// depends on starting a thread or queueing work later.
fn start_fatal_thread(connection: Arc<connection::Connection>) -> std::io::Result<FatalSender> {
    let (sender, receiver) = std::sync::mpsc::channel::<FatalRequest>();
    std::thread::Builder::new()
        .name("urx-fatal-close".to_owned())
        .spawn(move || {
            // Waits until a slot arrives or the connection's own close drops
            // the sender.
            let Ok(first) = receiver.recv() else {
                return;
            };
            // The connection closes with the result still held; only then is
            // it released. One end serves every slot handed over by then, and
            // the thread exits: a later slot finds the connection ended.
            connection.close(TEARDOWN_DEADLINE);
            for request in std::iter::once(first).chain(receiver.try_iter()) {
                drop(request.held);
                let _ = request.done.send(true);
            }
        })?;
    Ok(sender)
}

/// An opened connection with its fatal thread already running.
pub struct Opened {
    connection: Arc<connection::Connection>,
}

impl Connection {
    fn new(
        opened: Opened,
        fatal: Arc<Mutex<Option<FatalSender>>>,
        delivery: Arc<Delivery>,
    ) -> Self {
        Connection {
            inner: opened.connection,
            slots: SharedSlots::default(),
            tickets: std::sync::atomic::AtomicU64::new(0),
            fatal,
            delivery,
        }
    }
}

#[napi]
impl Connection {
    /// The System firmware version the opening read, or null when the unit
    /// reports none (D15) or a `firm_list` the version cannot be read from
    /// (urx-device 0.2.0's `SystemFirmware::Unreadable`). No command shows a
    /// connection's firmware yet; the one that does decides how to tell the
    /// two apart.
    #[napi(getter)]
    pub fn firmware(&self) -> Either<String, Null> {
        match self.inner.firmware() {
            SystemFirmware::Version(version) => Either::A(version.clone()),
            SystemFirmware::Absent | SystemFirmware::Unreadable => Either::B(Null),
        }
    }

    /// Closes the connection (K4, N2). Repeated calls join the same close.
    #[napi]
    pub fn close(&self) -> AsyncTask<CloseTask> {
        AsyncTask::new(CloseTask {
            inner: Arc::clone(&self.inner),
            fatal: Arc::clone(&self.fatal),
            delivery: Arc::clone(&self.delivery),
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
    delivery: Arc<Delivery>,
    /// Filled with the fatal thread's sender once the connection is open.
    fatal: Arc<Mutex<Option<FatalSender>>>,
}

impl Task for OpenTask {
    type Output = Result<Opened, (Failure, Cleanup)>;
    type JsValue = OpenRecord;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        // Only a unit this control's discovery found online can be opened.
        let Some(port) = lock(&self.ports).get(&self.device_id).copied() else {
            return Ok(Err((
                Failure::Cause {
                    code: Cause::DeviceNotFound,
                    phase: Phase::Connect,
                },
                Cleanup::COMPLETE,
            )));
        };
        let options = ConnectionOptions {
            connect_deadline: CONNECT_DEADLINE,
            handshake_request_deadline: REQUEST_DEADLINE,
            send_deadline: REQUEST_DEADLINE,
            response_deadline: REQUEST_DEADLINE,
        };
        // The handler is installed before any request can be submitted, so no
        // device command races it (K37).
        let handler = Some(self.delivery.handler());
        let opened =
            match connection::open_with(port, &self.device_id, &options, &self.control, handler) {
                Ok(opened) => Arc::new(opened),
                // A failed open owns nothing afterwards (K37).
                Err(link) => return Ok(Err((link.failure, Cleanup::COMPLETE))),
            };
        match start_fatal_thread(Arc::clone(&opened)) {
            Ok(fatal) => {
                *lock(&self.fatal) = Some(fatal);
                Ok(Ok(Opened { connection: opened }))
            }
            // Without its fatal thread the connection is not usable: it is
            // closed here, so the failed open owns nothing.
            // Its cleanup is what that close established.
            Err(_) => Ok(Err((
                Failure::Cause {
                    code: Cause::InternalError,
                    phase: Phase::Connect,
                },
                closed_cleanup(opened.close(TEARDOWN_DEADLINE)),
            ))),
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(match output {
            Ok(opened) => OpenRecord::Success {
                value: Connection::new(opened, Arc::clone(&self.fatal), Arc::clone(&self.delivery)),
            },
            Err((failure, cleanup)) => {
                // No connection exists to deliver anything.
                self.delivery.release_function();
                OpenRecord::Failure {
                    failure: failure.into(),
                    cleanup: cleanup.into(),
                }
            }
        })
    }
}

/// Opens the unit `deviceId` that `control`'s discovery found online, and
/// verifies its identity on the operational connection (N2, K4). Its
/// notification batches go to `handlers.notifications`.
#[napi(
    ts_args_type = "deviceId: string, control: Control, handlers: { notifications: (batch: unknown) => void }"
)]
pub fn open_connection(
    device_id: String,
    control: &Control,
    handlers: Handlers,
) -> AsyncTask<OpenTask> {
    let fatal = Arc::new(Mutex::new(None));
    AsyncTask::new(OpenTask {
        device_id,
        control: control.inner.clone(),
        ports: Arc::clone(&control.ports),
        delivery: Delivery::new(handlers, Arc::downgrade(&fatal)),
        fatal,
    })
}

pub struct CloseTask {
    inner: Arc<connection::Connection>,
    fatal: Arc<Mutex<Option<FatalSender>>>,
    delivery: Arc<Delivery>,
}

impl Task for CloseTask {
    type Output = CloseOutcome;
    type JsValue = UnitRecord;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let outcome = self.inner.close(TEARDOWN_DEADLINE);
        // Only once the connection has ended is its fatal thread let go, so
        // it exits instead of waiting until the object is collected; until
        // then an undeliverable slot can still be handed to it. Nothing more
        // is delivered either.
        lock(&self.fatal).take();
        self.delivery.release_function();
        Ok(outcome)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(close_record(output))
    }
}

/// The cleanup of a connection a failed call closed: the connection's end,
/// with the teardown failure, if any, or unconfirmed termination.
pub fn closed_cleanup(outcome: CloseOutcome) -> Cleanup {
    let ended = |state, failure| Cleanup { state, failure };
    match outcome {
        CloseOutcome::Closed => ended(CleanupState::ConnectionClosed, None),
        CloseOutcome::Failed(failure) => ended(CleanupState::ConnectionClosed, Some(failure)),
        CloseOutcome::Incomplete(failure) => ended(CleanupState::Incomplete, Some(failure)),
        CloseOutcome::Started => ended(
            CleanupState::Incomplete,
            Some(Failure::Cause {
                code: Cause::InternalError,
                phase: Phase::Teardown,
            }),
        ),
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
    fn a_failed_open_reports_what_closing_its_connection_established() {
        let closed = closed_cleanup(CloseOutcome::Closed);
        assert_eq!(
            (closed.state, closed.failure),
            (CleanupState::ConnectionClosed, None)
        );
        let failed = closed_cleanup(CloseOutcome::Failed(teardown(Cause::DeviceRejected)));
        assert_eq!(
            (failed.state, failed.failure),
            (
                CleanupState::ConnectionClosed,
                Some(teardown(Cause::DeviceRejected))
            )
        );
        let expired = closed_cleanup(CloseOutcome::Incomplete(teardown(Cause::TeardownTimeout)));
        assert_eq!(
            (expired.state, expired.failure),
            (
                CleanupState::Incomplete,
                Some(teardown(Cause::TeardownTimeout))
            )
        );
        assert_eq!(
            closed_cleanup(CloseOutcome::Started).state,
            CleanupState::Incomplete
        );
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

//! Single requests on a connection (K34, K37): numeric, text and name reads,
//! numeric and text writes, their owners and the completion slot each result
//! holds until the CLI adopts it.
//!
//! A request's Promise settles with its K34 record, built from the
//! transport's outcome exactly as it completed; nothing here retries, reads
//! back or changes a value.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::{AsyncTask, Null, PromiseRaw};
use napi::tokio::sync::oneshot;
use napi::{Env, Task};
use napi_derive::napi;
use urx_device_transport::connection::{self, ResultAdoption};
use urx_device_transport::i64_text;
use urx_device_transport::request::{
    Evidence, Outcome, ReadValue, Request, RequestCause, RequestFailure, RequestPhase,
};
use urx_device_transport::wire::{NameValue, ParameterAddress};

use crate::lifecycle::{lock, Connection};

#[napi(string_enum = "snake_case")]
pub enum RequestCauseName {
    InvalidInput,
    PreconditionFailed,
    NotConnected,
    SendTimeout,
    ResponseTimeout,
    TeardownTimeout,
    DeviceRejected,
    InvalidResponse,
    ConnectionLost,
    NotificationOverflow,
    InternalError,
}

impl From<RequestCause> for RequestCauseName {
    fn from(cause: RequestCause) -> Self {
        match cause {
            RequestCause::InvalidInput => RequestCauseName::InvalidInput,
            RequestCause::PreconditionFailed => RequestCauseName::PreconditionFailed,
            RequestCause::NotConnected => RequestCauseName::NotConnected,
            RequestCause::SendTimeout => RequestCauseName::SendTimeout,
            RequestCause::ResponseTimeout => RequestCauseName::ResponseTimeout,
            RequestCause::TeardownTimeout => RequestCauseName::TeardownTimeout,
            RequestCause::DeviceRejected => RequestCauseName::DeviceRejected,
            RequestCause::InvalidResponse => RequestCauseName::InvalidResponse,
            RequestCause::ConnectionLost => RequestCauseName::ConnectionLost,
            RequestCause::NotificationOverflow => RequestCauseName::NotificationOverflow,
            RequestCause::InternalError => RequestCauseName::InternalError,
        }
    }
}

#[napi(string_enum = "snake_case")]
pub enum RequestPhaseName {
    Validation,
    Admission,
    Send,
    Response,
    Delivery,
}

impl From<RequestPhase> for RequestPhaseName {
    fn from(phase: RequestPhase) -> Self {
        match phase {
            RequestPhase::Validation => RequestPhaseName::Validation,
            RequestPhase::Admission => RequestPhaseName::Admission,
            RequestPhase::Send => RequestPhaseName::Send,
            RequestPhase::Response => RequestPhaseName::Response,
            RequestPhase::Delivery => RequestPhaseName::Delivery,
        }
    }
}

/// `{kind: "cause", code, phase}` or `{kind: "cancelled", phase}`.
#[napi(
    discriminant = "kind",
    discriminant_case = "snake_case",
    object_from_js = false
)]
pub enum RequestFailureRecord {
    Cause {
        code: RequestCauseName,
        phase: RequestPhaseName,
    },
    Cancelled {
        phase: RequestPhaseName,
    },
}

impl From<RequestFailure> for RequestFailureRecord {
    fn from(failure: RequestFailure) -> Self {
        match failure {
            RequestFailure::Cause { code, phase } => RequestFailureRecord::Cause {
                code: code.into(),
                phase: phase.into(),
            },
            RequestFailure::Cancelled { phase } => RequestFailureRecord::Cancelled {
                phase: phase.into(),
            },
        }
    }
}

/// `{state: ...}`; a rejection carries its response code as I64Text.
#[napi(
    discriminant = "state",
    discriminant_case = "snake_case",
    object_from_js = false
)]
pub enum EvidenceRecord {
    NotSent,
    Unconfirmed,
    Rejected {
        #[napi(js_name = "responseCode")]
        response_code: String,
    },
    Read,
    Accepted,
}

impl From<Evidence> for EvidenceRecord {
    fn from(evidence: Evidence) -> Self {
        match evidence {
            Evidence::NotSent => EvidenceRecord::NotSent,
            Evidence::Unconfirmed => EvidenceRecord::Unconfirmed,
            Evidence::Rejected(code) => EvidenceRecord::Rejected {
                response_code: i64_text::format(code),
            },
            Evidence::Read => EvidenceRecord::Read,
            Evidence::Accepted => EvidenceRecord::Accepted,
        }
    }
}

/// A name read's raw value: text, or an integer as I64Text (F03-K).
#[napi(
    discriminant = "kind",
    discriminant_case = "snake_case",
    object_from_js = false
)]
pub enum NameValueRecord {
    Text { value: String },
    Integer { value: String },
}

macro_rules! read_record {
    ($name:ident, $value:ty) => {
        #[napi(
            discriminant = "kind",
            discriminant_case = "snake_case",
            object_from_js = false
        )]
        pub enum $name {
            Success {
                value: $value,
                evidence: EvidenceRecord,
            },
            Failure {
                failure: RequestFailureRecord,
                evidence: EvidenceRecord,
            },
        }
    };
}

read_record!(NumericRecord, String);
read_record!(TextRecord, String);
read_record!(NameRecord, NameValueRecord);
read_record!(PostRecord, Null);

/// The record of a value the transport returned in another raw type than the
/// request's: a delivery fault, keeping the evidence it came with.
fn mismatched(evidence: Evidence) -> (RequestFailureRecord, EvidenceRecord) {
    (
        RequestFailure::Cause {
            code: RequestCause::InternalError,
            phase: RequestPhase::Delivery,
        }
        .into(),
        evidence.into(),
    )
}

macro_rules! from_outcome {
    ($name:ident, $pattern:pat => $value:expr) => {
        impl From<Outcome> for $name {
            fn from(outcome: Outcome) -> Self {
                match outcome {
                    Outcome::Success { value, evidence } => match value {
                        $pattern => $name::Success {
                            value: $value,
                            evidence: evidence.into(),
                        },
                        #[allow(unreachable_patterns)]
                        _ => {
                            let (failure, evidence) = mismatched(evidence);
                            $name::Failure { failure, evidence }
                        }
                    },
                    Outcome::Failure { failure, evidence } => $name::Failure {
                        failure: failure.into(),
                        evidence: evidence.into(),
                    },
                }
            }
        }
    };
}

from_outcome!(NumericRecord, Some(ReadValue::Numeric(n)) => i64_text::format(n));
from_outcome!(TextRecord, Some(ReadValue::Text(text)) => text);
from_outcome!(NameRecord, Some(ReadValue::Name(name)) => match name {
    NameValue::Text(value) => NameValueRecord::Text { value },
    NameValue::Integer(value) => NameValueRecord::Integer { value: i64_text::format(value) },
});
from_outcome!(PostRecord, None => Null);

/// A refusal decided here, before anything is handed to the transport.
fn refused(code: RequestCause, phase: RequestPhase) -> Outcome {
    Outcome::Failure {
        failure: RequestFailure::Cause { code, phase },
        evidence: Evidence::NotSent,
    }
}

/// The owner of one logical operation's requests (K37). `finish` releases it;
/// a finished or refused owner submits nothing.
#[napi]
pub struct Operation {
    inner: Mutex<Option<Arc<connection::Operation>>>,
}

#[napi]
impl Operation {
    /// Idempotent: stops this owner's unsent requests; sent ones settle
    /// under their deadlines.
    #[napi]
    pub fn cancel(&self) {
        if let Some(operation) = lock(&self.inner).as_ref() {
            operation.cancel();
        }
    }

    /// Releases the owner once its requests are consumed; no device I/O.
    #[napi]
    pub fn finish(&self) {
        lock(&self.inner).take();
    }
}

/// Each submitted request's completion slot, by the CLI's request ticket:
/// pending until its outcome arrives, then held until adopted. A held `None`
/// is an outcome that keeps no slot (refused, unsent or ended).
#[derive(Default)]
pub struct Slots {
    pending: HashSet<String>,
    held: HashMap<String, Option<ResultAdoption>>,
}

impl Slots {
    fn reserve(&mut self, ticket: &str) -> bool {
        !self.held.contains_key(ticket) && self.pending.insert(ticket.to_owned())
    }

    fn complete(&mut self, ticket: &str, adoption: Option<ResultAdoption>) {
        self.pending.remove(ticket);
        self.held.insert(ticket.to_owned(), adoption);
    }
}

pub type SharedSlots = Arc<Mutex<Slots>>;

/// The parameter address of a call, or a validation refusal.
fn address(param_id: u32, x: &str, y: &str) -> Result<ParameterAddress, Outcome> {
    match (i64_text::parse(x), i64_text::parse(y)) {
        (Ok(x), Ok(y)) => Ok(ParameterAddress { param_id, x, y }),
        _ => Err(refused(
            RequestCause::InvalidInput,
            RequestPhase::Validation,
        )),
    }
}

impl Connection {
    /// Submits `request` under `ticket` and returns its outcome's Promise.
    fn issue<'env, R>(
        &self,
        env: &'env Env,
        operation: &Operation,
        ticket: String,
        request: Result<Request, Outcome>,
    ) -> napi::Result<PromiseRaw<'env, R>>
    where
        R: From<Outcome> + napi::bindgen_prelude::ToNapiValue + Send + 'static,
    {
        let (tx, rx) = oneshot::channel::<Outcome>();
        let slots = Arc::clone(&self.slots);
        // An outcome decided here, before anything reaches the transport, and
        // whether its ticket keeps an (empty) slot to adopt.
        let early = if !lock(&slots).reserve(&ticket) {
            // A ticket already in use owns another call's slot: refuse
            // without touching it.
            Some((
                refused(RequestCause::InternalError, RequestPhase::Admission),
                false,
            ))
        } else {
            match (request, lock(&operation.inner).clone()) {
                (Err(outcome), _) => Some((outcome, true)),
                // A finished owner, or one the closing connection refused.
                (Ok(_), None) => Some((
                    refused(RequestCause::NotConnected, RequestPhase::Admission),
                    true,
                )),
                (Ok(request), Some(owner)) => {
                    let completed = Arc::clone(&slots);
                    let ticket = ticket.clone();
                    self.inner
                        .submit(&owner, request, move |outcome, adoption| {
                            // The slot is recorded before the Promise settles, so
                            // the CLI can adopt it as soon as it sees the record.
                            lock(&completed).complete(&ticket, Some(adoption));
                            let _ = tx.send(outcome);
                        });
                    None
                }
            }
        };
        let rx = match early {
            None => rx,
            Some((outcome, keep)) => {
                if keep {
                    lock(&slots).complete(&ticket, None);
                }
                let (tx, rx) = oneshot::channel::<Outcome>();
                let _ = tx.send(outcome);
                rx
            }
        };
        env.spawn_future(async move {
            let outcome = rx
                .await
                .map_err(|_| napi::Error::from_reason("the request ended without an outcome"))?;
            Ok(R::from(outcome))
        })
    }
}

#[napi]
impl Connection {
    /// A new owner for one logical operation; refused on a closing or ended
    /// connection, in which case every request it submits is refused unsent.
    #[napi]
    pub fn create_operation(&self) -> Operation {
        Operation {
            inner: Mutex::new(self.inner.create_operation().ok().map(Arc::new)),
        }
    }

    #[napi(ts_return_type = "Promise<unknown>")]
    pub fn get_numeric<'env>(
        &self,
        env: &'env Env,
        operation: &Operation,
        ticket: String,
        param_id: u32,
        x: String,
        y: String,
    ) -> napi::Result<PromiseRaw<'env, NumericRecord>> {
        let request = address(param_id, &x, &y).map(Request::GetNumeric);
        self.issue(env, operation, ticket, request)
    }

    #[napi(ts_return_type = "Promise<unknown>")]
    pub fn get_text<'env>(
        &self,
        env: &'env Env,
        operation: &Operation,
        ticket: String,
        param_id: u32,
        x: String,
        y: String,
    ) -> napi::Result<PromiseRaw<'env, TextRecord>> {
        let request = address(param_id, &x, &y).map(Request::GetText);
        self.issue(env, operation, ticket, request)
    }

    #[napi(ts_return_type = "Promise<unknown>")]
    pub fn get_name<'env>(
        &self,
        env: &'env Env,
        operation: &Operation,
        ticket: String,
        param_id: u32,
        x: String,
        y: String,
    ) -> napi::Result<PromiseRaw<'env, NameRecord>> {
        let request = address(param_id, &x, &y).map(Request::GetName);
        self.issue(env, operation, ticket, request)
    }

    #[allow(clippy::too_many_arguments)]
    #[napi(ts_return_type = "Promise<unknown>")]
    pub fn set_numeric<'env>(
        &self,
        env: &'env Env,
        operation: &Operation,
        ticket: String,
        param_id: u32,
        x: String,
        y: String,
        value: String,
    ) -> napi::Result<PromiseRaw<'env, PostRecord>> {
        let request = address(param_id, &x, &y).and_then(|address| {
            i64_text::parse(&value)
                .map(|value| Request::SetNumeric(address, value))
                .map_err(|_| refused(RequestCause::InvalidInput, RequestPhase::Validation))
        });
        self.issue(env, operation, ticket, request)
    }

    #[allow(clippy::too_many_arguments)]
    #[napi(ts_return_type = "Promise<unknown>")]
    pub fn set_text<'env>(
        &self,
        env: &'env Env,
        operation: &Operation,
        ticket: String,
        param_id: u32,
        x: String,
        y: String,
        value: String,
    ) -> napi::Result<PromiseRaw<'env, PostRecord>> {
        let request = address(param_id, &x, &y).map(|address| Request::SetText(address, value));
        self.issue(env, operation, ticket, request)
    }

    /// Releases the completion slot of `ticket`'s result once the CLI has
    /// validated it; no device I/O. True for any completed result: one that
    /// held no slot (refused, unsent, expired or ended) has nothing to
    /// release, which the transport's `adopt` reports as false. False only
    /// for a ticket with no completed result, or one already adopted,
    /// reported or ended.
    #[napi]
    pub fn adopt_result(&self, ticket: String) -> bool {
        let taken = lock(&self.slots).held.remove(&ticket);
        match taken {
            None => false,
            Some(None) => true,
            Some(Some(adoption)) => {
                adoption.adopt();
                true
            }
        }
    }

    /// The CLI could not adopt `ticket`'s result. Its fatal rule ends the
    /// connection when the result still holds a slot, since an unadopted slot
    /// would stop every later request. Resolves false for an unknown ticket.
    #[napi]
    pub fn fail_delivery(&self, ticket: String) -> AsyncTask<FatalTask> {
        self.fatal(ticket, false)
    }

    /// Ends the connection if, and only if, `ticket` still owns an unreleased
    /// slot; resolves true otherwise as well.
    #[napi]
    pub fn terminate(&self, ticket: String) -> AsyncTask<FatalTask> {
        self.fatal(ticket, true)
    }
}

impl Connection {
    fn fatal(&self, ticket: String, unknown_is_done: bool) -> AsyncTask<FatalTask> {
        let taken = lock(&self.slots).held.remove(&ticket);
        let (close, answer) = match taken {
            None => (false, unknown_is_done),
            Some(None) => (false, true),
            Some(Some(_held)) => (true, true),
        };
        AsyncTask::new(FatalTask {
            connection: close.then(|| self.handle()),
            answer,
        })
    }
}

/// Ends a connection for a result that could not be adopted (K6, K37).
pub struct FatalTask {
    connection: Option<Arc<connection::Connection>>,
    answer: bool,
}

impl Task for FatalTask {
    type Output = bool;
    type JsValue = bool;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        if let Some(connection) = &self.connection {
            connection.close(crate::lifecycle::TEARDOWN_DEADLINE);
        }
        Ok(self.answer)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record_state(evidence: EvidenceRecord) -> &'static str {
        match evidence {
            EvidenceRecord::NotSent => "not_sent",
            EvidenceRecord::Unconfirmed => "unconfirmed",
            EvidenceRecord::Rejected { .. } => "rejected",
            EvidenceRecord::Read => "read",
            EvidenceRecord::Accepted => "accepted",
        }
    }

    #[test]
    fn a_read_keeps_its_value_as_canonical_text_and_its_evidence() {
        let record = NumericRecord::from(Outcome::Success {
            value: Some(ReadValue::Numeric(i64::MIN)),
            evidence: Evidence::Read,
        });
        let NumericRecord::Success { value, evidence } = record else {
            panic!("a read success stays a success");
        };
        assert_eq!(value, "-9223372036854775808");
        assert_eq!(record_state(evidence), "read");
    }

    #[test]
    fn a_value_of_another_raw_type_is_a_delivery_fault_keeping_its_evidence() {
        let record = NumericRecord::from(Outcome::Success {
            value: Some(ReadValue::Text("1".to_owned())),
            evidence: Evidence::Read,
        });
        let NumericRecord::Failure { failure, evidence } = record else {
            panic!("a mismatched value is not a success");
        };
        assert!(matches!(
            failure,
            RequestFailureRecord::Cause {
                code: RequestCauseName::InternalError,
                phase: RequestPhaseName::Delivery
            }
        ));
        assert_eq!(record_state(evidence), "read");
    }

    #[test]
    fn a_rejection_keeps_its_response_code() {
        let record = PostRecord::from(Outcome::Failure {
            failure: RequestFailure::Cause {
                code: RequestCause::DeviceRejected,
                phase: RequestPhase::Response,
            },
            evidence: Evidence::Rejected(403),
        });
        let PostRecord::Failure {
            evidence: EvidenceRecord::Rejected { response_code },
            ..
        } = record
        else {
            panic!("a rejection keeps its evidence");
        };
        assert_eq!(response_code, "403");
    }

    #[test]
    fn a_ticket_is_reserved_once_and_held_after_completing() {
        let mut slots = Slots::default();
        assert!(slots.reserve("a"));
        assert!(!slots.reserve("a"));
        slots.complete("a", None);
        assert!(!slots.reserve("a"));
        assert!(slots.held.contains_key("a"));
        assert!(!slots.pending.contains("a"));
    }

    #[test]
    fn an_address_needs_canonical_coordinates() {
        assert!(address(140, "0", "-1").is_ok());
        for (x, y) in [
            ("00", "0"),
            ("0", "+1"),
            ("0", "1.0"),
            ("", "0"),
            ("9223372036854775808", "0"),
        ] {
            assert!(address(140, x, y).is_err(), "{x}:{y}");
        }
    }
}

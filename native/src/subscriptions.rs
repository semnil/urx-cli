//! Subscriptions and notification delivery (K8–K12, K37).
//!
//! The transport delivers one notification batch at a time and forms the next
//! only after the application adopts it (K6). Each batch goes to JavaScript
//! through one thread-safe function whose queue holds one batch; the CLI
//! routes the records to its subscriptions and acknowledges the batch with
//! `adoptNotifications`. A batch that cannot be handed to JavaScript ends the
//! connection, since its records could never be adopted.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

use napi::bindgen_prelude::{Null, PromiseRaw};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::tokio::sync::oneshot;
use napi::{Env, Status};
use napi_derive::napi;
use urx_device_transport::connection;
use urx_device_transport::delivery::{BatchTicket, NotificationBatch};
use urx_device_transport::i64_text;
use urx_device_transport::lifecycle::{Cause, Cleanup, Failure, LifecycleFailure, Phase};
use urx_device_transport::subscription::{SubscriptionAddress, TokenId};
use urx_device_transport::wire::{MeterAddress, Notification, ParameterAddress};

use crate::lifecycle::{lock, Connection, FatalRequest, FatalSender};
use crate::records::{CleanupRecord, FailureRecord, UnitRecord};
use crate::requests::Operation;

/// One notification as JavaScript receives it (K37).
#[napi(
    discriminant = "kind",
    discriminant_case = "snake_case",
    object_from_js = false
)]
pub enum PayloadRecord {
    Numeric {
        #[napi(js_name = "paramId")]
        param_id: u32,
        x: String,
        y: String,
        value: String,
    },
    Text {
        #[napi(js_name = "paramId")]
        param_id: u32,
        x: String,
        y: String,
        value: String,
    },
    Meter {
        #[napi(js_name = "meterId")]
        meter_id: u32,
        x: String,
        value: String,
    },
    BulkChange,
}

impl From<&Notification> for PayloadRecord {
    fn from(notification: &Notification) -> Self {
        match notification {
            Notification::Numeric { address, value } => PayloadRecord::Numeric {
                param_id: address.param_id,
                x: i64_text::format(address.x),
                y: i64_text::format(address.y),
                value: i64_text::format(*value),
            },
            Notification::Text { address, value } => PayloadRecord::Text {
                param_id: address.param_id,
                x: i64_text::format(address.x),
                y: i64_text::format(address.y),
                value: value.clone(),
            },
            Notification::Meter { address, value } => PayloadRecord::Meter {
                meter_id: address.meter_id,
                x: i64_text::format(address.x),
                value: i64_text::format(*value),
            },
            Notification::BulkChange => PayloadRecord::BulkChange,
        }
    }
}

#[napi(object, object_from_js = false)]
pub struct NotificationRecordJs {
    /// The tokens of the subscriptions this record is for.
    pub recipients: Vec<String>,
    /// PC receipt time, milliseconds since the Unix epoch, as I64Text.
    pub received_at_ms: String,
    pub payload: PayloadRecord,
}

/// One batch (K37): its connection generation as I64Text, its opaque ticket
/// and its records in receive order.
#[napi(object, object_from_js = false)]
pub struct BatchRecord {
    pub generation: String,
    pub batch_ticket: String,
    pub records: Vec<NotificationRecordJs>,
}

/// The JavaScript function that receives each batch: one argument and no
/// error channel, so it must not throw. Its queue holds one batch, which is
/// all the transport delivers before an acknowledgment (K6). It is weak: an
/// open connection does not by itself keep Node running.
pub type BatchFunction = ThreadsafeFunction<BatchRecord, (), BatchRecord, Status, false, true, 1>;

/// The handlers a connection is opened with (K37). The transport delivers no
/// terminal event, so `notifications` is the only handler.
#[napi(object, object_to_js = false)]
pub struct Handlers {
    pub notifications: BatchFunction,
}

/// The delivery state a connection shares with its notification handler.
pub struct Delivery {
    /// Released once the connection has closed.
    pub(crate) function: Mutex<Option<Arc<BatchFunction>>>,
    /// The CLI's name for each admitted token; a name is never reused.
    tokens: Mutex<HashMap<TokenId, String>>,
    /// The batches delivered and not yet acknowledged, by ticket.
    batches: Mutex<HashMap<String, BatchTicket>>,
    next_batch: AtomicU64,
    next_token: AtomicU64,
    /// The connection's fatal thread, once it runs. Weak, so this handler,
    /// which the transport connection holds, does not keep that thread alive.
    fatal: Weak<Mutex<Option<FatalSender>>>,
}

impl Delivery {
    pub fn new(handlers: Handlers, fatal: Weak<Mutex<Option<FatalSender>>>) -> Arc<Self> {
        Arc::new(Delivery {
            function: Mutex::new(Some(Arc::new(handlers.notifications))),
            tokens: Mutex::default(),
            batches: Mutex::default(),
            next_batch: AtomicU64::new(0),
            next_token: AtomicU64::new(0),
            fatal,
        })
    }

    /// Lets go of the JavaScript function once nothing more can be delivered.
    pub fn release_function(&self) {
        lock(&self.function).take();
    }

    /// The handler the transport calls on its delivery thread.
    pub fn handler(self: &Arc<Self>) -> connection::NotificationHandler {
        let delivery = Arc::clone(self);
        Arc::new(move |batch: NotificationBatch| delivery.deliver(batch))
    }

    fn deliver(&self, batch: NotificationBatch) {
        let id = format!(
            "batch-{}",
            self.next_batch.fetch_add(1, Ordering::Relaxed) + 1
        );
        lock(&self.batches).insert(id.clone(), batch.ticket);
        let record = {
            let tokens = lock(&self.tokens);
            BatchRecord {
                generation: batch.generation.to_string(),
                batch_ticket: id.clone(),
                // A token whose release has completed has no consumer left:
                // it is left out, and so is a record left with no recipient.
                // The batch's acknowledgment still covers them.
                records: batch
                    .records
                    .iter()
                    .filter_map(|record| {
                        let recipients: Vec<String> = record
                            .recipients
                            .iter()
                            .filter_map(|token| tokens.get(token).cloned())
                            .collect();
                        (!recipients.is_empty()).then(|| NotificationRecordJs {
                            recipients,
                            received_at_ms: i64_text::format(record.received_at_ms),
                            payload: (&record.payload).into(),
                        })
                    })
                    .collect(),
            }
        };
        let function = lock(&self.function).clone();
        let status = match function {
            Some(function) => function.call(record, ThreadsafeFunctionCallMode::Blocking),
            None => Status::Closing,
        };
        if status != Status::Ok {
            // The batch can never be adopted, and the transport forms no
            // other until it is: the connection ends.
            lock(&self.batches).remove(&id);
            if let Some(slot) = self.fatal.upgrade() {
                if let Some(fatal) = lock(&slot).as_ref() {
                    let (done, _) = oneshot::channel();
                    let _ = fatal.send(FatalRequest { held: None, done });
                }
            }
        }
    }
}

/// A subscription address as JavaScript passes it (K37).
#[napi(
    discriminant = "family",
    discriminant_case = "snake_case",
    object_to_js = false
)]
pub enum SubscriptionAddressRecord {
    Parameter {
        #[napi(js_name = "paramId")]
        param_id: f64,
        x: String,
        y: String,
    },
    Meter {
        #[napi(js_name = "meterId")]
        meter_id: f64,
        x: String,
    },
}

fn id_of(value: f64) -> Option<u32> {
    (value.is_finite() && value.fract() == 0.0 && (0.0..=f64::from(u32::MAX)).contains(&value))
        .then_some(value as u32)
}

fn address_of(record: &SubscriptionAddressRecord) -> Option<SubscriptionAddress> {
    match record {
        SubscriptionAddressRecord::Parameter { param_id, x, y } => {
            Some(SubscriptionAddress::Parameter(ParameterAddress {
                param_id: id_of(*param_id)?,
                x: i64_text::parse(x).ok()?,
                y: i64_text::parse(y).ok()?,
            }))
        }
        SubscriptionAddressRecord::Meter { meter_id, x } => {
            Some(SubscriptionAddress::Meter(MeterAddress {
                meter_id: id_of(*meter_id)?,
                x: i64_text::parse(x).ok()?,
            }))
        }
    }
}

fn unit_record(outcome: Result<(), LifecycleFailure>) -> UnitRecord {
    match outcome {
        Ok(()) => UnitRecord::Success { value: Null },
        Err(failure) => UnitRecord::Failure {
            failure: failure.failure.into(),
            cleanup: failure.cleanup.into(),
        },
    }
}

/// One admitted subscription (K11). Releasing it is explicit; dropping the
/// JavaScript object leaves the token admitted until the connection closes.
#[napi]
pub struct Subscription {
    inner: connection::Subscription,
    token: String,
    delivery: Arc<Delivery>,
}

#[napi]
impl Subscription {
    /// The token the batches' records name as their recipient.
    #[napi(getter)]
    pub fn token(&self) -> String {
        self.token.clone()
    }

    /// Registers every address in order (K9); settles with the lifecycle
    /// record once all are accepted, or after the owned cleanup (K10).
    #[napi(ts_return_type = "Promise<unknown>")]
    pub fn activate<'env>(
        &self,
        env: &'env Env,
        operation: &Operation,
    ) -> napi::Result<PromiseRaw<'env, UnitRecord>> {
        let (tx, rx) = oneshot::channel::<Result<(), LifecycleFailure>>();
        let promise = env.spawn_future(async move {
            let outcome = rx
                .await
                .map_err(|_| napi::Error::from_reason("the activation ended without an outcome"))?;
            Ok(unit_record(outcome))
        })?;
        match operation.owner() {
            Some(owner) => self.inner.activate(&owner, move |outcome| {
                let _ = tx.send(outcome);
            }),
            // A finished owner, or one the closing connection refused: nothing
            // is sent, and the attempt owned nothing.
            None => {
                let _ = tx.send(Err(LifecycleFailure {
                    failure: Failure::Cause {
                        code: Cause::NotConnected,
                        phase: Phase::Subscription,
                    },
                    cleanup: Cleanup::COMPLETE,
                }));
            }
        }
        Ok(promise)
    }

    /// Releases the subscription (K10); repeated calls join one completion.
    #[napi(ts_return_type = "Promise<unknown>")]
    pub fn release<'env>(&self, env: &'env Env) -> napi::Result<PromiseRaw<'env, UnitRecord>> {
        let (tx, rx) = oneshot::channel::<Result<(), LifecycleFailure>>();
        let promise = env.spawn_future(async move {
            let outcome = rx
                .await
                .map_err(|_| napi::Error::from_reason("the release ended without an outcome"))?;
            Ok(unit_record(outcome))
        })?;
        // Once the release has completed, the token's name is reclaimed:
        // the token receives nothing more.
        let delivery = Arc::clone(&self.delivery);
        let token = self.inner.token();
        self.inner.release(move |outcome| {
            lock(&delivery.tokens).remove(&token);
            let _ = tx.send(outcome);
        });
        Ok(promise)
    }
}

/// The outcome of `prepareSubscription`.
#[napi(
    discriminant = "kind",
    discriminant_case = "snake_case",
    object_from_js = false
)]
pub enum PrepareRecord {
    Success {
        value: Subscription,
    },
    Failure {
        failure: FailureRecord,
        cleanup: CleanupRecord,
    },
}

#[napi]
impl Connection {
    /// Admits a subscription to `addresses` (K11), with no traffic yet.
    #[napi]
    pub fn prepare_subscription(&self, addresses: Vec<SubscriptionAddressRecord>) -> PrepareRecord {
        let refused = |code| PrepareRecord::Failure {
            failure: Failure::Cause {
                code,
                phase: Phase::Admission,
            }
            .into(),
            cleanup: CleanupRecord::complete(),
        };
        // The adapter validates addresses before they reach here.
        let Some(addresses) = addresses.iter().map(address_of).collect::<Option<Vec<_>>>() else {
            return refused(Cause::InternalError);
        };
        // The token receives notifications from its admission, so it is
        // named while the delivery handler cannot read the names.
        let mut tokens = lock(&self.delivery.tokens);
        match self.inner.prepare_subscription(&addresses) {
            Ok(subscription) => {
                let next = self.delivery.next_token.fetch_add(1, Ordering::Relaxed) + 1;
                let token = format!("token-{next}");
                tokens.insert(subscription.token(), token.clone());
                PrepareRecord::Success {
                    value: Subscription {
                        inner: subscription,
                        token,
                        delivery: Arc::clone(&self.delivery),
                    },
                }
            }
            Err(failure) => PrepareRecord::Failure {
                failure: failure.failure.into(),
                cleanup: failure.cleanup.into(),
            },
        }
    }

    /// Acknowledges a delivered batch once its records are adopted (K6, K12);
    /// no device I/O. False for a ticket this connection did not deliver or
    /// already acknowledged.
    #[napi]
    pub fn adopt_notifications(&self, batch_ticket: String) -> bool {
        let ticket = lock(&self.delivery.batches).remove(&batch_ticket);
        ticket.is_some_and(|ticket| self.inner.adopt_notifications(ticket))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_identifier_is_an_integral_u32_and_nothing_is_converted_into_one() {
        assert_eq!(id_of(0.0), Some(0));
        assert_eq!(id_of(f64::from(u32::MAX)), Some(u32::MAX));
        for value in [
            -1.0,
            0.5,
            f64::from(u32::MAX) + 1.0,
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
        ] {
            assert_eq!(id_of(value), None, "{value}");
        }
    }

    #[test]
    fn an_address_needs_canonical_coordinates() {
        let parameter = SubscriptionAddressRecord::Parameter {
            param_id: 895.0,
            x: "0".into(),
            y: "-9223372036854775808".into(),
        };
        assert_eq!(
            address_of(&parameter),
            Some(SubscriptionAddress::Parameter(ParameterAddress {
                param_id: 895,
                x: 0,
                y: i64::MIN,
            }))
        );
        let meter = SubscriptionAddressRecord::Meter {
            meter_id: 7.0,
            x: "-1".into(),
        };
        assert_eq!(
            address_of(&meter),
            Some(SubscriptionAddress::Meter(MeterAddress {
                meter_id: 7,
                x: -1
            }))
        );
        for x in ["01", "-0", "+1", "1.0", "", "9223372036854775808"] {
            let invalid = SubscriptionAddressRecord::Meter {
                meter_id: 7.0,
                x: x.into(),
            };
            assert_eq!(address_of(&invalid), None, "{x:?}");
        }
    }

    #[test]
    fn a_payload_keeps_its_variant_and_its_full_i64_values() {
        let address = ParameterAddress {
            param_id: 1,
            x: i64::MIN,
            y: i64::MAX,
        };
        let PayloadRecord::Numeric {
            param_id,
            x,
            y,
            value,
        } = (&Notification::Numeric { address, value: -1 }).into()
        else {
            panic!("a numeric notification stays numeric");
        };
        assert_eq!(
            (param_id, x.as_str(), y.as_str(), value.as_str()),
            (1, "-9223372036854775808", "9223372036854775807", "-1")
        );
        let PayloadRecord::Text { value, .. } = (&Notification::Text {
            address,
            value: "12".into(),
        })
            .into()
        else {
            panic!("a text notification stays text, digits included");
        };
        assert_eq!(value, "12");
        assert!(matches!(
            (&Notification::Meter {
                address: MeterAddress { meter_id: 7, x: -1 },
                value: -120
            })
                .into(),
            PayloadRecord::Meter { meter_id: 7, ref x, ref value } if x == "-1" && value == "-120"
        ));
        assert!(matches!(
            PayloadRecord::from(&Notification::BulkChange),
            PayloadRecord::BulkChange
        ));
    }
}

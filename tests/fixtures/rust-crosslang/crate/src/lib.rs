//! The generated module, mounted the way a user crate mounts it. The test
//! generates `src/rpc/` into a copy of this crate before building it.
pub mod rpc;

use rpc::{Outcome, Priority};

/// The value `outcome(kind)` answers with, for each variant. The TypeScript
/// side of tests/rust-crosslang.integration.test.ts spells the same values.
pub fn sample_outcome(kind: &str) -> Option<Outcome> {
    match kind {
        "ready" => Some(Outcome::Ready { priority: Priority::InProgress, step_count: 3.0, note: Some("n".into()) }),
        "needPhoto" => Some(Outcome::NeedPhoto { spoken: "one more angle".into(), due: Some(None) }),
        "wrapped" => Some(Outcome::Wrapped { inner: Some(Box::new(Outcome::Empty)), owner: None }),
        "empty" => Some(Outcome::Empty),
        "raw" => Some(Outcome::Raw {
            first: serde_json::json!({ "x": 1 }),
            second: serde_json::json!([1, "two"]),
            third: serde_json::Value::Null,
        }),
        _ => None,
    }
}

/// Every variant's literal, in declaration order.
pub const OUTCOME_KINDS: [&str; 5] = ["ready", "needPhoto", "wrapped", "empty", "raw"];

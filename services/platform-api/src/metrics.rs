//! Prometheus-format request metrics for the platform API. The audit flagged that only the realtime
//! gateway exposed metrics (and even those were ad-hoc JSON, not Prometheus) — this closes the gap
//! for the primary API with a dependency-free recorder: per-(method, matched-route, status) request
//! counts and a global latency histogram, rendered as Prometheus text at `/metrics`.
//!
//! Cardinality is bounded by the route table (matched paths, not raw URLs — `/v1/…/{id}/…` collapses
//! to one series), so a `Mutex<HashMap>` on the count map is fine; the histogram uses atomics.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

/// Cumulative "less-than-or-equal" latency buckets in milliseconds (a +Inf bucket is implied by
/// the total count). Chosen to bracket a healthy API (sub-50ms) through slow DB/proxy calls.
const LATENCY_BUCKETS_MS: [u64; 8] = [5, 10, 25, 50, 100, 250, 500, 1000];

pub struct Metrics {
    requests: Mutex<HashMap<(String, String, u16), u64>>,
    latency_le: [AtomicU64; 8],
    latency_sum_ms: AtomicU64,
    latency_count: AtomicU64,
}

impl Default for Metrics {
    fn default() -> Self {
        Self::new()
    }
}

impl Metrics {
    pub fn new() -> Self {
        Self {
            requests: Mutex::new(HashMap::new()),
            latency_le: std::array::from_fn(|_| AtomicU64::new(0)),
            latency_sum_ms: AtomicU64::new(0),
            latency_count: AtomicU64::new(0),
        }
    }

    pub fn record(&self, method: &str, matched_path: &str, status: u16, latency_ms: u64) {
        if let Ok(mut m) = self.requests.lock() {
            *m.entry((method.to_owned(), matched_path.to_owned(), status))
                .or_insert(0) += 1;
        }
        for (i, bound) in LATENCY_BUCKETS_MS.iter().enumerate() {
            if latency_ms <= *bound {
                self.latency_le[i].fetch_add(1, Ordering::Relaxed);
            }
        }
        self.latency_sum_ms.fetch_add(latency_ms, Ordering::Relaxed);
        self.latency_count.fetch_add(1, Ordering::Relaxed);
    }

    /// Render Prometheus text-exposition (v0.0.4).
    pub fn render(&self) -> String {
        let mut out = String::new();
        out.push_str("# HELP http_requests_total Total HTTP requests handled.\n");
        out.push_str("# TYPE http_requests_total counter\n");
        if let Ok(m) = self.requests.lock() {
            for ((method, path, status), count) in m.iter() {
                out.push_str(&format!(
                    "http_requests_total{{method=\"{}\",path=\"{}\",status=\"{}\"}} {}\n",
                    escape(method),
                    escape(path),
                    status,
                    count,
                ));
            }
        }

        out.push_str("# HELP http_request_duration_ms Request latency in milliseconds.\n");
        out.push_str("# TYPE http_request_duration_ms histogram\n");
        let count = self.latency_count.load(Ordering::Relaxed);
        for (i, bound) in LATENCY_BUCKETS_MS.iter().enumerate() {
            out.push_str(&format!(
                "http_request_duration_ms_bucket{{le=\"{}\"}} {}\n",
                bound,
                self.latency_le[i].load(Ordering::Relaxed),
            ));
        }
        out.push_str(&format!(
            "http_request_duration_ms_bucket{{le=\"+Inf\"}} {}\n",
            count
        ));
        out.push_str(&format!(
            "http_request_duration_ms_sum {}\n",
            self.latency_sum_ms.load(Ordering::Relaxed)
        ));
        out.push_str(&format!("http_request_duration_ms_count {}\n", count));
        out
    }
}

// Prometheus label values must escape backslash, double-quote, and newline.
fn escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_and_renders_prometheus_exposition() {
        let m = Metrics::new();
        m.record("GET", "/health", 200, 3);
        m.record("GET", "/health", 200, 12);
        m.record("POST", "/v1/auth/login", 401, 40);

        let out = m.render();
        assert!(
            out.contains("http_requests_total{method=\"GET\",path=\"/health\",status=\"200\"} 2")
        );
        assert!(out.contains(
            "http_requests_total{method=\"POST\",path=\"/v1/auth/login\",status=\"401\"} 1"
        ));
        // 3 requests total; the le="5" bucket holds only the 3ms one.
        assert!(out.contains("http_request_duration_ms_bucket{le=\"5\"} 1"));
        assert!(out.contains("http_request_duration_ms_bucket{le=\"+Inf\"} 3"));
        assert!(out.contains("http_request_duration_ms_count 3"));
        assert!(out.contains("http_request_duration_ms_sum 55"));
    }

    #[test]
    fn escapes_label_values() {
        assert_eq!(escape("a\"b\\c"), "a\\\"b\\\\c");
    }
}

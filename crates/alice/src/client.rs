//! HTTP client for the Cashu gateway API.
//!
//! Provides a typed interface over the gateway's REST endpoints,
//! used by Alice to pay Lightning invoices with ecash, request
//! inbound Lightning invoices, and settle HTLC payments.
//!
//! Includes configurable timeouts and automatic retry for transient
//! HTTP errors (connection refused, 502/503/504).

use std::time::Duration;

use anyhow::{Context, Result};
use cashu_gateway_protocol::{
    PayInvoiceRequest, PayInvoiceResponse, RequestInvoiceRequest, RequestInvoiceResponse,
    SettleRequest, SettleResponse,
};
use reqwest::Client;
use serde::{de::DeserializeOwned, Serialize};
use tracing::{debug, warn};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_MAX_RETRIES: u32 = 3;
const RETRY_DELAY: Duration = Duration::from_millis(500);

/// HTTP client for the Cashu gateway API.
pub struct GatewayClient {
    gateway_url: String,
    http: Client,
    max_retries: u32,
}

impl GatewayClient {
    /// Create a new gateway client pointed at the given URL.
    pub fn new(gateway_url: &str) -> Self {
        let http = Client::builder()
            .timeout(DEFAULT_TIMEOUT)
            .build()
            .expect("failed to build HTTP client");

        Self {
            gateway_url: gateway_url.trim_end_matches('/').to_string(),
            http,
            max_retries: DEFAULT_MAX_RETRIES,
        }
    }

    /// Set the maximum number of retries for transient errors (default: 3).
    pub fn with_max_retries(mut self, max_retries: u32) -> Self {
        self.max_retries = max_retries;
        self
    }

    /// Pay a Lightning invoice with ecash proofs.
    pub async fn pay_invoice(&self, request: PayInvoiceRequest) -> Result<PayInvoiceResponse> {
        debug!(bolt11 = %request.bolt11, num_proofs = request.proofs.len(), "paying invoice");
        self.post("/pay-invoice", &request).await
    }

    /// Request a HODL invoice and HTLC-locked ecash from the gateway.
    pub async fn request_invoice(
        &self,
        request: RequestInvoiceRequest,
    ) -> Result<RequestInvoiceResponse> {
        debug!(
            amount_sats = request.amount_sats,
            preimage_hash = %request.preimage_hash,
            "requesting invoice"
        );
        self.post("/request-invoice", &request).await
    }

    /// Notify the gateway that Alice has claimed the HTLC ecash.
    pub async fn settle(&self, request: SettleRequest) -> Result<SettleResponse> {
        debug!(payment_hash = %request.payment_hash, "settling");
        self.post("/settle", &request).await
    }

    /// Return the base URL of the gateway.
    pub fn gateway_url(&self) -> &str {
        &self.gateway_url
    }

    /// Send a POST request with a JSON body and deserialize the response.
    ///
    /// Retries on transient errors: connection failures and 502/503/504 responses.
    async fn post<Req: Serialize, Resp: DeserializeOwned>(
        &self,
        path: &str,
        body: &Req,
    ) -> Result<Resp> {
        let url = format!("{}{}", self.gateway_url, path);

        let mut last_err = None;
        for attempt in 0..=self.max_retries {
            if attempt > 0 {
                warn!(attempt, path, "retrying after transient error");
                tokio::time::sleep(RETRY_DELAY * attempt).await;
            }

            let result = self.http.post(&url).json(body).send().await;

            let response = match result {
                Ok(r) => r,
                Err(e) if e.is_connect() || e.is_timeout() => {
                    last_err = Some(anyhow::anyhow!("POST {url}: {e}"));
                    continue;
                }
                Err(e) => return Err(e).with_context(|| format!("POST {url}")),
            };

            let status = response.status();

            // Retry on gateway errors (502/503/504)
            if matches!(status.as_u16(), 502 | 503 | 504) {
                let body_text = response.text().await.unwrap_or_default();
                last_err = Some(anyhow::anyhow!("POST {url} returned {status}: {body_text}"));
                continue;
            }

            if !status.is_success() {
                let body_text = response.text().await.unwrap_or_default();
                anyhow::bail!("POST {url} returned {status}: {body_text}");
            }

            let resp = response
                .json::<Resp>()
                .await
                .with_context(|| format!("deserializing response from POST {url}"))?;

            debug!(%status, "POST {path} complete");
            return Ok(resp);
        }

        Err(last_err.unwrap_or_else(|| anyhow::anyhow!("POST {url} failed after retries")))
    }
}

//! HTTP client for the Cashu gateway API.
//!
//! Provides a typed interface over the gateway's REST endpoints,
//! used by Alice to pay Lightning invoices with ecash, request
//! inbound Lightning invoices, and settle HTLC payments.

use anyhow::{Context, Result};
use cashu_gateway_protocol::{
    PayInvoiceRequest, PayInvoiceResponse, RequestInvoiceRequest, RequestInvoiceResponse,
    SettleRequest, SettleResponse,
};
use reqwest::Client;
use serde::{de::DeserializeOwned, Serialize};
use tracing::debug;

/// HTTP client for the Cashu gateway API.
pub struct GatewayClient {
    gateway_url: String,
    http: Client,
}

impl GatewayClient {
    /// Create a new gateway client pointed at the given URL.
    pub fn new(gateway_url: &str) -> Self {
        Self {
            gateway_url: gateway_url.trim_end_matches('/').to_string(),
            http: Client::new(),
        }
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
    async fn post<Req: Serialize, Resp: DeserializeOwned>(
        &self,
        path: &str,
        body: &Req,
    ) -> Result<Resp> {
        let url = format!("{}{}", self.gateway_url, path);

        let response = self
            .http
            .post(&url)
            .json(body)
            .send()
            .await
            .with_context(|| format!("POST {url}"))?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("POST {url} returned {status}: {body}");
        }

        let resp = response
            .json::<Resp>()
            .await
            .with_context(|| format!("deserializing response from POST {url}"))?;

        debug!(%status, "POST {path} complete");
        Ok(resp)
    }
}

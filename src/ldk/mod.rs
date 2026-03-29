//! LDK Lightning implementation module.
//!
//! This module contains:
//! - `LdkLightningBackend`: The LDK-based implementation of `LightningBackend`
//! - CLI API and commands for node management (internal)
//! - Internal types for node operations

pub mod backend;
pub mod cli;
pub mod types;

// Re-export the backend and the internal operations trait
pub use backend::{check_esplora_health, LdkLightningBackend, LdkNodeOperations};

// Re-export CLI types needed by the ldk-cli binary and main gateway server
pub use cli::{ldk_router, run_ldk_cli, LdkCli};


use anyhow::Result;
use cashu_gateway::ldk::{run_ldk_cli, LdkCli};
use clap::Parser;

#[tokio::main]
async fn main() -> Result<()> {
    let cli = LdkCli::parse();
    run_ldk_cli(cli).await
}

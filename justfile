alias b := build
alias c := check
alias t := test
alias f := format

default:
  @just --list

# ============================================================================
# Rust Build Commands
# ============================================================================

# run code formatters
format:
  cargo fmt --all

# check formatting without making changes
format-check:
  cargo fmt --all -- --check

# run `cargo build` on everything
build *ARGS="--workspace --all-targets":
  cargo build {{ARGS}}

# run `cargo check` on everything
check *ARGS="--workspace --all-targets":
  cargo check {{ARGS}}

# run `cargo clippy` on everything
clippy *ARGS="--workspace --all-targets":
  cargo clippy {{ARGS}} -- -D warnings

# run `cargo clippy --fix` on everything
clippy-fix *ARGS="--workspace --all-targets":
  cargo clippy {{ARGS}} --fix

# run tests
test *ARGS="--workspace":
  cargo test {{ARGS}}

# run all checks (format, clippy, test)
final-check: format-check clippy test

# ============================================================================
# Regtest Infrastructure Commands
# ============================================================================

# start the full regtest environment (bitcoind + esplora)
regtest-start:
  start-regtest

# stop the full regtest environment
regtest-stop:
  stop-regtest

# show status of regtest services
regtest-status:
  regtest-status

# view esplora container logs
esplora-logs:
  esplora-logs

# mine blocks (default: 1)
mine BLOCKS="1":
  mine {{BLOCKS}}

# fund an address with BTC (default: 1 BTC)
fund ADDRESS AMOUNT="1":
  fund {{ADDRESS}} {{AMOUNT}}

# run bitcoin-cli command
btc *ARGS:
  btc {{ARGS}}

# get new bitcoin address
new-address:
  new-address

# show wallet balance
balance:
  balance

# show current block height
blockheight:
  blockheight

# list unspent outputs
utxos:
  utxos

# initialize regtest with 101 blocks (makes coins spendable)
regtest-init: regtest-start
  @echo "Mining initial 101 blocks to make coinbase spendable..."
  mine 101
  @echo "Regtest initialized! You can now use 'just fund <address>' to send coins."

# clean all regtest data
regtest-clean: regtest-stop
  rm -rf .data/
  rm -rf .ldk-node-gateway/
  @echo "Regtest data cleaned"

# ============================================================================
# Development Workflows
# ============================================================================

# run the gateway in development mode
run: 
  cargo run --bin cashu-gateway

# run the ldk-cli
ldk *ARGS:
  cargo run --bin ldk-cli -- {{ARGS}}

# watch and rebuild on changes
watch:
  cargo watch -x check

# full dev setup: start regtest, init with blocks, build
dev-setup: regtest-init build
  @echo "Development environment ready!"

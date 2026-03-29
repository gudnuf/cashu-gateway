{
  description = "Cashu Gateway - Rust workspace with local regtest environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, rust-overlay }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        overlays = [ rust-overlay.overlays.default ];
        pkgs = import nixpkgs { inherit system overlays; };
        rust = pkgs.rust-bin.stable.latest.default.override {
          extensions = [ "rust-src" "rust-analyzer" ];
        };

        # Data directories (relative to project root)
        dataDir = ".data";
        bitcoindDataDir = "${dataDir}/bitcoind";
        esploraDataDir = "${dataDir}/esplora";

        # Ports
        bitcoindRpcPort = "18443";
        bitcoindP2pPort = "18444";
        esploraHttpPort = "3002";
        electrumPort = "50001";

        # Container names
        bitcoindContainer = "cashu-gateway-bitcoind";
        esploraContainer = "cashu-gateway-esplora";


        # ============================================================================
        # Docker Compose Scripts (bitcoind + esplora in containers)
        # ============================================================================

        startRegtest = pkgs.writeShellScriptBin "start-regtest" ''
          set -e
          cd "$PWD"
          
          echo "=== Starting Regtest Environment (Docker Compose) ==="
          ${pkgs.docker}/bin/docker compose up -d
          
          echo ""
          echo "Waiting for services to be healthy..."
          
          # Wait for bitcoind
          echo -n "Waiting for bitcoind..."
          for i in {1..30}; do
            if ${pkgs.docker}/bin/docker compose exec -T bitcoind bitcoin-cli -regtest -rpcuser=bitcoin -rpcpassword=bitcoin getblockchaininfo &>/dev/null; then
              echo " ready!"
              break
            fi
            echo -n "."
            sleep 1
          done
          
          # Mine initial blocks if chain is empty
          BLOCKS=$(${pkgs.docker}/bin/docker compose exec -T bitcoind bitcoin-cli -regtest -rpcuser=bitcoin -rpcpassword=bitcoin getblockcount 2>/dev/null || echo "0")
          if [ "$BLOCKS" = "0" ]; then
            echo "Mining initial 101 blocks for coinbase maturity..."
            ${pkgs.docker}/bin/docker compose exec -T bitcoind bitcoin-cli -regtest -rpcuser=bitcoin -rpcpassword=bitcoin createwallet "default" 2>/dev/null || true
            ADDR=$(${pkgs.docker}/bin/docker compose exec -T bitcoind bitcoin-cli -regtest -rpcuser=bitcoin -rpcpassword=bitcoin getnewaddress)
            ${pkgs.docker}/bin/docker compose exec -T bitcoind bitcoin-cli -regtest -rpcuser=bitcoin -rpcpassword=bitcoin generatetoaddress 101 "$ADDR" > /dev/null
            echo "Initial blocks mined!"
          fi
          
          # Wait for esplora
          echo -n "Waiting for esplora..."
          for i in {1..60}; do
            if curl -s http://127.0.0.1:${esploraHttpPort}/blocks/tip/height &>/dev/null; then
              echo " ready!"
              break
            fi
            echo -n "."
            sleep 2
          done
          
          echo ""
          echo "=== Regtest Environment Ready ==="
          echo "Bitcoin RPC: http://127.0.0.1:${bitcoindRpcPort} (user: bitcoin, pass: bitcoin)"
          echo "Esplora API: http://127.0.0.1:${esploraHttpPort}"
          echo ""
          echo "Use 'btc <cmd>' for bitcoin-cli access"
          echo "Use 'mine [n]' to mine blocks"
        '';

        stopRegtest = pkgs.writeShellScriptBin "stop-regtest" ''
          cd "$PWD"
          echo "=== Stopping Regtest Environment ==="
          ${pkgs.docker}/bin/docker compose down
          echo "=== Regtest Environment Stopped ==="
        '';

        cleanRegtest = pkgs.writeShellScriptBin "clean-regtest" ''
          cd "$PWD"
          echo "=== Cleaning Regtest Data ==="
          ${pkgs.docker}/bin/docker compose down -v
          echo "=== Regtest Data Cleaned ==="
        '';

        regtestLogs = pkgs.writeShellScriptBin "regtest-logs" ''
          cd "$PWD"
          ${pkgs.docker}/bin/docker compose logs -f "$@"
        '';

        esploraLogs = pkgs.writeShellScriptBin "esplora-logs" ''
          cd "$PWD"
          ${pkgs.docker}/bin/docker compose logs -f esplora
        '';

        # Bitcoin CLI wrapper for docker compose
        btcCli = pkgs.writeShellScriptBin "btc" ''
          cd "$PWD"
          ${pkgs.docker}/bin/docker compose exec -T bitcoind bitcoin-cli -regtest -rpcuser=bitcoin -rpcpassword=bitcoin "$@"
        '';

        # ============================================================================
        # Utility Scripts
        # ============================================================================

        mineBlocks = pkgs.writeShellScriptBin "mine" ''
          BLOCKS=''${1:-1}
          
          # Get or create a mining address
          ADDRESS=$(btc getnewaddress 2>/dev/null || true)
          
          if [ -z "$ADDRESS" ]; then
            # Create wallet first if needed
            btc createwallet "default" 2>/dev/null || true
            ADDRESS=$(btc getnewaddress)
          fi
          
          echo "Mining $BLOCKS block(s) to $ADDRESS..."
          btc generatetoaddress $BLOCKS $ADDRESS
        '';

        fundAddress = pkgs.writeShellScriptBin "fund" ''
          if [ -z "$1" ]; then
            echo "Usage: fund <address> [amount_btc]"
            exit 1
          fi
          ADDRESS=$1
          AMOUNT=''${2:-1}
          
          echo "Sending $AMOUNT BTC to $ADDRESS..."
          TXID=$(btc sendtoaddress "$ADDRESS" "$AMOUNT")
          echo "Transaction: $TXID"
          echo "Mining 1 block to confirm..."
          mine 1
        '';

        regtestStatus = pkgs.writeShellScriptBin "regtest-status" ''
          echo "=== Regtest Status ==="
          
          echo ""
          echo "Bitcoin Core:"
          if btc getblockchaininfo &>/dev/null; then
            BLOCKS=$(btc getblockcount)
            BALANCE=$(btc getbalance 2>/dev/null || echo "N/A")
            echo "  Status: Running"
            echo "  Blocks: $BLOCKS"
            echo "  Balance: $BALANCE BTC"
          else
            echo "  Status: Stopped"
          fi
          
          echo ""
          echo "Esplora:"
          if curl -s http://127.0.0.1:${esploraHttpPort}/blocks/tip/height &>/dev/null; then
            HEIGHT=$(curl -s http://127.0.0.1:${esploraHttpPort}/blocks/tip/height)
            echo "  Status: Running"
            echo "  REST API: http://127.0.0.1:${esploraHttpPort}"
            echo "  Block height: $HEIGHT"
          else
            echo "  Status: Stopped"
          fi
        '';

        # Additional bitcoin aliases for common operations
        getNewAddress = pkgs.writeShellScriptBin "new-address" ''
          btc getnewaddress "$@"
        '';

        getBalance = pkgs.writeShellScriptBin "balance" ''
          btc getbalance "$@"
        '';

        getBlockCount = pkgs.writeShellScriptBin "blockheight" ''
          btc getblockcount
        '';

        listUnspent = pkgs.writeShellScriptBin "utxos" ''
          btc listunspent "$@"
        '';

      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = [
            # Rust toolchain
            rust
            pkgs.cargo-nextest
            pkgs.cargo-watch
            pkgs.just

            # Docker for regtest environment
            pkgs.docker

            # Core scripts (docker compose based)
            startRegtest
            stopRegtest
            cleanRegtest
            regtestLogs
            esploraLogs
            btcCli
            mineBlocks
            fundAddress
            regtestStatus

            # Bitcoin CLI aliases
            getNewAddress
            getBalance
            getBlockCount
            listUnspent

            # Utilities
            pkgs.curl
            pkgs.jq
          ];

          shellHook = ''
            export RUST_BACKTRACE=1
            
            # Environment variables for the gateway
            export ESPLORA_URL="http://127.0.0.1:${esploraHttpPort}"
            export LDK_NETWORK="regtest"
            
            echo ""
            echo "╔══════════════════════════════════════════════════════════════╗"
            echo "║          Cashu Gateway Development Environment               ║"
            echo "╠══════════════════════════════════════════════════════════════╣"
            echo "║  Regtest (Docker Compose):                                   ║"
            echo "║    start-regtest    - Start bitcoind + esplora containers    ║"
            echo "║    stop-regtest     - Stop all containers                    ║"
            echo "║    clean-regtest    - Stop and remove all data volumes       ║"
            echo "║    regtest-status   - Check service status                   ║"
            echo "║    regtest-logs     - Follow all container logs              ║"
            echo "║    esplora-logs     - Follow esplora container logs          ║"
            echo "╠══════════════════════════════════════════════════════════════╣"
            echo "║  Bitcoin:                                                    ║"
            echo "║    btc <cmd>        - Run any bitcoin-cli command            ║"
            echo "║    mine [n]         - Mine n blocks (default: 1)             ║"
            echo "║    fund <addr> [n]  - Send n BTC to address (default: 1)     ║"
            echo "║    new-address      - Generate new receiving address         ║"
            echo "║    balance          - Show wallet balance                    ║"
            echo "║    blockheight      - Show current block height              ║"
            echo "║    utxos            - List unspent transaction outputs       ║"
            echo "╠══════════════════════════════════════════════════════════════╣"
            echo "║  Ports:                                                      ║"
            echo "║    Bitcoin RPC: ${bitcoindRpcPort}                                       ║"
            echo "║    Esplora API: ${esploraHttpPort}                                       ║"
            echo "╚══════════════════════════════════════════════════════════════╝"
            echo ""
            
            # Check if Docker is available
            if ! command -v docker &>/dev/null || ! docker info &>/dev/null 2>&1; then
              echo "⚠️  Warning: Docker is required but appears unavailable."
              echo "   Please ensure Docker is installed and running."
              echo ""
            fi
          '';
        };
      }
    );
}



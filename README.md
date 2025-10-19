# Cashu Gateway

**⚠️ Experimental** This is an experimental implementation of Lightning gateways for Cashu, where gateways hold ecash from a mint and send/receive Lightning payments on behalf of users.

## Getting Started

This project runs three concurrent processes (Alice, Gateway, Dealer) that communicate via Nostr.

```bash
# Install dependencies
bun install

# Set up environment variables
bun run setup-env

# Run all processes
bun run dev
```

Press `Ctrl+C` to stop all processes.


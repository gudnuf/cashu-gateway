# Cashu Gateway

**⚠️ Experimental** This is an experimental implementation of Lightning gateways for Cashu, where gateways hold ecash from a mint and send/receive Lightning payments on behalf of users.

## Development Setup

**Recommended:** Use Nix for reproducible development environments with automatic pre-commit hooks.

**Install Nix** using [Determinate Systems' installer](https://determinate.systems/):

```bash
curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix | sh -s -- install
```

**Option 1: Using direnv (Recommended)**

Install [direnv](https://direnv.net/docs/installation.html), then:

```bash
direnv allow
```

The environment loads automatically when you enter the directory.

**Option 2: Using nix develop**

```bash
nix develop
```

Manually enter the development shell.

**Alternative:** You can also install [Bun](https://bun.sh/) directly and use it without Nix, though you'll miss out on automatic pre-commit hooks and reproducible environments ;)

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

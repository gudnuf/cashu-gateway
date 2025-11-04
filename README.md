# Cashu Gateway

**⚠️ Experimental** This basically works except you currently have to trust the gateway way because it uses NWC which does not support hodling invoices. All of the messages and spending conditions are implemented to demonstrate the protocol, but when receiving through a gateway a different preimage from what is specified by Alice will be used. Future iterations of the gateway will hodl invoices until the dealer reveals the preimage.

## Overview

This project implements a gateway that bridges Cashu and the Lightning Network. Gateways enable users to send and receive lightning payments without talking to their mint.

See [INBOUND](./INBOUND.md) for an idea of how receiving through a gateway works.

## Development

This project runs three concurrent processes (Alice, Gateway, Dealer) that communicate via Nostr.

```bash
bun install

bun run setup-env
```

### Usage

Modify the .env file that was created when you ran `setup-env`. NOTE that this requires an NWC that supports NIP-47 notifications.

If all services are started you can now test it out by first giving the gateway some ecash, then Alice can receive ecash from the dealer, and finally pay out through the gateway.

### Full Flow Example

First, dealer receives a cashu token:

```bash
bun cli dealer receive-cashu <token>
```

Get the gateway's public key:

```bash
bun cli gateway pubkey
```

Get the dealer's public key:

```bash
bun cli dealer pubkey
```

Alice receives ecash through the gateway:

```bascli
bun cli alice receive <amount> <gateway_pubkey> <dealer_pubkey>
```

Alice pays a lightning invoice:

```bash
bun cli alice pay <invoice> <gateway_pubkey>
```

### Communication Protocol

Services communicate via **NIP-04 encrypted direct messages** over Nostr relays. This is for development purposes only and will be upgraded to a more robust protocol in the future.

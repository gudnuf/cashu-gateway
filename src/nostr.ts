import { type Event, type Filter, finalizeEvent, nip04, Relay } from "nostr-tools";
import type { Keys } from "./keys";
import type { NamedLogger } from "./logger";
import type { Request, Response } from "./types";

type RequestHandler = (senderPubkey: string, request: Request) => Promise<Response | undefined>;

export class NostrClient {
  private keys: Keys;
  private relay?: Relay;
  private logger?: NamedLogger;

  constructor(
    keys: Keys,
    private relayUrl: string,
    logger?: NamedLogger
  ) {
    this.keys = keys;
    this.logger = logger;
  }

  private async ensureConnected(): Promise<Relay> {
    if (!this.relay) {
      this.relay = await Relay.connect(this.relayUrl);
      this.logger?.info(`Connected to ${this.relayUrl}`);
    }
    return this.relay;
  }

  private async encrypt(recipientPubkey: string, content: string): Promise<string> {
    return nip04.encrypt(this.keys.getPrivateKeyHex(), recipientPubkey, content);
  }

  private async decrypt(senderPubkey: string, encryptedContent: string): Promise<string> {
    return nip04.decrypt(this.keys.getPrivateKeyHex(), senderPubkey, encryptedContent);
  }

  private async subscribe(filter: Filter, callback: (event: Event) => void): Promise<void> {
    const relay = await this.ensureConnected();
    relay.subscribe([filter], {
      onevent: callback,
      oneose: () => this.logger?.debug("Subscription established"),
    });
  }

  private async publish(event: Event): Promise<void> {
    const relay = await this.ensureConnected();
    await relay.publish(event);
  }

  async sendRequest(recipientPubkey: string, request: Request): Promise<string> {
    const encrypted = await this.encrypt(recipientPubkey, JSON.stringify(request));
    const event = finalizeEvent(
      {
        kind: 4,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", recipientPubkey]],
        content: encrypted,
      },
      this.keys.getPrivateKey()
    );

    await this.publish(event);
    this.logger?.info(`Request sent: ${request.method} -> ${recipientPubkey.slice(0, 8)}`);
    return event.id;
  }

  private async sendResponse(
    recipientPubkey: string,
    requestEventId: string,
    response: Response
  ): Promise<void> {
    const encrypted = await this.encrypt(recipientPubkey, JSON.stringify(response));
    const event = finalizeEvent(
      {
        kind: 4,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["p", recipientPubkey],
          ["e", requestEventId],
        ],
        content: encrypted,
      },
      this.keys.getPrivateKey()
    );

    await this.publish(event);
    this.logger?.info(`Response sent: ${recipientPubkey.slice(0, 8)}`);
  }

  async requestAndWaitForResponse(
    recipientPubkey: string,
    request: Request,
    timeoutMs = 30000
  ): Promise<Response> {
    const requestEventId = await this.sendRequest(recipientPubkey, request);
    const myPubkey = this.keys.getPublicKeyHex();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Request timeout")), timeoutMs);

      this.subscribe(
        {
          kinds: [4],
          "#p": [myPubkey],
          "#e": [requestEventId],
          since: Math.floor(Date.now() / 1000),
        },
        async (event: Event) => {
          if (event.pubkey !== recipientPubkey) return;

          try {
            const decrypted = await this.decrypt(event.pubkey, event.content);
            const response = JSON.parse(decrypted) as Response;
            clearTimeout(timer);
            this.logger?.info(`Response received: ${event.pubkey.slice(0, 8)}`);
            resolve(response);
          } catch (error) {
            this.logger?.error(`Failed to process response: ${error}`);
          }
        }
      );
    });
  }

  async listen(handler: RequestHandler): Promise<void> {
    const myPubkey = this.keys.getPublicKeyHex();

    await this.subscribe(
      {
        kinds: [4],
        "#p": [myPubkey],
        since: Math.floor(Date.now() / 1000),
      },
      async (event: Event) => {
        try {
          const decrypted = await this.decrypt(event.pubkey, event.content);
          const message = JSON.parse(decrypted);

          if (message.method) {
            this.logger?.info(
              `Request received: ${message.method} from ${event.pubkey.slice(0, 8)}`
            );
            const response = await handler(event.pubkey, message as Request);
            if (response) {
              await this.sendResponse(event.pubkey, event.id, response);
            }
          }
        } catch (error) {
          this.logger?.error(`Failed to process request: ${error}`);
        }
      }
    );

    this.logger?.info("Listening for requests");
  }
}

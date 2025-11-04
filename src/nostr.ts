import { type Event, type Filter, finalizeEvent, nip04, Relay } from "nostr-tools";
import type { Keys } from "./lib/keys";
import { logger, shortenKey } from "./lib/logger";
import type { Methods, Request, RequestForMethod, Response, ResponseForMethod } from "./types";

type RequestHandler = (senderPubkey: string, request: Request) => Promise<Response | undefined>;

export class NostrClient {
  private keys: Keys;
  private relay?: Relay;

  constructor(
    keys: Keys,
    private relayUrl: string
  ) {
    this.keys = keys;
  }

  private async ensureConnected(): Promise<Relay> {
    if (!this.relay) {
      this.relay = await Relay.connect(this.relayUrl);
      logger.info(`Connected to ${this.relayUrl}`);
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
  }

  async requestAndWaitForResponse<M extends Methods>(
    recipientPubkey: string,
    request: RequestForMethod<M>,
    timeoutMs = 30000
  ): Promise<ResponseForMethod<M>> {
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
            const response = JSON.parse(decrypted) as ResponseForMethod<M>;
            clearTimeout(timer);
            resolve(response);
          } catch (error) {
            logger.error(`Failed to process response: ${error}`);
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
            logger.info(`Request received: ${message.method} from ${shortenKey(event.pubkey)}`);
            const response = await handler(event.pubkey, message as Request);
            if (response) {
              await this.sendResponse(event.pubkey, event.id, response);
            }
          }
        } catch (error) {
          logger.error(`Failed to process request: ${error}`);
        }
      }
    );
  }
}

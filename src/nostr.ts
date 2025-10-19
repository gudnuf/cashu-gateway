import { type Event, type Filter, Relay } from "nostr-tools";

export class NostrClient {
  async subscribe(
    filter: Filter,
    relayUrl: string,
    callback: (event: Event) => void
  ): Promise<void> {
    const relay = await Relay.connect(relayUrl);

    relay.subscribe([filter], {
      onevent: callback,
      oneose: () => {
        console.log(`Subscription to ${relayUrl} established`);
      },
    });
  }

  async broadcast(event: Event, relayUrl: string): Promise<void> {
    const relay = await Relay.connect(relayUrl);
    await relay.publish(event);
    console.log(`Event published to ${relayUrl}`);
  }
}

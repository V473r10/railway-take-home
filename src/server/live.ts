import type { ContainerControl, ContainerView } from "./containers.ts";

export type LiveEvent =
  /** The whole list, sent once when a client connects (or reconnects). */
  | { type: "snapshot"; containers: ContainerView[] }
  | { type: "upsert"; container: ContainerView }
  | { type: "remove"; id: string };

type Client = { send: (event: LiveEvent) => void; open: boolean };

/**
 * Fans container changes out to every connected browser. Each change is read
 * from the database once, however many clients are connected. Snapshots and
 * change reads run one at a time, in order, so a client never receives a change
 * older than the snapshot it started from.
 */
export class LiveFeed {
  readonly #control: ContainerControl;
  readonly #clients = new Set<Client>();
  readonly #log: (msg: string) => void;
  #queue: Promise<void> = Promise.resolve();

  constructor(control: ContainerControl, log: (msg: string) => void = console.error) {
    this.#control = control;
    this.#log = log;
    control.onChange((id) =>
      this.#enqueue(async () => {
        if (this.#clients.size === 0) return;
        const container = await this.#control.getContainer(id);
        this.#broadcast(container ? { type: "upsert", container } : { type: "remove", id });
      }),
    );
  }

  /** Send the current list, then every change after it. Returns the function that disconnects. */
  connect(send: (event: LiveEvent) => void): () => void {
    const client: Client = { send, open: true };
    this.#enqueue(async () => {
      if (!client.open) return;
      client.send({ type: "snapshot", containers: await this.#control.listContainers() });
      this.#clients.add(client);
    });
    return () => {
      client.open = false;
      this.#clients.delete(client);
    };
  }

  #broadcast(event: LiveEvent): void {
    for (const client of this.#clients) client.send(event);
  }

  #enqueue(work: () => Promise<void>): void {
    this.#queue = this.#queue.then(work).catch((error: unknown) => this.#log(`live feed: ${String(error)}`));
  }
}

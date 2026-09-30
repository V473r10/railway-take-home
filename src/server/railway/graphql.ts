import {
  CONTAINER_PORT,
  type CreateContainerInput,
  type CreatedService,
  type DeploymentState,
  type DeploymentWatch,
  type Outcome,
  type PublicDomain,
  type RailwayAdapter,
  type SandboxService,
  type TokenIdentity,
} from "./adapter.ts";

export const RAILWAY_ENDPOINT = "https://backboard.railway.com/graphql/v2";
export const RAILWAY_WS_ENDPOINT = "wss://backboard.railway.com/graphql/v2";

/** The part of the WebSocket API the subscription uses; the global WebSocket satisfies it. */
export type WebSocketLike = {
  send(data: string): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: { code: number }) => void) | null;
};
export type WebSocketCtor = new (url: string, protocol: string) => WebSocketLike;

export type GraphqlRailwayConfig = {
  token: string;
  projectId: string;
  environmentId: string;
  endpoint?: string;
  wsEndpoint?: string;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Injected for tests; defaults to the global WebSocket. */
  WebSocket?: WebSocketCtor;
  /** Abort a call with no response after this long; the outcome is then ambiguous. */
  timeoutMs?: number;
  /** End a subscription whose socket has not acknowledged the connection after this long. */
  ackTimeoutMs?: number;
};

type GqlError = { message: string; extensions?: { code?: string; traceId?: string } };

type GqlDeployment = { id: string; status: string; deploymentStopped: boolean | null };

const DEPLOYMENT_FIELDS = "id status deploymentStopped";

function toState(d: GqlDeployment): DeploymentState {
  return { deploymentId: d.id, status: d.status, stopped: d.deploymentStopped === true };
}

function mapOk<T, U>(outcome: Outcome<T>, fn: (value: T) => U): Outcome<U> {
  return outcome.kind === "ok" ? { kind: "ok", value: fn(outcome.value) } : outcome;
}

/** Railway's public GraphQL API. Request shapes are the ones verified in the M0 spike. */
export class GraphqlRailway implements RailwayAdapter {
  readonly #config: GraphqlRailwayConfig;

  constructor(config: GraphqlRailwayConfig) {
    this.#config = config;
  }

  async verifyIdentity(): Promise<Outcome<TokenIdentity>> {
    // An anonymous caller gets `errors[]` or a null `me`; both leave the token unconfirmed (M0 spike).
    const outcome = await this.#request<{ me: { name: string | null } | null } | null>("query{ me{ name } }", {});
    if (outcome.kind !== "ok") return outcome;
    const me = outcome.value?.me;
    if (!me) return { kind: "rejected", message: "Railway did not say who the token belongs to", code: null, traceId: null };
    return { kind: "ok", value: { name: me.name ?? "(unnamed)" } };
  }

  async createContainer(input: CreateContainerInput): Promise<Outcome<CreatedService>> {
    // With `source.image`, serviceCreate also deploys; no separate deploy call is needed (M0).
    const outcome = await this.#request<{ serviceCreate: { id: string } }>(
      "mutation($input:ServiceCreateInput!){ serviceCreate(input:$input){ id } }",
      {
        input: {
          projectId: this.#config.projectId,
          environmentId: this.#config.environmentId,
          name: input.name,
          source: { image: input.image },
        },
      },
    );
    return mapOk(outcome, (d) => ({ serviceId: d.serviceCreate.id }));
  }

  async createDomain(serviceId: string): Promise<Outcome<PublicDomain>> {
    const outcome = await this.#request<{ serviceDomainCreate: { domain: string } }>(
      "mutation($input:ServiceDomainCreateInput!){ serviceDomainCreate(input:$input){ domain } }",
      { input: { serviceId, environmentId: this.#config.environmentId, targetPort: CONTAINER_PORT } },
    );
    return mapOk(outcome, (d) => ({ domain: d.serviceDomainCreate.domain }));
  }

  async findService(name: string): Promise<Outcome<CreatedService | null>> {
    return mapOk(await this.listServices(), (services) => {
      const found = services.find((s) => s.name === name);
      return found ? { serviceId: found.serviceId } : null;
    });
  }

  async listServices(): Promise<Outcome<SandboxService[]>> {
    const outcome = await this.#request<{ project: { services: { edges: { node: { id: string; name: string } }[] } } }>(
      "query($id:String!){ project(id:$id){ services{ edges{ node{ id name } } } } }",
      { id: this.#config.projectId },
    );
    return mapOk(outcome, (d) => d.project.services.edges.map((e) => ({ serviceId: e.node.id, name: e.node.name })));
  }

  async serviceDomain(serviceId: string): Promise<Outcome<PublicDomain | null>> {
    const outcome = await this.#request<{ domains: { serviceDomains: { domain: string }[] } }>(
      "query($p:String!,$e:String!,$s:String!){ domains(projectId:$p, environmentId:$e, serviceId:$s){ serviceDomains{ domain } } }",
      { p: this.#config.projectId, e: this.#config.environmentId, s: serviceId },
    );
    return mapOk(outcome, (d) => {
      const first = d.domains.serviceDomains[0];
      return first ? { domain: first.domain } : null;
    });
  }

  async latestDeployment(serviceId: string): Promise<Outcome<DeploymentState | null>> {
    const outcome = await this.#request<{ deployments: { edges: { node: GqlDeployment }[] } }>(
      `query($input:DeploymentListInput!){ deployments(input:$input, first:1){ edges{ node{ ${DEPLOYMENT_FIELDS} } } } }`,
      { input: { projectId: this.#config.projectId, environmentId: this.#config.environmentId, serviceId } },
    );
    return mapOk(outcome, (d) => {
      const node = d.deployments.edges[0]?.node;
      return node ? toState(node) : null;
    });
  }

  async readDeployment(deploymentId: string): Promise<Outcome<DeploymentState>> {
    const outcome = await this.#request<{ deployment: GqlDeployment }>(
      `query($id:String!){ deployment(id:$id){ ${DEPLOYMENT_FIELDS} } }`,
      { id: deploymentId },
    );
    return mapOk(outcome, (d) => toState(d.deployment));
  }

  async stopDeployment(deploymentId: string): Promise<Outcome<void>> {
    const outcome = await this.#request<{ deploymentStop: boolean }>("mutation($id:String!){ deploymentStop(id:$id) }", {
      id: deploymentId,
    });
    return mapOk(outcome, () => undefined);
  }

  async redeployService(serviceId: string): Promise<Outcome<void>> {
    const outcome = await this.#request<{ serviceInstanceRedeploy: boolean }>(
      "mutation($s:String!,$e:String!){ serviceInstanceRedeploy(serviceId:$s, environmentId:$e) }",
      { s: serviceId, e: this.#config.environmentId },
    );
    return mapOk(outcome, () => undefined);
  }

  async deleteService(serviceId: string): Promise<Outcome<void>> {
    const outcome = await this.#request<{ serviceDelete: boolean }>("mutation($id:String!){ serviceDelete(id:$id) }", { id: serviceId });
    return mapOk(outcome, () => undefined);
  }

  /**
   * One graphql-transport-ws socket per subscription (at most one per container).
   * Auth goes in `connection_init.payload`, not in a header (M0 spike). Railway
   * only pushes changes, so the caller reads the current state itself.
   */
  watchDeployment(deploymentId: string, watch: DeploymentWatch): () => void {
    const Ws = this.#config.WebSocket ?? (globalThis.WebSocket as unknown as WebSocketCtor);
    const ws = new Ws(this.#config.wsEndpoint ?? RAILWAY_WS_ENDPOINT, "graphql-transport-ws");
    let over = false;
    const send = (msg: unknown) => ws.send(JSON.stringify(msg));
    const finish = () => {
      over = true;
      clearTimeout(ackTimer);
      try {
        ws.close(1000);
      } catch {}
    };
    const end = (reason: string) => {
      if (over) return;
      finish();
      watch.onEnd(reason);
    };
    const ackTimer = setTimeout(() => end("no connection_ack"), this.#config.ackTimeoutMs ?? 10_000);

    ws.onopen = () => send({ type: "connection_init", payload: { Authorization: `Bearer ${this.#config.token}` } });
    ws.onerror = () => end("socket error");
    ws.onclose = (event) => end(`socket closed (${event.code})`);
    ws.onmessage = (event) => {
      let msg: { type?: string; payload?: { data?: { deployment?: GqlDeployment }; errors?: GqlError[] } };
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return end("unparseable frame");
      }
      switch (msg.type) {
        case "connection_ack":
          clearTimeout(ackTimer);
          send({
            id: "1",
            type: "subscribe",
            payload: {
              query: `subscription($id:String!){ deployment(id:$id){ ${DEPLOYMENT_FIELDS} } }`,
              variables: { id: deploymentId },
            },
          });
          return;
        case "ping":
          send({ type: "pong" });
          return;
        case "next": {
          const errors = msg.payload?.errors;
          if (errors?.length) return end(errors.map((e) => e.message).join("; "));
          const d = msg.payload?.data?.deployment;
          if (d && !over) watch.onState(toState(d));
          return;
        }
        case "error":
          return end(`subscription error: ${JSON.stringify(msg.payload)}`);
        case "complete":
          return end("subscription completed");
      }
    };

    return () => {
      if (over) return;
      try {
        send({ id: "1", type: "complete" });
      } catch {}
      finish();
    };
  }

  async #request<T>(query: string, variables: Record<string, unknown>): Promise<Outcome<T>> {
    const doFetch = this.#config.fetch ?? fetch;
    let res: Response;
    let body: { data?: T; errors?: GqlError[] };
    try {
      res = await doFetch(this.#config.endpoint ?? RAILWAY_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.#config.token}` },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(this.#config.timeoutMs ?? 15_000),
      });
      if (res.status === 429) return { kind: "rate_limited", retryAfterMs: retryAfterMs(res.headers.get("retry-after")) };
      if (res.status >= 500) return { kind: "ambiguous", reason: `HTTP ${res.status}` };
      body = (await res.json()) as typeof body;
    } catch (error) {
      // No response (network error, timeout, or a body cut off mid-read): Railway may have acted.
      return { kind: "ambiguous", reason: error instanceof Error ? error.message : String(error) };
    }
    const first = body.errors?.[0];
    if (first) {
      return {
        kind: "rejected",
        message: body.errors!.map((e) => e.message).join("; "),
        code: first.extensions?.code ?? null,
        traceId: first.extensions?.traceId ?? null,
      };
    }
    if (!res.ok || body.data === undefined) {
      return { kind: "rejected", message: `HTTP ${res.status} without data`, code: null, traceId: null };
    }
    return { kind: "ok", value: body.data };
  }
}

function retryAfterMs(header: string | null): number {
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = header ? Date.parse(header) : Number.NaN;
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 60_000;
}

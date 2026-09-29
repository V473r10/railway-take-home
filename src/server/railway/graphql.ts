import type { CreateContainerInput, CreatedService, Outcome, RailwayAdapter } from "./adapter.ts";

export const RAILWAY_ENDPOINT = "https://backboard.railway.com/graphql/v2";

export type GraphqlRailwayConfig = {
  token: string;
  projectId: string;
  environmentId: string;
  endpoint?: string;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Abort a call with no response after this long; the outcome is then ambiguous. */
  timeoutMs?: number;
};

type GqlError = { message: string; extensions?: { code?: string; traceId?: string } };

/** Railway's public GraphQL API. Request shapes are the ones verified in the M0 spike. */
export class GraphqlRailway implements RailwayAdapter {
  readonly #config: GraphqlRailwayConfig;

  constructor(config: GraphqlRailwayConfig) {
    this.#config = config;
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
    return outcome.kind === "ok" ? { kind: "ok", value: { serviceId: outcome.value.serviceCreate.id } } : outcome;
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

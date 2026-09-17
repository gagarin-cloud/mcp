/*
  The whole of this server's contact with gagarin.

  There is one write gate and it is the HTTP API. This file does not know what a
  project is, what a deploy means, or which fields a resource takes — it knows
  how to make a request carrying somebody's credential and how to read the one
  error envelope every gagarin server answers in. Everything else is in tools.ts,
  where each tool is a path and a shape.

  That split is the point. `gg` is a thin wrapper over this API and so is this;
  the moment either grows an opinion the other does not share, a terminal and an
  agent start describing the same platform differently.
*/

/** Where the control plane answers. Overridable so a laptop can point at a
 *  development engine, which is the only reason it is not a constant. */
export const DEFAULT_API = 'https://api.gagarin.cloud';

/**
 * The error contract, as the gagarin API defines it.
 *
 * `code` is stable and meant to be branched on; `message` says what happened and
 * `fix_hint` says what to do about it. The gagarin skill's tenth rule is "act on
 * the code, never on the prose", and this type is what makes that possible on
 * this side of the wire too.
 */
export type ApiError = {
  code: string;
  message: string;
  fix_hint?: string;
};

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly error: ApiError,
  ) {
    super(error.message);
    this.name = 'ApiFailure';
  }

  /**
   * The line `gg` prints, and the line a tool result carries.
   *
   * One rendering of a failure, shared by both transports, so an agent that has
   * read the skill recognises what comes back here without being taught a
   * second format.
   */
  render(): string {
    const head = `[${this.error.code}] ${this.error.message}`;
    return this.error.fix_hint ? `${head}\nhint: ${this.error.fix_hint}` : head;
  }
}

/** Raised before a request is made, when there is no credential to make it with. */
export function unauthenticated(): ApiFailure {
  return new ApiFailure(401, {
    code: 'unauthorized',
    message: 'this MCP server was given no gagarin credential',
    fix_hint:
      'remote: connect by URL and the client signs your human in over OAuth, or send a ' +
      'credential from `gg login` or `gg creds mint` as `Authorization: Bearer <credential>`; ' +
      'stdio: have your human run `gg login` on this machine, or export GAGARIN_TOKEN',
  });
}

export type CallOptions = {
  method?: string;
  body?: unknown;
  /** Milliseconds. The engine gives an apply 60 seconds and a backup 240, so
   *  nothing here may give up before it does — a client timeout during an apply
   *  reports a failure for a write that is still going through. */
  timeoutMs?: number;
  /** Set false for the routes that take no credential — the platform's own
   *  health — which must not be refused locally for the want of one. */
  authenticated?: boolean;
};

export class Api {
  constructor(
    readonly base: string = process.env.GAGARIN_API || DEFAULT_API,
    /** The caller's own credential. Held for the life of one request on the
     *  HTTP transport and for the life of the process on stdio; never logged,
     *  and never written anywhere. */
    private readonly token: string | null = null,
    /** Headers to add to every request. One caller sets this: the HTTP
     *  transport, which passes the caller's own address through so the engine's
     *  per-address rate limits apply to them rather than to this server. */
    private readonly extraHeaders: Record<string, string> = {},
  ) {
    this.base = this.base.replace(/\/+$/, '');
  }

  get authenticated(): boolean {
    return !!this.token;
  }

  async call<T = unknown>(path: string, opts: CallOptions = {}): Promise<T> {
    const authenticated = opts.authenticated !== false;
    if (authenticated && !this.token) throw unauthenticated();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);
    const seconds = Math.round((opts.timeoutMs ?? 120_000) / 1000);

    // One `finally` for the whole call, because the deadline covers the whole
    // call. `fetch` resolves as soon as the headers arrive, so a timer cleared
    // there leaves the body read unbounded and a response that stalls mid-stream
    // hangs the tool call forever instead of becoming the `timeout` failure this
    // file promises — and a timer cleared on only the happy paths keeps the
    // process alive for the full deadline after a failure.
    try {
      let res: Response;
      try {
        res = await fetch(this.base + path, {
          method: opts.method ?? 'GET',
          headers: {
            'Content-Type': 'application/json',
            // Some engine endpoints answer in prose unless asked otherwise,
            // because their usual reader is a language model reading a terminal.
            // This one is a program, and it wants the same JSON the dashboard gets.
            Accept: 'application/json',
            'User-Agent': userAgent(),
            ...this.extraHeaders,
            ...(authenticated && this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: controller.signal,
        });
      } catch (err) {
        // A timeout and a DNS failure are both "we never got an answer", and the
        // caller's next move is the same: this says nothing about whether the
        // write happened, so read the state rather than retrying blind.
        const aborted = err instanceof Error && err.name === 'AbortError';
        throw new ApiFailure(504, {
          code: aborted ? 'timeout' : 'unreachable',
          message: aborted
            ? `gagarin did not answer within ${seconds}s`
            : `could not reach ${this.base}: ${err instanceof Error ? err.message : String(err)}`,
          fix_hint:
            'this says nothing about whether the write landed — read the state with `status` before trying again',
        });
      }

      let text: string;
      try {
        text = await res.text();
      } catch (err) {
        // Headers arrived and the body did not. Reported the same way and for
        // the same reason: the write may well have gone through.
        const aborted = err instanceof Error && err.name === 'AbortError';
        throw new ApiFailure(504, {
          code: aborted ? 'timeout' : 'unreachable',
          message: aborted
            ? `gagarin began answering but did not finish within ${seconds}s`
            : `the connection to ${this.base} broke while the answer was being read`,
          fix_hint:
            'this says nothing about whether the write landed — read the state with `status` before trying again',
        });
      }

      // Not every body that reaches here is JSON: a proxy 502, a Traefik error
      // page and an engine route answering a browser all arrive as prose. Parsing
      // one unguarded throws a SyntaxError that escapes every `instanceof
      // ApiFailure` check downstream, so an unreadable body becomes an ApiFailure
      // like any other and the status is what gets believed.
      let parsed: any = {};
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new ApiFailure(res.status, {
            code: 'unreadable_response',
            message: res.ok
              ? 'gagarin answered in something this server cannot read; the request may well have gone through'
              : `gagarin answered ${res.status} in something this server cannot read`,
            fix_hint: 'read the state with `status` rather than assuming either way',
          });
        }
      }

      if (!res.ok) {
        throw new ApiFailure(
          res.status,
          parsed?.error ?? { code: 'unknown', message: text || `HTTP ${res.status}` },
        );
      }
      return parsed as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * What gagarin's logs will call us.
 *
 * Declared here rather than read off package.json at runtime: the compiled
 * output is vendored into a container image and published to npm, and "wherever
 * package.json happens to sit relative to dist/" is a different answer in those
 * two places. api.test.ts asserts this equals the manifest, so the two
 * cannot drift without a test saying so.
 */
export const VERSION = '0.1.0';

export function userAgent(): string {
  return `gagarin-mcp/${VERSION}`;
}

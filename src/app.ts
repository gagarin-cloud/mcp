/*
  The HTTP application behind mcp.gagarin.cloud, without the listener.

  Split from http.ts so a test can stand the real thing up on port 0 and ask it
  questions: the routes, the CORS, and the 401 a client with no credential gets
  are all things it is possible to be quietly wrong about, and none of them is
  visible from an in-memory MCP transport.
*/

import express, { type Express, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { Api, ApiFailure, VERSION } from './api.js';
import { createServer } from './server.js';

export type AppConfig = {
  /** Where this process reaches the engine. In the cluster that is the
   *  in-cluster Service, which is not a name a client could ever use. */
  api: string;
  /** Where clients reach this server, scheme and host only. The protected
   *  resource is this plus `/mcp`, and the engine refuses a token issued for
   *  any other resource name, so it must match what the engine expects. */
  origin: string;
  /** The OAuth authorization server a client is sent to — the engine's public
   *  address, and deliberately not `api`, for the reason given above. */
  issuer: string;
};

/** The one scope gagarin grants. There is no destroy scope; see the engine. */
const SCOPE = 'deploy';

/**
 * The caller's credential, or null.
 *
 * Header only. Never a query parameter and never a tool argument: the first
 * lands in every access log between here and the client, and the second lands in
 * the model's transcript, where it will be repeated back at some later point by
 * something that has no idea it is holding a secret.
 */
export function bearer(req: Request): string | null {
  const header = req.get('authorization');
  if (!header) return null;
  const [scheme, ...rest] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer') return null;
  const token = rest.join(' ').trim();
  return token || null;
}

export function createApp(config: AppConfig): Express {
  const origin = config.origin.replace(/\/+$/, '');
  const issuer = config.issuer.replace(/\/+$/, '');
  const resource = `${origin}/mcp`;
  const metadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`;

  const app = express();

  // One hop, and it is Traefik. This is what makes `req.ip` the caller's address
  // rather than the ingress pod's — and it is only safe because nothing reaches
  // this process except through that ingress.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // 4 MiB. An MCP request carries a tool call, and the largest thing a gagarin
  // tool call holds is a service's environment — which the engine itself caps far
  // below this, answering `body_too_large` with a hint about where env belongs.
  app.use(express.json({ limit: '4mb' }));

  /*
    CORS, because a browser-based MCP client is a real client.

    Wide open on the origin and deliberately without credentials: nothing here is
    authorised by a cookie, so a browser attaching one automatically would achieve
    nothing. Authorization must be set explicitly by the caller, which is a thing
    only code that means to can do — so `*` grants a page no access it did not
    already have to api.gagarin.cloud itself.

    WWW-Authenticate is exposed because a browser client that cannot read it
    cannot find the authorization server, and so cannot sign in at all.
  */
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', req.get('origin') || '*');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, Accept, Last-Event-ID, MCP-Session-Id, MCP-Protocol-Version',
    );
    res.setHeader(
      'Access-Control-Expose-Headers',
      'MCP-Session-Id, MCP-Protocol-Version, WWW-Authenticate',
    );
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  /**
   * What the kubelet asks.
   *
   * Answers for this process only, and on purpose. A readiness probe that called
   * the API would take every replica of this server out of rotation the moment
   * the control plane hiccuped — which is the shape of failure the platform's own
   * health endpoints are split in two to avoid. Whether gagarin is up is
   * `platform_health`, and it is a question for a caller, not for a kubelet.
   */
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, version: VERSION, api: config.api });
  });

  /*
    OAuth 2.0 Protected Resource Metadata (RFC 9728), which is how an MCP client
    that got a 401 finds out where to sign in.

    Both the path-suffixed form the spec derives from the resource
    (`/mcp` → `/.well-known/oauth-protected-resource/mcp`) and the bare one,
    because clients in the wild ask for either. Hand-written rather than the
    SDK's metadata router: that router also serves authorization-server metadata
    and expects to own it, and here the authorization server is the engine.

    Nothing here judges a token, and that is not an omission — the check below
    asks the engine rather than deciding. The engine is the one place that knows
    whether a credential is good; the MCP spec's worry
    about forwarding tokens is a third party between the token and its checker,
    and there is none — the engine accepts tokens issued for this resource name
    precisely because this server is gagarin's API in another shape.
  */
  const metadata = (_req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({
      resource,
      authorization_servers: [issuer],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'gagarin',
    });
  };
  app.get('/.well-known/oauth-protected-resource/mcp', metadata);
  app.get('/.well-known/oauth-protected-resource', metadata);

  /** For a person or an agent who opens this in a browser and gets prose. */
  app.get('/', (_req, res) => {
    res
      .type('text/plain')
      .send(
        `gagarin — MCP server ${VERSION}\n\n` +
          `This endpoint speaks the Model Context Protocol over streamable HTTP at\n` +
          `POST ${resource}. It is a translation of the gagarin API at\n` +
          `${issuer}; it holds no credential of its own, and every call carries yours.\n\n` +
          `Add it to an MCP client by URL:\n\n` +
          `  ${resource}\n\n` +
          `Claude, ChatGPT and Claude Code sign in when they connect: the client\n` +
          `opens a browser and you sign in with GitHub or Google. Nothing to paste.\n\n` +
          `A client that cannot do that can send a credential from \`gg login\` or\n` +
          `\`gg creds create\` in a header instead:\n\n` +
          `  {\n` +
          `    "mcpServers": {\n` +
          `      "gagarin": {\n` +
          `        "type": "http",\n` +
          `        "url": "${resource}",\n` +
          `        "headers": { "Authorization": "Bearer <your gagarin credential>" }\n` +
          `      }\n` +
          `    }\n` +
          `  }\n\n` +
          `Locally instead, over stdio:  npx -y @gagarin-cloud/mcp\n` +
          `(it reads the credential \`gg login\` wrote, or GAGARIN_TOKEN)\n\n` +
          `The CLI, which can also build and push:  https://github.com/gagarin-cloud/gg\n` +
          `Documentation:  https://gagarin.cloud/docs\n`,
      );
  });

  /**
   * The 401 that sends a client to sign in: the pointer to the metadata above,
   * and, when a credential was sent and refused, RFC 6750's `invalid_token`.
   * The body is JSON-RPC-shaped, because the caller is a protocol client.
   */
  function refuse(res: Response, message: string, error?: 'invalid_token'): void {
    const params = [`resource_metadata="${metadataUrl}"`, `scope="${SCOPE}"`];
    if (error) params.push(`error="${error}"`);
    res
      .status(401)
      .setHeader('WWW-Authenticate', `Bearer ${params.join(', ')}`)
      .json({ jsonrpc: '2.0', error: { code: -32001, message }, id: null });
  }

  /**
   * The protocol endpoint.
   *
   * Every method on one handler because the transport is what knows the
   * difference: a POST carries a message, a GET opens a stream, a DELETE ends a
   * session. In stateless mode the last two have little to do, and the transport
   * answers them correctly — which is a better answer than a route table here
   * guessing at the spec.
   */
  async function handle(req: Request, res: Response): Promise<void> {
    const token = bearer(req);

    /*
      No credential, no protocol: a 401 before a server is built, carrying the
      pointer to the metadata above. That 401 is what makes a client start the
      OAuth flow, so it has to happen here at the transport — a tool result
      saying `[unauthorized]` is something a model reads, not something a client
      acts on.
    */
    if (!token) {
      refuse(res, 'this gagarin MCP server needs a credential: sign in over OAuth, or send one in the Authorization header');
      return;
    }

    // The caller's address, so the engine's per-address rate limits apply to
    // them rather than to this server. Taken from `req.ip`, which Express derives
    // from the header Traefik wrote — never appended to what the client sent, or
    // a caller could spoof their way around a limit meant for them. Omitted rather
    // than sent empty when there is no address to name, since an empty value is a
    // worse answer than no answer.
    //
    // If the engine ever stops honouring this the effect is that every caller
    // shares one bucket: stricter than intended, never looser, which is the right
    // direction for a mistake in this particular header to fail in.
    const api = new Api(config.api, token, req.ip ? { 'X-Forwarded-For': req.ip } : {});

    /*
      A credential that is present but expired or revoked has to be a 401 here
      too, and the only way to know is to ask the engine. A client re-runs its
      sign-in only on an HTTP 401 carrying WWW-Authenticate; left to a tool, a
      lapsed access token (they live an hour) would come back as `[unauthorized]`
      on every call and the connector would stay stuck. A tool's 401 cannot be
      promoted afterwards, because by then the transport has begun answering.

      So every POST — the only method that carries a message — costs one
      `whoami` first. It is in-cluster and cheap, and it is one call per
      request: nothing is remembered between requests, because a cache of
      tokens that were good a moment ago is a store of tokens, and this server
      holds none.

      Only the engine's 401 becomes one. Anything else — the engine unreachable,
      a 5xx, a 403 for a credential that is valid but may do less — goes on to
      the protocol, where each tool reports its own failure with the engine's
      code and hint. Turning an outage into a 401 would send a human through a
      sign-in that cannot fix it; a 503 here would hide the one answer worth
      having, `[unreachable]` with what to do about it, behind a transport fault
      a client shows as "could not connect", and would make `platform_health`
      unaskable at exactly the moment it matters.
    */
    if (req.method === 'POST') {
      try {
        await api.call('/v1/whoami', { timeoutMs: 10_000 });
      } catch (err) {
        if (err instanceof ApiFailure && err.status === 401) {
          refuse(res, 'this gagarin credential is expired or revoked: sign in again', 'invalid_token');
          return;
        }
      }
    }

    const server = createServer(api);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    // Both are per-request and both must go when the response does, or a client
    // that hangs up mid-call leaves a server object behind for every one it made.
    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('mcp request failed', err);
      if (!res.headersSent) {
        // The JSON-RPC shape, because the caller is a protocol client and an HTML
        // error page is not something it can read.
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'internal error' },
          id: null,
        });
      }
    }
  }

  app.all('/mcp', (req, res) => void handle(req, res));

  return app;
}

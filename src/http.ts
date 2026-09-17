/*
  mcp.gagarin.cloud — the same tools, reachable without installing anything.

  ─── stateless, and why that is the whole design ───────────────────────────

  A fresh McpServer and transport are built for each request and thrown away
  with it. No sessions, no map of live connections, nothing in memory that
  outlives an answer. Three things fall out of that, and each is the reason:

   - **The credential is a request's, not a process's.** It arrives in the
     Authorization header, lives in one closure, and is gone. There is no store
     of tokens here to leak and nothing to get confused about whose is whose.
   - **Replicas are interchangeable.** A rolling deploy or an evicted pod costs
     a client one request, not a session. With sessions, a second replica needs
     shared state that this server has no business owning.
   - **There is nothing to clean up.** The one thing a stateful MCP server has
     to get right — releasing a session whose client vanished — cannot be got
     wrong here.

  ─── what this server is, exactly ──────────────────────────────────────────

  A translator, and nothing else. It holds no credential of its own, has no
  database, and makes no decision the API does not make: every tool is one call
  to api.gagarin.cloud carrying the caller's own bearer token, and every refusal
  is the engine's refusal passed through. That is what keeps the platform's
  single-write-gate property true with this in front of it — put differently,
  possessing this server grants nothing at all.

  So it deliberately does not run in Vercel beside the site and the console.
  Those live outside Scaleway because their job is to still be there and say the
  platform is down. This one has nothing to say when the API is unreachable; it
  *is* the API, in another shape, so it belongs next to it.
*/

import express, { type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { Api, DEFAULT_API, VERSION } from './api.js';
import { createServer } from './server.js';

const PORT = Number(process.env.PORT || 8080);
const API = process.env.GAGARIN_API || DEFAULT_API;

/**
 * The caller's credential, or null.
 *
 * Header only. Never a query parameter and never a tool argument: the first
 * lands in every access log between here and the client, and the second lands in
 * the model's transcript, where it will be repeated back at some later point by
 * something that has no idea it is holding a secret.
 */
function bearer(req: Request): string | null {
  const header = req.get('authorization');
  if (!header) return null;
  const [scheme, ...rest] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer') return null;
  const token = rest.join(' ').trim();
  return token || null;
}

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
*/
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.get('origin') || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, Accept, Last-Event-ID, MCP-Session-Id, MCP-Protocol-Version',
  );
  res.setHeader('Access-Control-Expose-Headers', 'MCP-Session-Id, MCP-Protocol-Version');
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
 * the API would take every replica of this server out of rotation the moment the
 * control plane hiccuped — which is the shape of failure the platform's own
 * health endpoints are split in two to avoid. Whether gagarin is up is
 * `platform_health`, and it is a question for a caller, not for a kubelet.
 */
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, version: VERSION, api: API });
});

/** For a person or an agent who opens this in a browser and gets prose. */
app.get('/', (_req, res) => {
  res
    .type('text/plain')
    .send(
      `gagarin — MCP server ${VERSION}\n\n` +
        `This endpoint speaks the Model Context Protocol over streamable HTTP at\n` +
        `POST https://mcp.gagarin.cloud/mcp. It is a translation of the gagarin API\n` +
        `at ${API}; it holds no credential of its own, and every call carries yours.\n\n` +
        `Add it to an MCP client:\n\n` +
        `  {\n` +
        `    "mcpServers": {\n` +
        `      "gagarin": {\n` +
        `        "type": "http",\n` +
        `        "url": "https://mcp.gagarin.cloud/mcp",\n` +
        `        "headers": { "Authorization": "Bearer <your gagarin credential>" }\n` +
        `      }\n` +
        `    }\n` +
        `  }\n\n` +
        `No credential yet? Connect without the header and call the login tool: it\n` +
        `emails your human a button, and the claim tool hands back the credential\n` +
        `once they have clicked it.\n\n` +
        `Locally instead, over stdio:  npx -y @gagarin-cloud/mcp\n\n` +
        `The CLI, which can also build and push:  https://github.com/gagarin-cloud/gg\n` +
        `Documentation:  https://gagarin.cloud/docs\n`,
    );
});

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
  // The caller's address, so the engine's per-address rate limits apply to them
  // rather than to this server. Taken from `req.ip`, which Express derives from
  // the header Traefik wrote — never appended to what the client sent, or a
  // caller could spoof their way around a limit meant for them. Omitted rather
  // than sent empty when there is no address to name, since an empty value is a
  // worse answer than no answer.
  //
  // If the engine ever stops honouring this the effect is that every caller
  // shares one bucket: stricter than intended, never looser, which is the right
  // direction for a mistake in this particular header to fail in.
  const api = new Api(API, bearer(req), req.ip ? { 'X-Forwarded-For': req.ip } : {});

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

const httpServer = app.listen(PORT, () => {
  console.log(`gagarin mcp ${VERSION} listening on :${PORT}, proxying ${API}`);
});

/*
  A rolling deploy sends SIGTERM and waits.

  Closing the listener stops new connections and lets the ones in flight finish,
  which matters more here than it looks: a tool call can be an apply the engine
  is allowed sixty seconds for, and killing it at the socket tells the caller
  nothing about whether the write landed.
*/
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`${signal}: draining`);
    httpServer.close(() => process.exit(0));
    // A floor under the drain, so a stuck connection cannot hold a pod past the
    // grace period and turn a rolling deploy into a killed one.
    setTimeout(() => process.exit(0), 25_000).unref();
  });
}

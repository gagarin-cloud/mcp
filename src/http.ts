/*
  mcp.gagarin.cloud — the same tools, reachable without installing anything.

  ─── stateless, and why that is the whole design ───────────────────────────

  A fresh McpServer and transport are built for each request and thrown away
  with it. No sessions, no map of live connections, nothing in memory that
  outlives an answer. Three things fall out of that, and each is the reason:

   - **The credential is a request's, not a process's.** It arrives in the
     Authorization header — put there by the client's OAuth sign-in, or by
     hand — lives in one closure, and is gone. There is no store of tokens
     here to leak and nothing to get confused about whose is whose.
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

import { DEFAULT_API, VERSION } from './api.js';
import { createApp } from './app.js';

const PORT = Number(process.env.PORT || 8080);
const API = process.env.GAGARIN_API || DEFAULT_API;

const app = createApp({
  api: API,
  // Both public names are their own variables, not derived from GAGARIN_API:
  // in the cluster that points at the in-cluster Service, which is no address a
  // client could sign in at. Overridable so a laptop can run the whole flow
  // against a development engine.
  origin: process.env.GAGARIN_MCP_ORIGIN || 'https://mcp.gagarin.cloud',
  issuer: process.env.GAGARIN_ISSUER || DEFAULT_API,
});

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

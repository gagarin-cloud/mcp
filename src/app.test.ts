/*
  The HTTP application, over a real socket.

  What a client does before it has a credential is decided entirely here: the
  401 that starts its OAuth flow, the header that says where to go, and the
  metadata document at the end of that pointer. None of it is visible through an
  in-memory MCP transport, so this stands the app up on port 0 and asks.
*/

import assert from 'node:assert/strict';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import { createApp } from './app.js';

const config = {
  api: 'https://api.example',
  origin: 'https://mcp.example',
  issuer: 'https://issuer.example',
};

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function shut(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * The app, listening on a free port, for the length of one test — in front of
 * an engine that answers every request with `engine`, or in front of nothing at
 * all when it is null. Recorded, so a test can say what was asked.
 */
async function listening(
  fn: (base: string, asked: { path: string; authorization?: string }[]) => Promise<void>,
  engine: number | null = 200,
) {
  const asked: { path: string; authorization?: string }[] = [];
  let api = 'http://127.0.0.1:1';
  let stub: Server | null = null;
  if (engine !== null) {
    stub = createHttpServer((req, res) => {
      asked.push({ path: req.url ?? '', authorization: req.headers.authorization });
      const body =
        engine === 200
          ? { account: 'someone@example.com' }
          : { error: { code: 'unauthorized', message: 'credential expired' } };
      res.writeHead(engine, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    });
    api = await listen(stub);
  }
  const app = createApp({ ...config, api }).listen(0);
  await new Promise<void>((resolve) => app.once('listening', resolve));
  try {
    await fn(`http://127.0.0.1:${(app.address() as AddressInfo).port}`, asked);
  } finally {
    await shut(app);
    if (stub) await shut(stub);
  }
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  },
};

const post = (base: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(initialize),
  });

for (const path of [
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-protected-resource',
]) {
  test(`${path} names this resource and the engine as its authorization server`, async () => {
    await listening(async (base) => {
      const res = await fetch(base + path);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      assert.deepEqual(await res.json(), {
        resource: 'https://mcp.example/mcp',
        authorization_servers: ['https://issuer.example'],
        scopes_supported: ['deploy'],
        bearer_methods_supported: ['header'],
        resource_name: 'gagarin',
      });
    });
  });
}

test('no credential is a 401 that says where to sign in', async () => {
  await listening(async (base) => {
    const res = await post(base);
    assert.equal(res.status, 401);
    assert.equal(
      res.headers.get('www-authenticate'),
      'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/mcp", scope="deploy"',
    );
    // A browser client has to be allowed to read that header, or it cannot sign in.
    assert.match(res.headers.get('access-control-expose-headers') ?? '', /WWW-Authenticate/);
    const body: any = await res.json();
    assert.equal(body.jsonrpc, '2.0');
    assert.ok(body.error.message);
  });
});

test('a scheme that is not Bearer counts as no credential', async () => {
  await listening(async (base) => {
    const res = await post(base, { Authorization: 'Basic dXNlcjpwYXNz' });
    assert.equal(res.status, 401);
  });
});

test('a preflight is answered without a credential', async () => {
  await listening(async (base) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://client.example', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('www-authenticate'), null);
  });
});

test('a credential the engine accepts reaches the protocol, after one whoami', async () => {
  await listening(async (base, asked) => {
    const res = await post(base, { Authorization: 'Bearer a-credential' });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /"serverInfo"/);
    assert.match(text, /"name":"gagarin"/);
    // initialize itself asks the engine nothing, so this is the check and only it.
    assert.deepEqual(asked, [{ path: '/v1/whoami', authorization: 'Bearer a-credential' }]);
  });
});

test('a credential the engine refuses is a 401 that sends the client to sign in again', async () => {
  await listening(async (base) => {
    const res = await post(base, { Authorization: 'Bearer expired' });
    assert.equal(res.status, 401);
    assert.equal(
      res.headers.get('www-authenticate'),
      'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/mcp", scope="deploy", error="invalid_token"',
    );
    const body: any = await res.json();
    assert.equal(body.jsonrpc, '2.0');
  }, 401);
});

test('an engine that cannot be reached is not a sign-in problem', async () => {
  await listening(async (base) => {
    // Not a 401, which would send a human through a sign-in that cannot help:
    // the request goes on, and the tools say `[unreachable]` for themselves.
    const res = await post(base, { Authorization: 'Bearer a-credential' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('www-authenticate'), null);
  }, null);
});

test('an engine answering 5xx is not a sign-in problem either', async () => {
  await listening(async (base) => {
    const res = await post(base, { Authorization: 'Bearer a-credential' });
    assert.equal(res.status, 200);
  }, 503);
});

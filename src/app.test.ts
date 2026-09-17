/*
  The HTTP application, over a real socket.

  What a client does before it has a credential is decided entirely here: the
  401 that starts its OAuth flow, the header that says where to go, and the
  metadata document at the end of that pointer. None of it is visible through an
  in-memory MCP transport, so this stands the app up on port 0 and asks.
*/

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import { createApp } from './app.js';

const config = {
  api: 'https://api.example',
  origin: 'https://mcp.example',
  issuer: 'https://issuer.example',
};

/** The app, listening on a free port, for the length of one test. */
async function listening(fn: (base: string) => Promise<void>) {
  const server = createApp(config).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
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

test('with a bearer the request reaches the protocol', async () => {
  await listening(async (base) => {
    // initialize makes no call to the engine, so nothing needs standing in for it.
    const res = await post(base, { Authorization: 'Bearer a-credential' });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /"serverInfo"/);
    assert.match(text, /"name":"gagarin"/);
  });
});

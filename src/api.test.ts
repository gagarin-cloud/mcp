/*
  What this server does with an answer it did not expect.

  The happy path is exercised by tools.test.ts through a real MCP client. What is
  worth testing here is the other half of the error contract — the shapes that
  arrive when something between here and the engine has gone wrong, each of which
  has already reached a caller as an unhandled exception in one codebase or
  another on this platform.
*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { Api, ApiFailure, VERSION } from './api.js';

/** Stand in for the network for the length of one call. */
function withFetch(handler: (url: string, init: RequestInit) => Response, fn: () => Promise<void>) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) =>
    handler(String(input), init ?? {})) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = real;
  });
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('the engine\'s error envelope survives the trip', async () => {
  await withFetch(
    () =>
      json(403, {
        error: {
          code: 'approval_required',
          message: 'deleting shop needs human approval',
          fix_hint: 'we emailed you — click the button, then run this again',
        },
      }),
    async () => {
      const api = new Api('https://api.example', 'secret');
      await assert.rejects(
        () => api.call('/v1/projects/shop', { method: 'DELETE' }),
        (err: unknown) => {
          assert.ok(err instanceof ApiFailure);
          assert.equal(err.status, 403);
          assert.equal(err.error.code, 'approval_required');
          // The line `gg` prints, so an agent that has read the skill meets one
          // format rather than two.
          assert.equal(
            err.render(),
            '[approval_required] deleting shop needs human approval\n' +
              'hint: we emailed you — click the button, then run this again',
          );
          return true;
        },
      );
    },
  );
});

test('a body that is not JSON becomes an ApiFailure, not a SyntaxError', async () => {
  await withFetch(
    () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    async () => {
      const api = new Api('https://api.example', 'secret');
      await assert.rejects(
        () => api.call('/v1/whoami'),
        (err: unknown) => {
          assert.ok(err instanceof ApiFailure);
          assert.equal(err.error.code, 'unreadable_response');
          return true;
        },
      );
    },
  );
});

test('an unreachable control plane says nothing about whether the write landed', async () => {
  await withFetch(
    () => {
      throw new TypeError('fetch failed');
    },
    async () => {
      const api = new Api('https://api.example', 'secret');
      await assert.rejects(
        () => api.call('/v1/projects', { method: 'POST', body: { name: 'shop' } }),
        (err: unknown) => {
          assert.ok(err instanceof ApiFailure);
          assert.equal(err.error.code, 'unreachable');
          assert.match(err.error.fix_hint ?? '', /says nothing about whether the write landed/);
          return true;
        },
      );
    },
  );
});

/*
  A body that never finishes.

  `fetch` resolves the moment the headers arrive, so a deadline that is cleared
  there does not cover the body at all — and a Traefik or engine response that
  stalls mid-stream used to hang the tool call for as long as the connection
  stayed open, which for an agent means forever. The stream below yields its
  headers and then nothing, and the abort has to be what ends it.
*/
test('a response that stops halfway is a timeout, not a hang', async () => {
  await withFetch(
    (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"half":'));
            // Never closed. The only way out is the signal.
            init.signal?.addEventListener('abort', () => controller.error(init.signal!.reason));
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    async () => {
      const api = new Api('https://api.example', 'secret');
      await assert.rejects(
        () => api.call('/v1/projects/shop/status', { timeoutMs: 60 }),
        (err: unknown) => {
          assert.ok(err instanceof ApiFailure);
          assert.equal(err.error.code, 'timeout');
          assert.match(err.error.message, /began answering but did not finish/);
          return true;
        },
      );
    },
  );
});

test('no credential is refused before a request is made', async () => {
  let called = false;
  await withFetch(
    () => {
      called = true;
      return json(200, {});
    },
    async () => {
      const api = new Api('https://api.example', null);
      await assert.rejects(
        () => api.call('/v1/whoami'),
        (err: unknown) => {
          assert.ok(err instanceof ApiFailure);
          assert.equal(err.error.code, 'unauthorized');
          return true;
        },
      );
      // The point of refusing locally: an unauthenticated call to the engine
      // would spend one of somebody's rate-limited attempts to say the same thing.
      assert.equal(called, false, 'nothing should have been sent');
    },
  );
});

test('an unauthenticated route is reachable with no credential at all', async () => {
  let sawAuthorization = true;
  await withFetch(
    (_url, init) => {
      sawAuthorization = 'Authorization' in ((init.headers ?? {}) as Record<string, string>);
      return json(200, { ok: true });
    },
    async () => {
      const api = new Api('https://api.example', null);
      const body = await api.call<{ ok: boolean }>('/healthz/platform', { authenticated: false });
      assert.equal(body.ok, true);
      assert.equal(sawAuthorization, false, 'no header to send, and none sent');
    },
  );
});

test('the announced version is the published one', () => {
  // Two places to write a version is two places for it to disagree, and the one
  // that would be wrong is the one gagarin's logs record.
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  assert.equal(VERSION, manifest.version);
});

/*
  The tools, through a real MCP client.

  Every one of them is a path, a method and a body, and the only way to be wrong
  about that is to be wrong quietly — a deploy that PUTs to the wrong path
  answers 404 and reads like a missing service. So these tests speak the protocol
  properly, over an in-memory transport, and assert on the request that would
  have gone to the engine.
*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { Api } from './api.js';
import { createServer } from './server.js';

type Seen = { url: string; method: string; body: unknown; headers: Record<string, string> };

/** A client wired to a server whose engine is a function. */
async function connected(reply: (seen: Seen) => Response) {
  const seen: Seen[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Seen = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(init.body) : undefined,
      headers,
    };
    seen.push(call);
    return reply(call);
  }) as typeof fetch;

  const server = createServer(new Api('https://api.example', 'a-credential'));
  const client = new Client({ name: 'test', version: '0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  return {
    client,
    seen,
    async [Symbol.asyncDispose]() {
      globalThis.fetch = real;
      await client.close();
      await server.close();
    },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const textOf = (result: any) => result.content.map((c: any) => c.text).join('\n');

test('every tool is described, and the ones that cannot be here are not', async () => {
  const kit = await connected(() => json({}));
  try {
    const { tools } = await kit.client.listTools();
    const names = tools.map((t) => t.name);

    // The spine of the product: if one of these ever disappears, an agent loses
    // a verb it was told it has.
    for (const expected of ['whoami', 'projects', 'status', 'deploy', 'logs', 'add_resource']) {
      assert.ok(names.includes(expected), `${expected} is missing`);
    }
    // And the ones that need a docker daemon and a working copy. A tool named
    // `ship` here would fail at pull time with an error that reads like a
    // registry fault; see the header of tools.ts.
    for (const absent of ['ship', 'build', 'push', 'connect']) {
      assert.ok(!names.includes(absent), `${absent} cannot work over MCP and must not be offered`);
    }
    for (const tool of tools) {
      assert.ok((tool.description ?? '').length > 40, `${tool.name} needs a real description`);
    }
  } finally {
    await kit[Symbol.asyncDispose]();
  }
});

test('a read carries the credential and nothing else', async () => {
  const kit = await connected(() => json({ account: 'someone@example.com', can: ['deploy'] }));
  try {
    const result = await kit.client.callTool({ name: 'whoami', arguments: {} });
    assert.equal(kit.seen[0]?.url, 'https://api.example/v1/whoami');
    assert.equal(kit.seen[0]?.method, 'GET');
    assert.equal(kit.seen[0]?.headers.Authorization, 'Bearer a-credential');
    assert.match(textOf(result), /someone@example\.com/);
  } finally {
    await kit[Symbol.asyncDispose]();
  }
});

test('deploy PUTs the service and passes the environment through whole', async () => {
  const kit = await connected(() => json({ name: 'web' }));
  try {
    await kit.client.callTool({
      name: 'deploy',
      arguments: {
        project: 'shop',
        service: 'web',
        image: 'registry.gagarin.cloud/abc123/web:v3',
        port: 8080,
        env: { DATABASE_URL: 'postgres://…' },
      },
    });
    const call = kit.seen[0]!;
    assert.equal(call.url, 'https://api.example/v1/projects/shop/services/web');
    assert.equal(call.method, 'PUT');
    // project and service name the path; they are not fields in the body.
    assert.deepEqual(call.body, {
      image: 'registry.gagarin.cloud/abc123/web:v3',
      port: 8080,
      env: { DATABASE_URL: 'postgres://…' },
    });
  } finally {
    await kit[Symbol.asyncDispose]();
  }
});

test('amending an external sends set, and never env', async () => {
  const kit = await connected(() =>
    json({ resource: 'openai', changed: ['OPENAI_API_KEY'], removed: [], dependents: ['bot'] }),
  );
  try {
    await kit.client.callTool({
      name: 'rotate_resource',
      arguments: { project: 'shop', resource: 'openai', set: { API_KEY: 'sk-two' } },
    });
    const call = kit.seen[0]!;
    assert.equal(call.url, 'https://api.example/v1/projects/shop/resources/openai/rotate');
    assert.equal(call.method, 'POST');
    // The distinction this tool exists to preserve: `env` here would replace
    // the bundle, taking every other key away from every dependent.
    assert.deepEqual(call.body, { set: { API_KEY: 'sk-two' } });
  } finally {
    await kit[Symbol.asyncDispose]();
  }
});

test('a removal goes as unset, and what stopped being published comes back', async () => {
  const kit = await connected(() => json({ resource: 'openai', changed: [], removed: ['OPENAI_BASE_URL'] }));
  try {
    const result = await kit.client.callTool({
      name: 'rotate_resource',
      arguments: { project: 'shop', resource: 'openai', unset: ['BASE_URL'] },
    });
    assert.deepEqual(kit.seen[0]!.body, { unset: ['BASE_URL'] });
    // The caller has to be able to see the loss to report it.
    assert.match(textOf(result), /OPENAI_BASE_URL/);
  } finally {
    await kit[Symbol.asyncDispose]();
  }
});

test('a minted rotation still sends an empty body', async () => {
  const kit = await connected(() => json({ resource: 'db' }));
  try {
    await kit.client.callTool({ name: 'rotate_resource', arguments: { project: 'shop', resource: 'db' } });
    assert.deepEqual(kit.seen[0]!.body, {});
  } finally {
    await kit[Symbol.asyncDispose]();
  }
});

test('a request combining env with set is passed on for the engine to refuse', async () => {
  const kit = await connected(() => json({ error: { code: 'conflicting_env' } }, 400));
  try {
    await kit.client.callTool({
      name: 'rotate_resource',
      arguments: { project: 'shop', resource: 'openai', env: { API_KEY: 'a' }, set: { BASE_URL: 'b' } },
    });
    // Both halves reach the engine. Dropping one here to make the request
    // valid would report a rotation that succeeded as the one that was asked
    // for, when it was not.
    assert.deepEqual(kit.seen[0]!.body, { env: { API_KEY: 'a' }, set: { BASE_URL: 'b' } });
  } finally {
    await kit[Symbol.asyncDispose]();
  }
});

test('resource_keys asks the keys endpoint and returns no values', async () => {
  const kit = await connected(() =>
    json({ resource: 'openai', type: 'external', keys: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'] }),
  );
  try {
    const result = await kit.client.callTool({
      name: 'resource_keys',
      arguments: { project: 'shop', resource: 'openai' },
    });
    assert.equal(kit.seen[0]!.url, 'https://api.example/v1/projects/shop/resources/openai/keys');
    assert.equal(kit.seen[0]!.method, 'GET');
    assert.match(textOf(result), /OPENAI_API_KEY/);
  } finally {
    await kit[Symbol.asyncDispose]();
  }
});

test('the safe read is the one a model is steered to', async () => {
  const kit = await connected(() => json({}));
  try {
    const { tools } = await kit.client.listTools();
    const keys = tools.find((t: any) => t.name === 'resource_keys')!;
    const secrets = tools.find((t: any) => t.name === 'resource_secrets')!;
    const status = tools.find((t: any) => t.name === 'status')!;
    // Two tools answer nearly the same question and only one of them puts a
    // credential in the transcript, so which to reach for cannot be left to
    // the model to infer from their titles.
    assert.match(keys.description!, /Prefer this over `resource_secrets`/i);
    assert.match(secrets.description!, /only when a value is what you need/i);
    // And status must not send anyone looking for values it no longer carries.
    assert.match(status.description!, /does not carry a resource's environment/i);
  } finally {
    await kit[Symbol.asyncDispose]();
  }
});

test('an external is rolled back through the same verb a service uses', async () => {
  const kit = await connected(() =>
    json({
      revision: 3,
      restored_from: 1,
      service: { kind: 'resource:external' },
      changed: ['CFG_LOG_LEVEL'],
      dependents: ['web', 'worker'],
    }),
  );
  try {
    const result = await kit.client.callTool({
      name: 'rollback',
      arguments: { project: 'shop', service: 'cfg', to: 1 },
    });
    // One verb, one path. A resource is named where a service would be.
    assert.equal(kit.seen[0]!.url, 'https://api.example/v1/projects/shop/services/cfg/rollback');
    assert.deepEqual(kit.seen[0]!.body, { to: 1 });
    // The dependents come back, because that is the blast radius of the call.
    assert.match(textOf(result), /worker/);
  } finally {
    await kit[Symbol.asyncDispose]();
  }
});

test('the rollback tool says config is undone at the resource, not the dependent', async () => {
  const kit = await connected(() => json({}));
  try {
    const { tools } = await kit.client.listTools();
    const rollback = tools.find((t: any) => t.name === 'rollback')!;
    const add = tools.find((t: any) => t.name === 'add_resource')!;
    // The instruction an agent needs and would otherwise get wrong: rolling
    // back a dependent does not undo a config change, because the injected half
    // is re-derived rather than restored.
    assert.match(rollback.description!, /roll back the external resource holding it/i);
    // And the pattern itself has to be discoverable from the tool that creates one.
    assert.match(add.description!, /shared configuration/i);

    // The failure mode this is really guarding: an agent asked to change one
    // variable, without the user's env file, reconstructing the whole
    // environment from history and redeploying. That silently drops whatever it
    // misread and pulls every secret through the conversation — so `deploy` has
    // to warn against it by name and point at the alternative.
    const deploy = tools.find((t: any) => t.name === 'deploy')!;
    assert.match(deploy.description!, /do NOT reconstruct it/i);
    assert.match(deploy.description!, /external/i);
    assert.match(add.description!, /do not have the user's env file/i);
  } finally {
    await kit[Symbol.asyncDispose]();
  }
});

test('an address is asked for by name, and released by query', async () => {
  const kit = await connected(() => json({ ok: true }));
  try {
    await kit.client.callTool({
      name: 'add_domain',
      arguments: { project: 'shop', service: 'web', domain: 'shop.example.com' },
    });
    assert.equal(kit.seen[0]?.method, 'PUT');
    assert.deepEqual(kit.seen[0]?.body, { domain: 'shop.example.com' });

    // No domain is the request for the generated address, not a mistake — the
    // engine reads an empty string that way and this must send one.
    await kit.client.callTool({
      name: 'add_domain',
      arguments: { project: 'shop', service: 'web' },
    });
    assert.deepEqual(kit.seen[1]?.body, { domain: '' });

    await kit.client.callTool({
      name: 'remove_domain',
      arguments: { project: 'shop', service: 'web', domain: 'shop.example.com' },
    });
    assert.equal(kit.seen[2]?.method, 'DELETE');
    assert.equal(
      kit.seen[2]?.url,
      'https://api.example/v1/projects/shop/services/web/domain?domain=shop.example.com',
    );
  } finally {
    await kit[Symbol.asyncDispose]();
  }
});

test('a restore names the new resource in the path and the old one in the body', async () => {
  const kit = await connected(() => json({ ok: true }));
  try {
    await kit.client.callTool({
      name: 'restore_resource',
      arguments: { project: 'shop', resource: 'db-restored', source: 'db' },
    });
    // Getting these the wrong way round would overwrite a live database, which
    // is the one thing this endpoint is built never to do.
    assert.equal(
      kit.seen[0]?.url,
      'https://api.example/v1/projects/shop/resources/db-restored/restore',
    );
    assert.deepEqual(kit.seen[0]?.body, { source: 'db' });
  } finally {
    await kit[Symbol.asyncDispose]();
  }
});

test('a refusal comes back as an error result an agent can branch on', async () => {
  const kit = await connected(() =>
    json(
      {
        error: {
          code: 'approval_required',
          message: 'deleting shop needs human approval',
          fix_hint: 'we emailed you — click the button, then ask again',
        },
      },
      403,
    ),
  );
  try {
    const result: any = await kit.client.callTool({
      name: 'destroy_project',
      arguments: { project: 'shop' },
    });
    // isError rather than a thrown protocol error: the model has to see the code.
    assert.equal(result.isError, true);
    assert.match(textOf(result), /^\[approval_required\] /);
    assert.match(textOf(result), /hint: we emailed you/);
  } finally {
    await kit[Symbol.asyncDispose]();
  }
});

test('with no credential the onboarding tools still work and the rest say why', async () => {
  const real = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: any) => {
    seen.push(String(input));
    return json({ claim: 'ABCD-1234' }, 202);
  }) as typeof fetch;

  const server = createServer(new Api('https://api.example', null));
  const client = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    const login: any = await client.callTool({
      name: 'login',
      arguments: { email: 'someone@example.com' },
    });
    assert.notEqual(login.isError, true);
    assert.deepEqual(seen, ['https://api.example/v1/signup']);

    const projects: any = await client.callTool({ name: 'projects', arguments: {} });
    assert.equal(projects.isError, true);
    assert.match(textOf(projects), /^\[unauthorized\]/);
    // And it says what to do about it, which is the whole reason an agent with
    // no credential is allowed to connect at all.
    assert.match(textOf(projects), /login/);
    assert.equal(seen.length, 1, 'a call with no credential is not worth making');
  } finally {
    globalThis.fetch = real;
    await client.close();
    await server.close();
  }
});

test('the guide is served and says what the CLI is still for', async () => {
  const kit = await connected(() => json({}));
  try {
    const { resources } = await kit.client.listResources();
    assert.ok(resources.some((r) => r.uri === 'gagarin://guide'));
    const read = await kit.client.readResource({ uri: 'gagarin://guide' });
    const text = String((read.contents[0] as any).text);
    assert.match(text, /gg ship/);
    assert.match(text, /cannot build/i);
  } finally {
    await kit[Symbol.asyncDispose]();
  }
});

/*
  An email in a path segment.

  `encodeURIComponent` escapes `@`, and echo does not unescape a path parameter —
  it routes on the raw path and hands the handler exactly what arrived. So
  `bob%40example.com` reached `deleteMember` as that literal string,
  `mail.ParseAddress` refused it, and `unshare` answered `invalid_email` for
  every address anybody ever passed. There is no way to notice that from this
  side except by looking at the URL, which is what this does.
*/
test('an email survives the path it is put in', async () => {
  const kit = await connected(() => json({ ok: true }));
  try {
    await kit.client.callTool({
      name: 'unshare',
      arguments: { project: 'shop', email: 'bob+ci@example.com' },
    });
    assert.equal(kit.seen[0]?.method, 'DELETE');
    assert.equal(kit.seen[0]?.url, 'https://api.example/v1/projects/shop/members/bob+ci@example.com');
  } finally {
    await kit[Symbol.asyncDispose]();
  }
});

// The other half of that rule: leaving `@` alone must not have left anything
// dangerous alone. A name carrying a slash or a query must stay inside its own
// segment rather than becoming more path. `=` stays as it is, exactly as Go's
// url.PathEscape leaves it — a segment containing one is still a segment, and
// the `?` that would have started a query is escaped.
test('a name cannot climb out of its segment', async () => {
  const kit = await connected(() => json({}));
  try {
    await kit.client.callTool({
      name: 'status',
      arguments: { project: '../../v1/credentials?x=1' },
    });
    assert.equal(
      kit.seen[0]?.url,
      'https://api.example/v1/projects/..%2F..%2Fv1%2Fcredentials%3Fx=1/status',
    );
  } finally {
    await kit[Symbol.asyncDispose]();
  }
});

/*
  Jobs.

  A job is the same PUT as a deploy with one field different, which is exactly
  the kind of thing that is easy to get wrong quietly: sending `kind` on the
  wrong call, or forgetting it and silently creating a service that crash-loops
  on a script that exited 0. Both halves are asserted.
*/
test('a run is a deploy with a kind, and answers the revision naming it', async () => {
  const kit = await connected(() => json({ name: 'migrate', kind: 'job', revision: 3 }));
  try {
    const result = await kit.client.callTool({
      name: 'run',
      arguments: {
        project: 'shop',
        service: 'migrate',
        image: 'reg/shop/migrate:v3',
        env: { DSN: 'from-deps' },
        deps: ['db'],
      },
    });
    assert.equal(kit.seen[0]?.method, 'PUT');
    assert.equal(kit.seen[0]?.url, 'https://api.example/v1/projects/shop/services/migrate');
    assert.deepEqual(kit.seen[0]?.body, {
      image: 'reg/shop/migrate:v3',
      env: { DSN: 'from-deps' },
      deps: ['db'],
      kind: 'job',
    });
    // The revision is the run's name and the one thing a caller waiting on it
    // needs, so it has to survive back out through the tool result.
    assert.match(textOf(result), /"revision": 3/);
  } finally {
    await kit[Symbol.asyncDispose]();
  }
});

test('a deploy is never a job', async () => {
  const kit = await connected(() => json({}));
  try {
    await kit.client.callTool({
      name: 'deploy',
      arguments: { project: 'shop', service: 'web', image: 'reg/shop/web:1', port: 8080 },
    });
    assert.equal((kit.seen[0]?.body as any).kind, undefined);
  } finally {
    await kit[Symbol.asyncDispose]();
  }
});

// A job has neither, and the engine refuses both with codes of their own. The
// schema is what stops an agent trying in the first place.
test('the run tool offers no port and no volume', async () => {
  const kit = await connected(() => json({}));
  try {
    const { tools } = await kit.client.listTools();
    const run = tools.find((t) => t.name === 'run')!;
    const fields = Object.keys((run.inputSchema as any).properties);
    for (const absent of ['port', 'volume_path', 'volume_size_gb']) {
      assert.ok(!fields.includes(absent), `a job has no ${absent}`);
    }
    assert.deepEqual(
      fields.filter((f) => ['project', 'service', 'image'].includes(f)).sort(),
      ['image', 'project', 'service'],
    );
  } finally {
    await kit[Symbol.asyncDispose]();
  }
});

/*
  Handing a project over, from the agent's side.

  The thing worth pinning is that `transfer` is not a handover — it is an offer,
  and the tool has to be the sort of thing an agent reads and then tells its human
  "they have to click a link". The description carries that, and the description
  is the only documentation an agent ever sees.
*/
test('transfer offers a project rather than moving it', async () => {
  const kit = await connected(() => json({ offer: { to: 'them@example.com' } }));
  try {
    const tools = (await kit.client.listTools()).tools;
    const transfer = tools.find((t) => t.name === 'transfer');
    assert.ok(transfer, 'the transfer tool is missing');
    // An agent that reads this as "done" will tell its human the wrong thing.
    assert.match(String(transfer.description), /does not hand it over/i);
    assert.match(String(transfer.description), /press the button/i);

    await kit.client.callTool({
      name: 'transfer',
      arguments: { project: 'shop', email: 'them@example.com', name: 'shop-prod' },
    });
    assert.equal(kit.seen[0]?.method, 'POST');
    assert.equal(kit.seen[0]?.url, 'https://api.example/v1/projects/shop/transfer');
    assert.deepEqual(kit.seen[0]?.body, { email: 'them@example.com', name: 'shop-prod' });
  } finally {
    await kit[Symbol.asyncDispose]();
  }
});

// The name is optional, and an omitted one has to reach the engine as "keep the
// name it has" rather than as the string "undefined" — which is a legal project
// name-shaped thing and would silently rename somebody's project.
test('a transfer with no new name asks for no rename', async () => {
  const kit = await connected(() => json({}));
  try {
    await kit.client.callTool({
      name: 'transfer',
      arguments: { project: 'shop', email: 'them@example.com' },
    });
    assert.deepEqual(kit.seen[0]?.body, { email: 'them@example.com', name: '' });

    await kit.client.callTool({ name: 'untransfer', arguments: { project: 'shop' } });
    assert.equal(kit.seen[1]?.method, 'DELETE');
    assert.equal(kit.seen[1]?.url, 'https://api.example/v1/projects/shop/transfer');
  } finally {
    await kit[Symbol.asyncDispose]();
  }
});

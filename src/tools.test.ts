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
import { APPROVAL_REQUIRED, DESTRUCTIVE_WITHOUT_APPROVAL } from './tools.js';
import { TOOLS_SNAPSHOT, type SnapshotRow } from './tools.snapshot.js';

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

// The restore is one call: gagarin creates the resource as the backup's type.
// An agent told to create it first would have to know that type, which for a
// destroyed source nothing but its backups records — so the tool must not ask.
test('a restore is one call and never asks for a type', async () => {
  const kit = await connected(() => json({ ok: true }));
  try {
    const { tools } = await kit.client.listTools();
    const restore = tools.find((t) => t.name === 'restore_resource')!;
    assert.doesNotMatch(String(restore.description), /add_resource` to create/);
    // Answered before the data moves, so the description has to send the
    // agent to the place the outcome shows up.
    assert.match(String(restore.description), /restore\.state/);
    assert.equal('type' in (restore.inputSchema.properties ?? {}), false);

    await kit.client.callTool({
      name: 'restore_resource',
      arguments: { project: 'shop', resource: 'vec2', source: 'vec', storage_gb: 20 },
    });
    assert.equal(kit.seen.length, 1);
    assert.deepEqual(kit.seen[0]?.body, { source: 'vec', storage_gb: 20 });
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

test('with no credential the tools say why, and ask the engine nothing', async () => {
  const real = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: any) => {
    seen.push(String(input));
    return json({});
  }) as typeof fetch;

  const server = createServer(new Api('https://api.example', null));
  const client = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  try {
    const { tools } = await client.listTools();
    for (const gone of ['login', 'claim']) {
      assert.ok(!tools.some((t) => t.name === gone), `${gone} went with email sign-in`);
    }

    const projects: any = await client.callTool({ name: 'projects', arguments: {} });
    assert.equal(projects.isError, true);
    assert.match(textOf(projects), /^\[unauthorized\]/);
    // And it says how to get one, on either transport.
    assert.match(textOf(projects), /OAuth/);
    assert.match(textOf(projects), /gg login/);
    assert.equal(seen.length, 0, 'a call with no credential is not worth making');
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

/*
  Annotations.

  These five hints are how a client decides whether to stop and ask a human
  before calling something, so a wrong one is not a cosmetic bug: `deploy`
  marked destructive makes an agent ask permission on every ship, and a
  `set_deps` marked safe lets it withdraw an edge without anybody being warned
  that the call is about to stop dead and mail the owner.

  The spec's defaults are the reason all five are asserted rather than the
  interesting ones: `destructiveHint` and `openWorldHint` default TRUE and
  `idempotentHint` defaults false, so a tool registered without annotations is
  presumed to be an open-world destroyer and nothing complains.
*/

test('every tool carries all five annotations', async () => {
  const kit = await connected(() => json({}));
  try {
    const { tools } = await kit.client.listTools();
    assert.ok(tools.length > 0, 'no tools were registered');
    for (const tool of tools) {
      const a = tool.annotations;
      assert.ok(a, `${tool.name} has no annotations at all`);
      assert.equal(typeof a.title, 'string', `${tool.name} needs an annotation title`);
      assert.ok(String(a.title).length > 0, `${tool.name} needs a non-empty annotation title`);
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
        assert.equal(
          typeof a[hint],
          'boolean',
          `${tool.name} leaves ${hint} to its default, which is the wrong answer`,
        );
      }
      // A read that also destroys is a contradiction a client cannot act on.
      if (a.readOnlyHint) {
        assert.equal(a.destructiveHint, false, `${tool.name} cannot be read-only and destructive`);
      }
    }
  } finally {
    await kit[Symbol.asyncDispose]();
  }
});

// Nothing here reaches past gagarin. A true here would tell a client the tool
// touches an unbounded external world, and the whole surface is one account.
test('no tool claims an open world', async () => {
  const kit = await connected(() => json({}));
  try {
    const { tools } = await kit.client.listTools();
    const open = tools.filter((t) => t.annotations?.openWorldHint !== false).map((t) => t.name);
    assert.deepEqual(open, [], `these claim an open world: ${open.join(', ')}`);
  } finally {
    await kit[Symbol.asyncDispose]();
  }
});

/*
  The invariant this whole classification exists to hold.

  An operation the engine refuses with `approval_required` stops dead and emails
  the account owner a button. An agent that was told the tool is safe will call
  it, be refused, and — if it has not been told why — retry. So every one of
  them is destructiveHint true, and the set is taken from APPROVAL_REQUIRED,
  which is the engine's own `requireElevation` call sites, rather than from a
  list written again here.

  It is a subset rather than an equality because two tools are destructive
  without asking anybody: see DESTRUCTIVE_WITHOUT_APPROVAL. Those two are named,
  so destructive-and-silent cannot be added to by accident — a new one fails
  here until somebody puts it in that set on purpose.
*/
test('the tools that need a human are exactly the destructive ones', async () => {
  const kit = await connected(() => json({}));
  try {
    const { tools } = await kit.client.listTools();
    const destructive = tools
      .filter((t) => t.annotations?.destructiveHint === true)
      .map((t) => t.name)
      .sort();

    assert.deepEqual(
      destructive,
      [...APPROVAL_REQUIRED, ...DESTRUCTIVE_WITHOUT_APPROVAL].sort(),
      'the destructive tools no longer match the operations that need approval',
    );

    // And the approval table names tools that exist. A rename that missed it
    // would otherwise leave the invariant asserting something about nothing.
    const names = new Set(tools.map((t) => t.name));
    for (const name of [...APPROVAL_REQUIRED, ...DESTRUCTIVE_WITHOUT_APPROVAL]) {
      assert.ok(names.has(name), `${name} is in the approval tables but is not a tool`);
    }
  } finally {
    await kit[Symbol.asyncDispose]();
  }
});

// The pause, in the words an agent reads. Only the tools that really wait for a
// click say so — promising an email that never arrives would be worse than
// saying nothing, which is why the two silent destroyers are excluded.
test('every tool that waits for a human says so in its description', async () => {
  const kit = await connected(() => json({}));
  try {
    const { tools } = await kit.client.listTools();
    for (const name of APPROVAL_REQUIRED) {
      const tool = tools.find((t) => t.name === name)!;
      assert.match(
        String(tool.description),
        /approval_required/,
        `${name} pauses for a human and does not say so`,
      );
    }
    for (const name of DESTRUCTIVE_WITHOUT_APPROVAL) {
      const tool = tools.find((t) => t.name === name)!;
      assert.doesNotMatch(
        String(tool.description),
        /approval_required/,
        `${name} does not go through approval and must not promise that it does`,
      );
    }
  } finally {
    await kit[Symbol.asyncDispose]();
  }
});

// The graph is the firewall, so `[]` is not an empty request — it is every
// connection cut. An agent that reads this as a no-op causes an outage that
// reports nothing.
test('set_deps says what an empty list does', async () => {
  const kit = await connected(() => json({}));
  try {
    const { tools } = await kit.client.listTools();
    const setDeps = tools.find((t) => t.name === 'set_deps')!;
    assert.match(String(setDeps.description), /empty list disconnects/i);
  } finally {
    await kit[Symbol.asyncDispose]();
  }
});

// Read-only, and yet it hands live credentials to whatever is reading. The
// annotation cannot carry that; the description has to.
test('resource_secrets is read-only and says it returns secrets', async () => {
  const kit = await connected(() => json({}));
  try {
    const { tools } = await kit.client.listTools();
    const secrets = tools.find((t) => t.name === 'resource_secrets')!;
    assert.equal(secrets.annotations?.readOnlyHint, true);
    assert.match(String(secrets.description), /credentials|secret/i);
  } finally {
    await kit[Symbol.asyncDispose]();
  }
});

// restore_resource fills a new resource and overwrites nothing, which is the
// whole reason it is not destructive. If that ever stops being true, this and
// its annotation both have to change.
test('restore_resource is non-destructive and says why', async () => {
  const kit = await connected(() => json({}));
  try {
    const { tools } = await kit.client.listTools();
    const restore = tools.find((t) => t.name === 'restore_resource')!;
    assert.equal(restore.annotations?.destructiveHint, false);
    assert.match(String(restore.description), /never overwrites/i);
  } finally {
    await kit[Symbol.asyncDispose]();
  }
});

/*
  The snapshot, so a tool cannot arrive unclassified.

  Registering one without annotations is a two-line change that reads as
  finished and quietly tells every client the thing is an open-world destroyer.
  This is what makes that a failing build with the tool's name in it.
*/
test('tools/list matches the recorded annotations', async () => {
  const kit = await connected(() => json({}));
  try {
    const { tools } = await kit.client.listTools();
    const live: Record<string, SnapshotRow> = {};
    for (const t of [...tools].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const a = t.annotations!;
      live[t.name] = [
        String(a.title),
        a.readOnlyHint as boolean,
        a.destructiveHint as boolean,
        a.idempotentHint as boolean,
        a.openWorldHint as boolean,
      ];
    }
    assert.deepEqual(
      live,
      TOOLS_SNAPSHOT,
      'the tools changed; check the classification by hand, then update src/tools.snapshot.ts',
    );
  } finally {
    await kit[Symbol.asyncDispose]();
  }
});

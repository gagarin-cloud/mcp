/*
  Every tool this server offers, and nothing else.

  Each one is a path on the gagarin API, a shape for its arguments, and a
  sentence saying the rule a caller most needs to know before using it. There is
  no logic here beyond that: no caching, no retries, no client-side validation of
  things the engine validates, and no second opinion about what any answer means.

  Three deliberate absences, because a tool that half works is worse than one
  that does not exist:

   - **No build and no push.** `gg ship`, `gg build`, `gg push` and
     `gg registry copy` shell out to docker on the machine holding the source.
     A server reachable at mcp.gagarin.cloud has neither the source nor a docker
     daemon, and pretending otherwise would produce a `deploy` that fails at pull
     time with an error that reads like a registry fault. `deploy` here runs an
     image that is already in gagarin's registry; getting one there is the CLI's
     job, and the tool descriptions say so rather than leaving it to be found out.
   - **No tunnel.** `gg connect` binds a local port. There is no local anything
     on the other end of an MCP call.
   - **No list of resource types, sizes or scopes.** The engine owns those and
     its refusals name them. A zod enum here would be a second list in a second
     repository, wrong on the day a type is added — which this codebase has
     already done once, in `gg`, about this exact family of values.
*/

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { Api, ApiFailure } from './api.js';

/**
 * Escape one value for use as a single path segment.
 *
 * Not plain `encodeURIComponent`, because it escapes `@` and that breaks an
 * email. Echo does not unescape a path parameter — it routes on the raw path and
 * hands the handler exactly the bytes that were sent — so `bob%40example.com`
 * arrives at `deleteMember` as that literal string, `mail.ParseAddress` refuses
 * it, and `unshare` answers `invalid_email` for a perfectly good address. `gg`
 * does not have this bug because Go's `url.PathEscape` leaves `@` alone, and
 * this is that rule: the sub-delimiters below are the ones RFC 3986 permits
 * unescaped inside a segment.
 *
 * Everything that would change the shape of the URL is still escaped — a slash,
 * a question mark, a hash, a semicolon, a comma, a space — so a name that tried
 * to climb out of its segment cannot.
 */
const seg = (s: string) =>
  encodeURIComponent(s).replace(/%(?:40|24|26|2B|3D|3A)/g, (m) => decodeURIComponent(m));

type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

/**
 * One rendering of an answer, and it is the engine's own JSON.
 *
 * Deliberately not a table, a summary or a sentence of our own. The engine
 * already writes the prose that matters — every service, ledger line and
 * connection carries a `sentence` field written there precisely so a terminal
 * and a dashboard cannot describe the same row differently — and a third
 * renderer here would be a third opinion to keep in step. What a model needs is
 * the facts in a shape it can branch on, which is what this is.
 */
function ok(value: unknown): ToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }] };
}

/**
 * A failure, in the shape `gg` prints it: `[code] message` and a `hint:` line.
 *
 * isError rather than a thrown exception, so the model sees the code and can act
 * on it. A protocol-level error would reach the client as a transport fault and
 * lose the one thing worth having.
 */
function fail(err: unknown): ToolResult {
  if (err instanceof ApiFailure) {
    return { content: [{ type: 'text', text: err.render() }], isError: true };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: `[internal] ${message}` }], isError: true };
}

/** Run a tool body, and turn any gagarin failure into the contract above. */
async function attempt(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

/*
  Annotations: the five hints a client reads before it decides whether to ask a
  human, and the Connectors Directory requires them.

  Every field is set on every tool, deliberately, because the spec's defaults
  are the wrong answer here in three places at once: `destructiveHint` defaults
  **true**, `openWorldHint` defaults **true**, and `idempotentHint` defaults
  false. A tool that leaves them out is therefore presumed to be an open-world
  destroyer — which would make an agent stop and ask on every `deploy`, and
  that is the product.

  `openWorldHint` is false on all of them. Every tool here acts inside one
  gagarin account; none of them reaches an unbounded external world.
*/

type Annotations = {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

/** A read. Changes nothing, so asking it twice is asking it once. */
const reads = (title: string): Annotations => ({
  title,
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

/** A write that only ever adds or restates. Nothing is lost by making it. */
const writes = (title: string, o: { idempotent: boolean }): Annotations => ({
  title,
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: o.idempotent,
  openWorldHint: false,
});

/** A write that takes something away, and cannot simply be undone by calling
 *  its opposite. */
const destroys = (title: string, o: { idempotent: boolean }): Annotations => ({
  title,
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: o.idempotent,
  openWorldHint: false,
});

/**
 * The tools gagarin's own API refuses with `approval_required`.
 *
 * Not a guess and not a restatement of the tool list: this is the engine's
 * `requireElevation` call sites, one per line, and it is the whole set — there
 * are five of them in the API and `destroyRow` serves two tools:
 *
 *   api.go deleteProject      → destroy_project
 *   api.go destroyRow         → destroy_service, destroy_resource
 *   domains.go deleteDomain   → remove_domain
 *   connections.go setNeeds   → set_deps, when the new set drops an edge
 *   ownership.go postTransfer → transfer
 *
 * Every one of these must be `destructiveHint: true`, and tools.test.ts asserts
 * it against this table rather than against a list of its own. Two of them read
 * as ordinary writes and are not — `set_deps` withdrawing an edge and
 * `transfer` handing over the bill both stop dead and mail the owner — and the
 * annotation is the only place an agent learns that before it calls.
 *
 * `set_deps` is here on the worst case, because an annotation is static and the
 * refusal is not: a set that only adds goes straight through.
 */
export const APPROVAL_REQUIRED: ReadonlySet<string> = new Set([
  'destroy_project',
  'destroy_resource',
  'destroy_service',
  'remove_domain',
  'set_deps',
  'transfer',
]);

/**
 * Destructive, and yet no human is asked. Named so the invariant above can be
 * stated as a subset rather than an equality, and so that neither of these
 * carries the sentence about the emailed button — they would be promising a
 * pause that never comes.
 *
 * `revoke_credential` stops a credential working the moment it is called, and
 * `rotate_resource` invalidates the old credentials irreversibly. Both are
 * destructive to an agent's eye and neither goes through `requireElevation`.
 */
export const DESTRUCTIVE_WITHOUT_APPROVAL: ReadonlySet<string> = new Set([
  'revoke_credential',
  'rotate_resource',
]);

const project = z.string().describe('project name or id');
const service = z.string().describe('service name, unique within the project');
const resource = z.string().describe('resource name, unique within the project');

export function registerTools(server: McpServer, api: Api): void {
  // ─── orientation ─────────────────────────────────────────────────────────

  server.registerTool(
    'whoami',
    {
      title: 'Show current account',
      description:
        'Which gagarin account this server is acting as, what the credential may do, and the ' +
        'registry and base domain to build addresses from. Run this first in any session: it is ' +
        'the one call that distinguishes "no credential" from "a credential that cannot deploy".',
      inputSchema: {},
      annotations: reads('Show current account'),
    },
    () => attempt(() => api.call('/v1/whoami')),
  );

  server.registerTool(
    'platform_health',
    {
      title: 'Check platform health',
      description:
        'The platform\'s own readiness, unauthenticated. Answers whether the control plane can ' +
        'reach its database and cluster and when the reconciler last ran — not whether your ' +
        'service is up, which is `status`.',
      inputSchema: {},
      annotations: reads('Check platform health'),
    },
    () => attempt(() => api.call('/healthz/platform', { authenticated: false, timeoutMs: 15_000 })),
  );

  // ─── projects ────────────────────────────────────────────────────────────

  server.registerTool(
    'projects',
    {
      title: 'List projects',
      description:
        'Projects this account owns or has been shared with, and the role on each. A `viewer` ' +
        'role means every deploy will be refused, which is worth knowing before the attempt. ' +
        'Names are unique only within one account, so two rows can share a name — the id tells ' +
        'them apart, and every other tool takes either.',
      inputSchema: {},
      annotations: reads('List projects'),
    },
    () => attempt(() => api.call('/v1/projects')),
  );

  server.registerTool(
    'create_project',
    {
      title: 'Create project',
      description:
        'A project is the unit of naming, access and billing: everything else lives inside one. ' +
        'Returns its id, which is what image paths are built from.',
      inputSchema: {
        name: z
          .string()
          .describe('2-30 chars, lowercase letters, digits and hyphens, starting with a letter'),
      },
      annotations: writes('Create project', { idempotent: false }),
    },
    ({ name }) => attempt(() => api.call('/v1/projects', { method: 'POST', body: { name } })),
  );

  server.registerTool(
    'status',
    {
      title: 'Show project status',
      description:
        'The only call that reads the cluster, and so the only one that can answer "is it up". ' +
        'Every write on this server is asynchronous — a tool that returns without error recorded ' +
        'a demand, it did not watch it come true — so this is what you check afterwards. Carries ' +
        'every service and resource, its addresses, its size, whether it is in sync, and what the ' +
        'project has cost since midnight UTC. A job has none of the service vocabulary — no ' +
        'ready count, no port, no address — and carries its latest run instead: which revision, ' +
        'what phase, how long it took and the exit code. That is the only way to learn how a ' +
        '`run` ended. It does not carry a resource\'s environment: what a resource publishes by ' +
        'name is `resource_keys`, and the values are `resource_secrets`.',
      inputSchema: { project },
      annotations: reads('Show project status'),
    },
    ({ project }) => attempt(() => api.call(`/v1/projects/${seg(project)}/status`)),
  );

  server.registerTool(
    'eject',
    {
      title: 'Export project manifests',
      description:
        'The Kubernetes manifests, Dockerfiles and connection details for a whole project, so it ' +
        'can be run somewhere else. Owner only: what comes back includes every service\'s ' +
        'environment in the clear.',
      inputSchema: { project },
      annotations: reads('Export project manifests'),
    },
    ({ project }) => attempt(() => api.call(`/v1/projects/${seg(project)}/eject`)),
  );

  // ─── services ────────────────────────────────────────────────────────────

  server.registerTool(
    'deploy',
    {
      title: 'Deploy service',
      description:
        'Declares what a service should be. **The image must already be in gagarin\'s own ' +
        'registry** under this project — gagarin runs nothing else — and this server cannot put ' +
        'it there: building and pushing need docker and the source, so they happen on a machine, ' +
        'with `gg ship` (build, push and deploy in one) or `gg build` + `gg push` in CI. Use this ' +
        'tool to deploy an image that exists: a new tag CI pushed, or a restatement. For an image ' +
        'that runs to completion rather than listening — a migration, a backfill — that is `run`, ' +
        'and the two cannot be swapped: deploying over a job is refused `not_a_service`.\n' +
        'Three rules the shape of this call depends on. **Env is replaced wholesale**, so restate ' +
        'every variable on every deploy — the domain, the size and the dependencies all survive a ' +
        'deploy that forgets to mention them. That also means you cannot change one variable ' +
        'without holding them all: if you were not given the environment, do NOT reconstruct it ' +
        'from `history` and redeploy — that drops anything you misread and pulls every secret the ' +
        'service holds through this conversation. Put the value in an `external` resource ' +
        'instead, where `rotate_resource` changes one key on its own. **A volume must be ' +
        'restated too**, and for the ' +
        'opposite reason: it cannot be changed, so a service that has one is refused ' +
        '`volume_immutable` unless `volume_path` and `volume_size_gb` come back exactly as ' +
        '`status` reports them. And a deploy neither gives an address nor takes one away: that is ' +
        '`add_domain`. A service is private until it has one, and a private service is reachable ' +
        'only by services that declared they need it.',
      inputSchema: {
        project,
        service,
        image: z
          .string()
          .describe(
            'full reference in gagarin\'s registry, e.g. registry.gagarin.cloud/<project-id>/web:v3. ' +
              '`whoami` gives the registry host and `projects` the id.',
          ),
        port: z.number().int().describe('the TCP port the container listens on'),
        env: z
          .record(z.string())
          .optional()
          .describe('the complete environment. Absent empties it — this field is not merged.'),
        digest: z
          .string()
          .optional()
          .describe('sha256:... as docker push reported it, pinning the exact image'),
        size: z
          .string()
          .optional()
          .describe('CPU and memory envelope. Absent keeps whatever it already had.'),
        volume_path: z
          .string()
          .optional()
          .describe(
            'absolute directory inside the container that survives a restart. Fixed at the deploy ' +
              'that creates the service and never changeable — which means every later deploy of ' +
              'that service must repeat it unchanged, or be refused `volume_immutable`.',
          ),
        volume_size_gb: z
          .number()
          .int()
          .optional()
          .describe('how big that volume may get. Fixed and repeated with `volume_path`, above.'),
        deps: z
          .array(z.string())
          .optional()
          .describe(
            'services and resources this one may reach, added to whatever it already declares. ' +
              'Adds and never removes — use `set_deps` to withdraw one. Here so a service that ' +
              'needs a database can be deployed holding its credentials from the first pod.',
          ),
      },
      annotations: writes('Deploy service', { idempotent: true }),
    },
    ({ project, service, ...body }) =>
      attempt(() =>
        api.call(`/v1/projects/${seg(project)}/services/${seg(service)}`, {
          method: 'PUT',
          body,
        }),
      ),
  );

  // ─── jobs ────────────────────────────────────────────────────────────────
  //
  // A job is the same row, the same write gate and the same history as a
  // service — `kind` is the whole difference — so it gets one tool of its own and
  // then shares `status`, `logs`, `history` and `rollback` with everything else.
  // A second family of tools duplicating those four would be four more places for
  // the two to drift apart.

  server.registerTool(
    'run',
    {
      title: 'Run job',
      description:
        'Submits a **job**: an image that runs, exits, and is done — a migration, a backfill, a ' +
        'one-off script. Not a service. It has no port and no volume, nothing can be told to ' +
        'reach it, and it is never restarted by the platform: a script that exits non-zero is ' +
        'reported as having failed, once, with its code.\n' +
        'Like `deploy`, the image must already be in gagarin\'s registry and this server cannot ' +
        'put it there. **And like `deploy`, this returns without waiting.** It answers a ' +
        '`revision`, which is the run\'s name; `status` reports that run\'s phase and exit code, ' +
        'and `logs` reads it. There is no tool here that blocks until a run finishes — `gg run` ' +
        'does that on a machine, exiting with the script\'s own code, which is what CI wants.\n' +
        'Calling this again is the next run, not a restatement: each one is a new revision, and ' +
        'the three most recent are kept so the previous run\'s logs survive. A name that is ' +
        'already a service is refused `not_a_job` — the two are not two states of one thing.',
      inputSchema: {
        project,
        service: z.string().describe('job name, unique within the project among services too'),
        image: z
          .string()
          .describe(
            'full reference in gagarin\'s registry, e.g. registry.gagarin.cloud/<project-id>/migrate:v3',
          ),
        env: z
          .record(z.string())
          .optional()
          .describe('the complete environment for this run. Absent empties it — not merged.'),
        digest: z
          .string()
          .optional()
          .describe('sha256:... as docker push reported it, pinning the exact image'),
        size: z
          .string()
          .optional()
          .describe('CPU and memory envelope. A job is billed for the time it runs, at this size.'),
        deps: z
          .array(z.string())
          .optional()
          .describe(
            'resources and services this run may reach while it runs, added to whatever it ' +
              'already declares. A migration needs its database named here, or its connection ' +
              'hangs rather than failing.',
          ),
      },
      annotations: writes('Run job', { idempotent: false }),
    },
    ({ project, service, ...body }) =>
      attempt(() =>
        api.call(`/v1/projects/${seg(project)}/services/${seg(service)}`, {
          method: 'PUT',
          body: { ...body, kind: 'job' },
        }),
      ),
  );

  server.registerTool(
    'logs',
    {
      title: 'Show logs',
      description:
        'The last 200 lines from a service, or from a job\'s latest run. A tail, not a stream — ' +
        'there is no more, and for a job there is no way to read a run older than the last one.',
      inputSchema: { project, service },
      annotations: reads('Show logs'),
    },
    ({ project, service }) =>
      attempt(() => api.call(`/v1/projects/${seg(project)}/services/${seg(service)}/logs`)),
  );

  server.registerTool(
    'history',
    {
      title: 'Show deploy history',
      description:
        'Each recorded revision with its image, port, environment and the dependencies it ran ' +
        'under. `revision` is what `rollback` takes — and for a job it is also what each run was ' +
        'called, so this is the list of runs.',
      inputSchema: { project, service },
      annotations: reads('Show deploy history'),
    },
    ({ project, service }) =>
      attempt(() => api.call(`/v1/projects/${seg(project)}/services/${seg(service)}/deployments`)),
  );

  server.registerTool(
    'rollback',
    {
      title: 'Roll back to a revision',
      description:
        'Deploys a revision this service already ran. No human approval, because it restores a ' +
        'state that was already approved once; it refuses to cross a change of volume. Rolling a ' +
        'job back is not a restoration but a **re-run** of that earlier image, under a new ' +
        'revision — so only ask for one if running it twice is safe. ' +
        'It restores the image and the environment of the deploy, and NOT the variables the ' +
        'service inherits from resources it needs — those are resolved from the graph as it ' +
        'stands now, so a rollback never puts a service back onto a rotated password. **To undo a ' +
        'config change, roll back the external resource holding it, not its dependents**: name ' +
        'the resource here and every service declaring it is restarted with the restored values. ' +
        'An external can be rolled back because its values are the user\'s; a postgres, qdrant or ' +
        'valkey cannot, because gagarin mints those and there is no earlier value of theirs to ' +
        'return to.',
      inputSchema: {
        project,
        service: service.describe(
          'the service to roll back — or the name of an external resource, to put its previous ' +
            'values back across everything that declares it.',
        ),
        to: z
          .number()
          .int()
          .optional()
          .describe('the revision from `history`. Absent means the previous one.'),
      },
      annotations: writes('Roll back to a revision', { idempotent: true }),
    },
    ({ project, service, to }) =>
      attempt(() =>
        api.call(`/v1/projects/${seg(project)}/services/${seg(service)}/rollback`, {
          method: 'POST',
          body: { to: to ?? 0 },
        }),
      ),
  );

  server.registerTool(
    'add_domain',
    {
      title: 'Add domain',
      description:
        'With no domain, hands out gagarin\'s own generated address and the certificate is already ' +
        'held. With one, claims that name — and the answer says what DNS record the owner has to ' +
        'add before it can be issued. Both are idempotent; restating one repairs its ingress. A ' +
        'service is private until this call and a deploy can neither give an address nor take one ' +
        'away.',
      inputSchema: {
        project,
        service,
        domain: z
          .string()
          .optional()
          .describe('a hostname you control, e.g. shop.example.com. Absent asks for the generated one.'),
      },
      annotations: writes('Add domain', { idempotent: true }),
    },
    ({ project, service, domain }) =>
      attempt(() =>
        api.call(`/v1/projects/${seg(project)}/services/${seg(service)}/domain`, {
          method: 'PUT',
          body: { domain: domain ?? '' },
        }),
      ),
  );

  server.registerTool(
    'remove_domain',
    {
      title: 'Remove domain',
      description:
        'With a domain, releases that custom name. With none, takes the service off the internet ' +
        'entirely — which is refused while a custom name still points at it, since that would ' +
        'leave somebody\'s DNS aimed at a host gagarin no longer serves. Releasing a custom name ' +
        'cannot be undone if somebody else claims it in the meantime. ' +
        'Expect `approval_required`: the call completes only when the account owner clicks the ' +
        'button emailed to them, so explain the pause to your user instead of retrying.',
      inputSchema: {
        project,
        service,
        domain: z.string().optional().describe('the custom name to release. Absent means the generated address.'),
      },
      annotations: destroys('Remove domain', { idempotent: true }),
    },
    ({ project, service, domain }) =>
      attempt(() =>
        api.call(
          `/v1/projects/${seg(project)}/services/${seg(service)}/domain` +
            (domain ? `?domain=${seg(domain)}` : ''),
          { method: 'DELETE' },
        ),
      ),
  );

  server.registerTool(
    'deps',
    {
      title: 'Show dependencies',
      description:
        'Its outgoing edges, what depends on it, and how the graph got that way. A private ' +
        'service is default-denied: until the **caller** declares the edge, its calls are dropped, ' +
        'which hangs rather than failing fast — so this is the first thing to read when something ' +
        'times out talking to something else in the same project.',
      inputSchema: { project, service },
      annotations: reads('Show dependencies'),
    },
    ({ project, service }) =>
      attempt(() => api.call(`/v1/projects/${seg(project)}/services/${seg(service)}/needs`)),
  );

  server.registerTool(
    'set_deps',
    {
      title: 'Set dependencies',
      description:
        'Replaces the complete set of things this service may reach. **An empty list disconnects ' +
        'this service from everything** — the graph is the firewall, so passing `[]` cuts every ' +
        'connection it has, and that is a real request rather than a no-op. It is reversible by ' +
        'another `set_deps` naming the edges again. Declaring a resource opens the route **and** ' +
        'hands over its connection variables, so connecting a database is this one call and not ' +
        'a call plus a deploy — the dependents roll on their own. To add without risking a ' +
        'withdrawal, pass `deps` on `deploy` instead.\n' +
        'A set that drops an edge this service currently holds **needs a human**: it answers ' +
        '`approval_required` and emails the owner, exactly as deleting a service does. A set that ' +
        'only adds goes through. Read `deps` first and send that list plus your additions, or you ' +
        'will ask somebody to approve a withdrawal you did not mean — and a withdrawal is the one ' +
        'change that reports nothing at runtime: the calls are dropped, not refused, so the far ' +
        'end hangs until it times out. Expect `approval_required`: the call completes only when ' +
        'the account owner clicks the button emailed to them, so explain the pause to your user ' +
        'instead of retrying.\n' +
        'A job may need things, and nothing may need a job: an edge is a rule about a port and a ' +
        'job has none, so naming one here is refused. If a job and a service share data, that is ' +
        'a resource they both need.',
      inputSchema: {
        project,
        service,
        needs: z
          .array(z.string())
          .describe('the complete list of services and resources this one may reach'),
      },
      annotations: destroys('Set dependencies', { idempotent: true }),
    },
    ({ project, service, needs }) =>
      attempt(() =>
        api.call(`/v1/projects/${seg(project)}/services/${seg(service)}/needs`, {
          method: 'PUT',
          body: { needs },
        }),
      ),
  );

  // ─── resources ───────────────────────────────────────────────────────────

  server.registerTool(
    'add_resource',
    {
      title: 'Add resource',
      description:
        'Something gagarin runs on your behalf — a database, a cache, a vector store — or an ' +
        '`external`, a row that runs nothing and only publishes values. You name it and say ' +
        'how big; the platform decides the rest. If a type exists, use it rather than deploying ' +
        'your own; the refusal from an unknown type names the ones there are. Nothing reaches it ' +
        'until a service declares it in `deps`. ' +
        '**Use an `external` for third-party credentials AND for shared configuration** — a ' +
        'feature flag, a log level, a region, an API base URL — anything more than one service ' +
        'reads, or that should change without a deploy. An env passed to a deploy is a copy, so ' +
        'two services sharing a setting is two copies that can disagree and two deploys to change ' +
        'it; an external is one row, changed with `rotate_resource` (`set`/`unset` for one key), ' +
        'undone with `rollback`, and every holder is restarted for it. Config owned by a single ' +
        'service stays in its deploy env, because that is the half a service rollback restores. ' +
        '**The decisive difference when you do not have the user\'s env file:** a service\'s ' +
        'environment can only be changed by `deploy`, which replaces it wholesale, so changing one ' +
        'variable means having all of them. An external takes a single key. If a user asks you to ' +
        'change a setting and you were not given their environment, an external is the answer — ' +
        'and if that setting currently lives in a deploy env, say so and offer to move it. ' +
        'Keys are published under the resource name — `config` holding LOG_LEVEL publishes ' +
        'CONFIG_LOG_LEVEL — so name the resource for how the application wants to read it.',
      inputSchema: {
        project,
        resource,
        type: z.string().describe('what to provision, e.g. postgres, valkey, qdrant or external'),
        size: z.string().optional().describe('the same envelope word a service takes. Changeable later.'),
        storage_gb: z
          .number()
          .int()
          .optional()
          .describe('how big its volume may get. Fixed at creation, like every volume.'),
        env: z
          .record(z.string())
          .optional()
          .describe(
            'the values an `external` publishes to whatever declares it. Refused for every other ' +
              'type, whose credentials are gagarin\'s to mint rather than yours to choose.',
          ),
      },
      annotations: writes('Add resource', { idempotent: true }),
    },
    ({ project, resource, ...body }) =>
      attempt(() =>
        api.call(`/v1/projects/${seg(project)}/resources/${seg(resource)}`, {
          method: 'PUT',
          body,
        }),
      ),
  );

  server.registerTool(
    'resource_keys',
    {
      title: 'List resource keys',
      description:
        'The variable names a resource publishes to whatever declares it — and no values. ' +
        '**Prefer this over `resource_secrets` unless you actually need a value.** It answers the ' +
        'question you usually have: what is in this bundle, and what is a key called, before you ' +
        'change one of them with `rotate_resource` — an external might publish API_KEY or TOKEN ' +
        'and only this says which. The values are never fetched, so nothing secret enters this ' +
        'conversation; `status` will not tell you either, since it reports only that the resource ' +
        'publishes NAME_*.',
      inputSchema: { project, resource },
      annotations: reads('List resource keys'),
    },
    ({ project, resource }) =>
      attempt(() => api.call(`/v1/projects/${seg(project)}/resources/${seg(resource)}/keys`)),
  );

  server.registerTool(
    'resource_secrets',
    {
      title: 'Show resource secrets',
      description:
        'The host, port, user, password and URL a client would need. For reading, and for ' +
        'something outside the project: a service inside it should declare the resource in `deps` ' +
        'instead, which hands the same values over without anybody copying a password. ' +
        '**This returns live credentials into this conversation, so call it only when a value is ' +
        'what you need** — to hand a connection string to something outside the project, or to ' +
        'verify a rotation. If you only need to know what the resource publishes, or what a key ' +
        'is called, that is `resource_keys` and it returns no values.',
      inputSchema: { project, resource },
      annotations: reads('Show resource secrets'),
    },
    ({ project, resource }) =>
      attempt(() => api.call(`/v1/projects/${seg(project)}/resources/${seg(resource)}/secrets`)),
  );

  server.registerTool(
    'rotate_resource',
    {
      title: 'Rotate resource credentials',
      description:
        'New credentials, and everything holding them rolls to pick them up. For an `external` ' +
        'the new values are yours to supply and required; for everything else they are gagarin\'s ' +
        'to mint and supplying them is refused. An `external` usually holds several values, and ' +
        'there are two ways to change them: `set`/`unset` change the keys you name and leave the ' +
        'rest exactly as they are, while `env` says the bundle is now precisely this and drops ' +
        'every key not in it. **Reach for `set` when one key is being replaced** — `env` with a ' +
        'single key would take the others away from every dependent. The answer names what ' +
        'changed and what stopped being published, so read `removed` before reporting success.',
      inputSchema: {
        project,
        resource,
        env: z
          .record(z.string())
          .optional()
          .describe(
            'everything the resource should publish from now on, replacing what is there. ' +
              'Required for an `external` unless set/unset is given, refused for every other type. ' +
              'Anything omitted stops being published.',
          ),
        set: z
          .record(z.string())
          .optional()
          .describe(
            'change these values and leave every other key alone. What to use when one secret of ' +
              'several is being rotated. `external` only, and not combinable with env.',
          ),
        unset: z
          .array(z.string())
          .optional()
          .describe(
            'stop publishing these keys, named without the resource prefix. Refused if the ' +
              'resource does not publish one of them, so a mistyped name fails rather than ' +
              'silently doing nothing. `external` only, and not combinable with env.',
          ),
      },
      annotations: destroys('Rotate resource credentials', { idempotent: false }),
    },
    ({ project, resource, env, set, unset }) =>
      attempt(() =>
        api.call(`/v1/projects/${seg(project)}/resources/${seg(resource)}/rotate`, {
          method: 'POST',
          // Sent as given, including the combination the engine refuses. The
          // server owns that rule and states it in a sentence a model can act
          // on; a second copy here would be one more place for it to drift, and
          // dropping half the request to make it valid would be worse than
          // either — the caller would be told a rotation succeeded that was not
          // the one they asked for.
          body: {
            ...(env ? { env } : {}),
            ...(set ? { set } : {}),
            ...(unset ? { unset } : {}),
          },
        }),
      ),
  );

  server.registerTool(
    'backups',
    {
      title: 'List backups',
      description:
        'Every stored backup of a resource, newest last. Keys are UTC timestamps, so they sort ' +
        'chronologically, and one is what `restore_resource` takes for an exact point.',
      inputSchema: { project, resource },
      annotations: reads('List backups'),
    },
    ({ project, resource }) =>
      attempt(() => api.call(`/v1/projects/${seg(project)}/resources/${seg(resource)}/backups`)),
  );

  server.registerTool(
    'backup_resource',
    {
      title: 'Back up resource',
      description:
        'A snapshot at this moment, on top of the nightly ones. Rate limited, so do not call it ' +
        'in a loop.',
      inputSchema: { project, resource },
      annotations: writes('Back up resource', { idempotent: false }),
    },
    ({ project, resource }) =>
      attempt(() =>
        api.call(`/v1/projects/${seg(project)}/resources/${seg(resource)}/backups`, {
          method: 'POST',
          timeoutMs: 300_000,
        }),
      ),
  );

  server.registerTool(
    'restore_resource',
    {
      title: 'Restore backup into a new resource',
      description:
        'Fills a **new** resource from another one\'s backup and never overwrites anything — ' +
        'which is why it needs no approval and cannot lose data.\n' +
        'Three calls, in this order, and the first two are not optional: `add_resource` to create ' +
        'the destination with the same type as the source, `status` until it is running, then this. ' +
        'A restore into a name that does not exist answers `no_such_resource`, and one into a ' +
        'resource that exists but has not come up yet answers `restore_failed` — the data is ' +
        'loaded *into* a live resource, not conjured as one.\n' +
        '`resource` is that new name; `source` is the resource whose newest backup to take, or ' +
        '`backup` is one exact key from `backups`. Point the dependents at the new name with ' +
        '`set_deps` once you have checked it.',
      inputSchema: {
        project,
        resource: z
          .string()
          .describe(
            'the new resource to fill. Create it with `add_resource` and wait for `status` to ' +
              'show it running before calling this.',
          ),
        source: z.string().optional().describe('the resource whose newest backup to use'),
        backup: z.string().optional().describe('one exact key from `backups`, for a specific point in time'),
      },
      annotations: writes('Restore backup into a new resource', { idempotent: false }),
    },
    ({ project, resource, source, backup }) =>
      attempt(() =>
        api.call(`/v1/projects/${seg(project)}/resources/${seg(resource)}/restore`, {
          method: 'POST',
          body: { ...(source ? { source } : {}), ...(backup ? { backup } : {}) },
          timeoutMs: 300_000,
        }),
      ),
  );

  // ─── people ──────────────────────────────────────────────────────────────

  server.registerTool(
    'members',
    {
      title: 'List project members',
      description:
        'The owner and everyone it has been shared with, plus a pending offer of ownership when ' +
        'there is one. The owner is a property of the project rather than a row in the list: one ' +
        'account pays, and that is not a role granted or revoked — it moves only through `transfer`.',
      inputSchema: { project },
      annotations: reads('List project members'),
    },
    ({ project }) => attempt(() => api.call(`/v1/projects/${seg(project)}/members`)),
  );

  server.registerTool(
    'share',
    {
      title: 'Share project',
      description:
        'Grants a role on a project, or changes one somebody already has. An `editor` can do ' +
        'everything the owner can except be billed for it; a `viewer` reads.',
      inputSchema: {
        project,
        email: z.string().describe('their email address'),
        role: z.string().describe('editor or viewer'),
      },
      annotations: writes('Share project', { idempotent: true }),
    },
    ({ project, email, role }) =>
      attempt(() =>
        api.call(`/v1/projects/${seg(project)}/members`, { method: 'PUT', body: { email, role } }),
      ),
  );

  server.registerTool(
    'unshare',
    {
      title: 'Unshare project',
      description: 'Removes somebody from a project. The owner cannot be removed.',
      inputSchema: { project, email: z.string().describe('their email address') },
      annotations: writes('Unshare project', { idempotent: true }),
    },
    ({ project, email }) =>
      attempt(() =>
        api.call(`/v1/projects/${seg(project)}/members/${seg(email)}`, { method: 'DELETE' }),
      ),
  );

  server.registerTool(
    'transfer',
    {
      title: 'Transfer project ownership',
      description:
        'Offers ownership to somebody the project is already shared with. This does not hand it ' +
        'over: it emails them, and the project moves only when they press the button, which may ' +
        'be days later or never. Two humans are involved — the owner is asked to approve the ' +
        'offer in their own inbox first (`approval_required`), and the recipient accepts in ' +
        'theirs. When it lands, the previous owner stays on as an editor and nothing restarts. ' +
        'Never call this unless the user has asked for the project to change hands. Expect ' +
        '`approval_required`: the call completes only when the account owner clicks the button ' +
        'emailed to them, so explain the pause to your user instead of retrying.',
      inputSchema: {
        project,
        email: z.string().describe('their email address; they must already be a member'),
        name: z
          .string()
          .optional()
          .describe('what to call it in their account, if they already have one by this name'),
      },
      annotations: destroys('Transfer project ownership', { idempotent: true }),
    },
    ({ project, email, name }) =>
      attempt(() =>
        api.call(`/v1/projects/${seg(project)}/transfer`, {
          method: 'POST',
          body: { email, name: name ?? '' },
        }),
      ),
  );

  server.registerTool(
    'untransfer',
    {
      title: 'Withdraw ownership offer',
      description:
        'Withdraws an offer that has not been accepted, and kills the link in the recipient\'s ' +
        'inbox. There is no undoing one that has been accepted: the project is theirs, and only ' +
        'they can offer it back.',
      inputSchema: { project },
      annotations: writes('Withdraw ownership offer', { idempotent: true }),
    },
    ({ project }) =>
      attempt(() => api.call(`/v1/projects/${seg(project)}/transfer`, { method: 'DELETE' })),
  );

  // ─── money ───────────────────────────────────────────────────────────────

  server.registerTool(
    'billing',
    {
      title: 'Show billing',
      description:
        'Balance, burn rate and runway — how long what is running now can keep running. A ' +
        'suspended account refuses every deploy, and a runway measured in hours is worth telling ' +
        'your human about before it becomes an outage.',
      inputSchema: {},
      annotations: reads('Show billing'),
    },
    () => attempt(() => api.call('/v1/billing')),
  );

  server.registerTool(
    'billing_history',
    {
      title: 'Show billing history',
      description:
        'The rows the balance is folded from: metered usage every quarter hour, top-ups, credits ' +
        'and adjustments. Each carries a sentence written by the engine and an amount already ' +
        'rendered, so nothing here needs re-computing.',
      inputSchema: {},
      annotations: reads('Show billing history'),
    },
    () => attempt(() => api.call('/v1/billing/history')),
  );

  // ─── credentials ─────────────────────────────────────────────────────────

  server.registerTool(
    'credentials',
    {
      title: 'List credentials',
      description:
        'Every credential, what it may do, when it was last used and when it expires. The one ' +
        'making this very call is marked `current`.',
      inputSchema: {},
      annotations: reads('List credentials'),
    },
    () => attempt(() => api.call('/v1/credentials')),
  );

  server.registerTool(
    'create_credential',
    {
      title: 'Create credential',
      description:
        'Issues a second credential from this one, for a pipeline that has no inbox to approve ' +
        'anything with. It can deploy and nothing else, it expires, and it cannot mint another — ' +
        'none of which are parameters. The secret comes back once and is never readable again, so ' +
        'put it straight into the secret store it is for. A credential that was itself minted ' +
        'cannot call this.',
      inputSchema: {
        name: z
          .string()
          .describe(
            'what you will read months from now when deciding whether this is still wanted, ' +
              'e.g. "github actions: acme/web"',
          ),
        expires_in_days: z.number().int().optional().describe('1 to 365. Absent takes the default.'),
      },
      annotations: writes('Create credential', { idempotent: false }),
    },
    ({ name, expires_in_days }) =>
      attempt(() =>
        api.call('/v1/credentials', {
          method: 'POST',
          body: { name, ...(expires_in_days ? { expires_in_days } : {}) },
        }),
      ),
  );

  server.registerTool(
    'revoke_credential',
    {
      title: 'Revoke credential',
      description: 'Stops a credential working immediately. `credentials` gives the id.',
      inputSchema: { id: z.number().int().describe('the id from `credentials`') },
      annotations: destroys('Revoke credential', { idempotent: true }),
    },
    ({ id }) => attempt(() => api.call(`/v1/credentials/${id}`, { method: 'DELETE' })),
  );

  // ─── deletion ────────────────────────────────────────────────────────────
  //
  // Three tools rather than one with a `kind`, because the three are three paths
  // and a dispatch here would be a place to get it wrong. All three answer
  // `approval_required` the first time and email the account owner a button;
  // calling again after the click is what actually deletes. No credential this
  // server can hold changes that — it is the one capability an agent cannot be
  // granted.

  server.registerTool(
    'destroy_service',
    {
      title: 'Destroy service',
      description:
        'Answers `approval_required` and emails the account owner a button. Call it again after ' +
        'they have clicked, within the window the hint names. Deletes the service, its ingress ' +
        'and its volume; the images stay in the registry. Jobs go the same way, taking their ' +
        'kept runs with them. Expect `approval_required`: the call completes only when the ' +
        'account owner clicks the button emailed to them, so explain the pause to your user ' +
        'instead of retrying.',
      inputSchema: { project, service },
      annotations: destroys('Destroy service', { idempotent: true }),
    },
    ({ project, service }) =>
      attempt(() =>
        api.call(`/v1/projects/${seg(project)}/services/${seg(service)}`, { method: 'DELETE' }),
      ),
  );

  server.registerTool(
    'destroy_resource',
    {
      title: 'Destroy resource',
      description:
        'Answers `approval_required` and emails the account owner a button. Call it again after ' +
        'they have clicked. **The data goes with it** — take a backup first if there is any doubt, ' +
        'and note that services still declaring it will start failing to connect. Expect ' +
        '`approval_required`: the call completes only when the account owner clicks the button ' +
        'emailed to them, so explain the pause to your user instead of retrying.',
      inputSchema: { project, resource },
      annotations: destroys('Destroy resource', { idempotent: true }),
    },
    ({ project, resource }) =>
      attempt(() =>
        api.call(`/v1/projects/${seg(project)}/resources/${seg(resource)}`, { method: 'DELETE' }),
      ),
  );

  server.registerTool(
    'destroy_project',
    {
      title: 'Destroy project',
      description:
        'Everything in it: every service, every resource, every volume, every backup. Answers ' +
        '`approval_required` and emails the account owner a button; call it again after they have ' +
        'clicked. Say plainly what will be lost before you ask for this. Expect ' +
        '`approval_required`: the call completes only when the account owner clicks the button ' +
        'emailed to them, so explain the pause to your user instead of retrying.',
      inputSchema: { project },
      annotations: destroys('Destroy project', { idempotent: true }),
    },
    ({ project }) => attempt(() => api.call(`/v1/projects/${seg(project)}`, { method: 'DELETE' })),
  );
}

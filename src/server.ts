/*
  The server itself: what it says it is, what it tells a client on connect, and
  the one document it serves.

  Built per caller rather than once per process. On stdio that is the same thing;
  over HTTP it is what keeps one request's credential out of another's, and it is
  cheap — registering the tools is building a few dozen objects, which is nothing
  beside the network call each of them makes.
*/

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { Api, VERSION } from './api.js';
import { registerTools } from './tools.js';

/**
 * What a client is told the moment it connects, before it has called anything.
 *
 * Short on purpose. These are the rules that stop an agent getting it wrong in
 * ways the API cannot report — an asynchronous write that looks synchronous, an
 * environment that looks merged, a private service that hangs instead of
 * refusing. Everything else is on the tools themselves, where it is read at the
 * moment it matters, and the long form is `gagarin://guide`.
 *
 * Deliberately not a copy of the agent skill that ships inside the `gg` binary.
 * That document is about driving a CLI on a machine with source and docker on
 * it; this one is about driving an API. Two audiences, and a copy of the first
 * pasted here would be wrong in the places they differ and stale in the rest.
 */
const INSTRUCTIONS = `Gagarin runs container images on managed infrastructure. This server is the
gagarin API, as tools. Call whoami first: it says which account you are acting
as and whether the credential can deploy.

Eight things that are true of every call here:

1. Everything is named for its project — a project, and a service or resource
   inside it. Nothing is inferred from a working directory.
2. Every write is asynchronous. A tool that returns without an error recorded a
   demand; it did not watch it come true. Only \`status\` reads the cluster, and
   it is the only thing that can answer "is it up".
3. Gagarin runs images from its own registry only, and this server cannot build
   or push one — that needs docker and the source, so it happens on a machine
   with \`gg ship\`. \`deploy\` runs an image that is already there.
4. A deploy replaces the environment and nothing else. Restate every variable
   every time; the domain, the size and the dependencies survive a deploy that
   forgets to mention them. The volume is the exception in the other direction —
   it is immutable, so a service that has one must be given the same
   \`volume_path\` and \`volume_size_gb\` on every deploy or the deploy is refused
   \`volume_immutable\`. \`status\` says what they are.
5. A service is private until \`add_domain\`, and a deploy can neither give an
   address nor take one away.
6. A private service is default-denied. Until the caller declares the edge, its
   calls are dropped — which hangs rather than failing fast. \`set_deps\` on a
   resource opens the route and hands over its credentials in one call. Taking an
   edge *away* needs a human (see 8), because it is the one change that breaks
   something and reports nothing.
7. Two kinds of thing run here. A **service** listens on a port and is expected
   to stay up; a **job** runs to completion and listens on nothing — a migration,
   a backfill. \`deploy\` makes the first, \`run\` the second, and a name is one or
   the other for good. Nothing can be told to reach a job.
8. You can deploy; you cannot take anything away. Every deletion, every released
   address, and any \`set_deps\` that drops an edge the service currently holds
   answers \`approval_required\` and emails the account owner a button. Call it
   again after they click — one click covers the fifteen minutes after it. No
   credential changes this. Adding is always free.

Errors are \`[code] message\` with a \`hint:\` line. Branch on the code, never on
the prose.`;

/** The long form, for a client that wants to read rather than be told. */
const GUIDE = `# Driving gagarin over MCP

${INSTRUCTIONS}

## What this server cannot do

Three things need a machine, and asking for them here would fail in ways that
read like a platform fault:

- **Building and pushing an image.** \`gg ship\` (build, push and deploy fused),
  \`gg build\`, \`gg push\` and \`gg registry copy\` shell out to docker where the
  source is. Install the CLI — \`brew install gagarin-cloud/tap/gg\`, or
  \`go install github.com/gagarin-cloud/gg@latest\` — and run it there. Then
  \`deploy\` here, or let \`gg ship\` do all three.
- **Opening a tunnel to a resource.** \`gg connect\` binds a local port.
- **Waiting for a job to finish.** \`run\` submits and returns, like every other
  write here. \`gg run\` blocks until the run ends and exits with the script's own
  code, which is what a pipeline wants; here you poll \`status\` for the phase and
  the exit code.
- **Clicking an approval.** That is a human with an inbox, by design.

## A first deployment, end to end

1. \`whoami\` — which account, and may it deploy. If there is no credential:
   over HTTP, the client signs your human in over OAuth when it connects (it
   opens a browser; they sign in with GitHub or Google), or sends a credential
   from \`gg login\` or \`gg creds create\` in the Authorization header. Over stdio,
   your human runs \`gg login\` on this machine, or GAGARIN_TOKEN is exported.
2. \`create_project\` — the id it returns is what image paths are built from.
3. On the machine with the source: \`gg ship <project>/<service>:<port>\`. That
   builds, pushes and deploys in one, and it is the only step that is not here.
4. \`status <project>\` — desired against actual, which is the only answer to
   "is it up".
5. \`add_domain\` — a service is private until this.

## Adding a database

1. \`add_resource\` with type \`postgres\` (or \`valkey\`, or \`qdrant\`).
2. \`set_deps\` on the service, listing the resource. That opens the route and
   hands over the connection variables; the service rolls on its own. There is
   no second call and nothing to copy by hand — \`resource_secrets\` exists for
   something *outside* the project, not for a service inside it.
3. \`status\` to watch it come up.

## Running a migration

A job, not a service — deployed as a service it would exit 0, be restarted,
and read as a crash loop while the meter ran.

1. Build and push the image on a machine: \`gg build <project>/migrate:v3 --push\`.
2. \`run\` with that image and \`deps\` naming the database. The edge has to be
   declared for this run or the first query hangs rather than failing, and it is
   the same call, so there is no window where it is not.
3. It answers a \`revision\`. That is the run's name.
4. \`status\` until the run reports a phase that is not running; it carries the
   exit code. \`logs\` reads that run. A non-zero exit is reported once and never
   retried by the platform, because nothing here can know whether running your
   script twice is safe.

\`rollback\` on a job re-runs an older image under a new revision. Only ask for
one if a second run is safe.

## When something is wrong

- A service that will not start: \`logs\`, then \`history\` to see what changed,
  then \`rollback\`.
- A job that did not do its work: \`status\` for the exit code, \`logs\` for the
  run. Only the latest run's logs are readable, so read them before running it
  again.
- A call between two services that hangs: \`deps\`. Default-denied looks like a
  timeout, not a refusal.
- A deploy refused with \`insufficient_scope\`: the credential is a browser
  session or a viewer role. \`whoami\` and \`projects\` say which.
- Everything refused with \`suspended\` or a deploy refused for money:
  \`billing\`. A runway measured in hours is worth telling your human about
  before it becomes an outage.

## Where else gagarin is

- The API this wraps: https://api.gagarin.cloud
- The CLI and its agent skill: https://github.com/gagarin-cloud/gg
- Documentation for a model: https://gagarin.cloud/llms.txt
- The console a human clicks approvals in: https://my.gagarin.cloud
`;

export function createServer(api: Api): McpServer {
  const server = new McpServer(
    {
      name: 'gagarin',
      title: 'gagarin',
      version: VERSION,
      websiteUrl: 'https://gagarin.cloud',
    },
    { instructions: INSTRUCTIONS },
  );

  server.registerResource(
    'guide',
    'gagarin://guide',
    {
      title: 'Driving gagarin over MCP',
      description:
        'The whole of what an agent needs to operate gagarin through these tools: the rules, the ' +
        'three things that still need the CLI, and the shape of a first deployment.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: GUIDE }],
    }),
  );

  registerTools(server, api);
  return server;
}

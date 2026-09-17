# mcp

**mcp.gagarin.cloud** — gagarin's API, as tools an agent can call.

```
npm install
npm run build
npm test                 # builds, then node --test over dist/
npm start                # the HTTP server on :8080
npm run stdio            # the same tools over a pipe
```

The Model Context Protocol is how an agent finds and calls a tool it was not
built with. This is gagarin's, and it exists so that adding gagarin to a coding
agent is a URL rather than an install — the one artefact that makes the platform
*installable* rather than merely documented.

Two ways in, one implementation:

| | |
|---|---|
| **remote** | `https://mcp.gagarin.cloud/mcp`, streamable HTTP, credential in the `Authorization` header — put there by OAuth sign-in or by hand |
| **local** | `npx -y @gagarin-cloud/mcp`, stdio, credential from `GAGARIN_TOKEN` or the file `gg login` wrote |

## Signing in

**Remote, with OAuth.** Give the client the URL and nothing else:

```
https://mcp.gagarin.cloud/mcp
```

Claude, ChatGPT and Claude Code prompt for sign-in when they connect: the client
opens a browser and the human signs in with GitHub or Google. A request with no
credential answers `401` with a `WWW-Authenticate` header pointing at
`/.well-known/oauth-protected-resource/mcp`, which names `api.gagarin.cloud` as
the authorization server. This server decides nothing about a token itself; the
engine does, on every call. `GAGARIN_MCP_ORIGIN` and `GAGARIN_ISSUER` override the two public
names for a development setup; they are separate from `GAGARIN_API`, which in
the cluster is the in-cluster Service and no address a client could sign in at.

**Remote, with a credential in a header.** For a client that cannot sign in
over OAuth, or a machine that should not: a credential from `gg login` or
`gg creds create`.

```jsonc
{
  "mcpServers": {
    "gagarin": {
      "type": "http",
      "url": "https://mcp.gagarin.cloud/mcp",
      "headers": { "Authorization": "Bearer <your gagarin credential>" }
    }
  }
}
```

**Local, over stdio.** `npx -y @gagarin-cloud/mcp` reads the file `gg login`
wrote, or `GAGARIN_TOKEN` if it is set.

A credential that has expired or been revoked is caught at the door too, because
a client signs in again only on an HTTP 401: every POST asks the engine
`/v1/whoami` with the caller's token first, and the engine's 401 becomes a 401
with `error="invalid_token"`. One extra in-cluster call per request, and no
cache — a remembered token is a stored token, and this server stores none. Any
other failure there (the engine unreachable, a 5xx) is not a sign-in problem, so
the request goes on and each tool reports it with the engine's own code.

## What is here

| path | what it is |
|---|---|
| `src/api.ts` | the whole of this server's contact with gagarin: one request, one error envelope |
| `src/tools.ts` | every tool — each one a path, a shape, and the rule a caller needs before using it |
| `src/server.ts` | what a client is told on connect, and the `gagarin://guide` resource |
| `src/app.ts` | mcp.gagarin.cloud: stateless streamable HTTP, one server per request, and the OAuth protected-resource metadata |
| `src/http.ts` | the listener, its configuration and its drain |
| `src/stdio.ts` | the npm package's entrypoint, for an agent on somebody's machine |
| `src/credentials.ts` | reads the credential file `gg login` wrote; never writes one |
| `Dockerfile` | the image mcp.gagarin.cloud runs. Its build stage runs the tests |

## It is a translator, and nothing else

It holds no credential of its own, has no database, and makes no decision the
API does not make. Every tool is one call to `api.gagarin.cloud` carrying the
**caller's** own bearer token, and every refusal is the engine's refusal passed
through unedited.

That is the property everything else rests on: possessing this server grants
nothing at all. It is what makes it safe to put a public endpoint in front of a
single write gate, and nothing here may be changed in a way that weakens it.

Two consequences worth stating, because both look like omissions:

- **Answers are the engine's JSON, not a summary of it.** Every service, ledger
  line and connection already carries a `sentence` written by the engine,
  precisely so a terminal and a dashboard cannot describe the same row
  differently. A third renderer here would be a third opinion to keep in step.
- **Errors are `[code] message` with a `hint:` line**, which is what `gg` prints.
  One format, so an agent that has read the gagarin skill recognises what comes
  back here without being taught a second one.

## What it deliberately cannot do

Four things need a machine, and offering them here would produce failures that
read like platform faults:

- **Build and push an image.** `gg ship` — build, push and deploy fused — shells
  out to docker where the source is. `deploy` here runs an image that is
  *already* in gagarin's registry: a tag CI pushed, or a restatement. Getting one
  there is the CLI's job.
- **Open a tunnel.** `gg connect` binds a local port.
- **Wait for a job to finish.** `run` submits and returns a revision, like every
  other write here. `gg run` blocks until the run ends and exits with the
  script's own exit code, which is what a pipeline wants; over MCP you poll
  `status` for the phase and the code.
- **Click an approval.** That is a human with an inbox, by design.

There is also no list of resource types, sizes or scopes in this repository. The
engine owns those and its refusals name them; a `z.enum` here would be a second
list in a second repository, wrong on the day a type is added — a mistake this
codebase has already made once, in `gg`, about this exact family of values.

## Where it runs

In the Kubernetes cluster, next to the control plane, and *not* on Vercel beside
the site and the console.
Those two live outside Scaleway because their job is to still be there and say
the platform is down. This one has nothing whatever to say when the API is
unreachable; it **is** that API in another shape, so it belongs next to it and
reaches it over the in-cluster Service rather than hairpinning out through the
load balancer.

The pod runs as a ServiceAccount with no RBAC and no mounted token, on a
read-only root filesystem. It needs none of them.

Every push to main builds the image and rolls it out —
`.github/workflows/deploy.yml`. The credentials that can do that are secrets of
the `production` environment, which only `main` may use, so a pull request never
runs next to them. Merging to main is deploying.

## Adding a tool

One `server.registerTool` call in `src/tools.ts`: a name, a description saying
the rule a caller most needs, a zod shape, and one `api.call`. Then a test in
`src/tools.test.ts` asserting the path, the method and the body — those are the
only things it is possible to be quietly wrong about, and a deploy that PUTs to
the wrong path answers 404 and reads like a missing service.

Do not add a tool for something the API does not do. This file has no business
being the place a feature appears first.

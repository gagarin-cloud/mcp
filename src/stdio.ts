#!/usr/bin/env node
/*
  The gagarin MCP server, on stdio, for running from a clone of this repository.

  This is what `npm run stdio` starts. It is the same tools as mcp.gagarin.cloud,
  over a pipe instead of HTTP, and it takes its credential from the file
  `gg login` already wrote, so there is nothing to configure on a machine that
  has run the CLI once.

  It is deliberately not published to npm. The remote endpoint is the way in —
  adding gagarin to an agent is a URL and not an install — and a package on
  somebody's laptop would be a second copy of the tool list, wrong on the day a
  tool changes.

  Nothing is written to stdout but protocol. Anything a human should read goes to
  stderr — a stray console.log here is a corrupted message, and it is the single
  easiest way to break a stdio server.
*/

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { Api, DEFAULT_API } from './api.js';
import { resolveCredentials } from './credentials.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const { token, api, source } = resolveCredentials();
  const base = api || DEFAULT_API;

  // Said once, on stderr, because "why does everything answer unauthorized" is
  // otherwise a question with no visible answer. The source, never the secret.
  console.error(
    `gagarin mcp: api ${base}, credential from ${source}` +
      (token
        ? ''
        : ' — ask your human to run `gg login` on this machine, or export GAGARIN_TOKEN'),
  );

  const server = createServer(new Api(base, token));
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error('gagarin mcp: could not start:', err);
  process.exit(1);
});

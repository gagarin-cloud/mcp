#!/usr/bin/env node
/*
  The gagarin MCP server, on stdio, for an agent running on somebody's machine.

  This is what `npx @gagarin-cloud/mcp` starts. It is the same tools as
  mcp.gagarin.cloud, over a pipe instead of HTTP, and it exists for two reasons
  that have nothing to do with the remote one: it takes its credential from the
  file `gg login` already wrote, so there is nothing to configure on a laptop that
  has run the CLI once; and it is on npm, which is where an agent looks.

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

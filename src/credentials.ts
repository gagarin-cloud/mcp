/*
  Where a credential comes from when this server runs on somebody's machine.

  It reads the file `gg login` already wrote and never writes one. That asymmetry
  is deliberate: the CLI owns that file — it knows how to sign a human in, how
  to write it atomically, and with what mode — and a second writer
  of one file is how two programs come to disagree about a secret. Here it is
  only ever a fallback for "the human has already authorised this machine", so
  `npx @gagarin-cloud/mcp` works on a laptop with no environment to export.

  The path is gg's own, XDG first, for the reason gg gives: agents frequently run
  in containers where HOME is something surprising, and honouring the spec makes
  that configurable.
*/

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The subset of gg's credentials.json this server has any business reading. */
type StoredCredentials = {
  api?: string;
  credential?: string;
  account?: string;
};

export function credentialsPath(): string {
  const dir = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(dir, 'gagarin', 'credentials.json');
}

/**
 * The credential and API this process should use, and where each came from.
 *
 * The environment wins over the file, which is the order CI needs: a runner that
 * exports GAGARIN_TOKEN has no home directory worth reading and must not be
 * quietly overridden by one that happens to exist.
 */
export function resolveCredentials(): {
  token: string | null;
  api: string | undefined;
  source: string;
} {
  const fromEnv = (process.env.GAGARIN_TOKEN || '').trim();
  if (fromEnv) {
    return { token: fromEnv, api: process.env.GAGARIN_API, source: 'GAGARIN_TOKEN' };
  }

  const path = credentialsPath();
  let stored: StoredCredentials;
  try {
    stored = JSON.parse(readFileSync(path, 'utf8')) as StoredCredentials;
  } catch {
    // Missing and unreadable are the same answer — there is no credential here —
    // and the tools say what to do about it far better than a startup error
    // could: every call answers `[unauthorized]` with a hint to run `gg login`.
    return { token: null, api: process.env.GAGARIN_API, source: 'nothing' };
  }

  const token = (stored.credential || '').trim();
  return {
    token: token || null,
    api: process.env.GAGARIN_API || stored.api,
    source: token ? path : 'nothing',
  };
}

/*
  server.json, the entry the official MCP registry publishes.

  A push to main that changes it publishes it (.github/workflows/registry.yml),
  and the registry refuses an entry its schema rejects only at that point —
  after the merge, in a workflow nobody is watching. So the entry is checked
  here against the same schema, vendored in schema/ so the test needs no
  network, and against the few things the schema allows that would still be
  wrong for us.

  Most directories copy their description from this entry, so the limits that
  matter for the copy are asserted too.
*/

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';

import { VERSION } from './api.js';
import { TOOLS_SNAPSHOT } from './tools.snapshot.js';

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

interface ServerJson {
  $schema: string;
  description: string;
  version: string;
  remotes: { type: string; url: string }[];
}

const entry = JSON.parse(read('server.json')) as ServerJson;

test('server.json validates against the registry schema it names', () => {
  const schema = JSON.parse(read('schema/server.schema.json')) as { $id: string };
  // The vendored copy has to be the one the entry declares, or this checks
  // the entry against a schema the registry is not using.
  assert.equal(entry.$schema, schema.$id, 're-vendor schema/server.schema.json from the URL in server.json');

  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats.default(ajv);
  const validate = ajv.compile(schema);
  assert.ok(validate(entry), ajv.errorsText(validate.errors));
});

// The schema says so too; this says it in a way that names the number when
// somebody's better sentence runs one word long.
test('the description fits the registry limit of 100 characters', () => {
  assert.ok(
    entry.description.length <= 100,
    `description is ${entry.description.length} characters: ${entry.description}`,
  );
});

test('the version is semver and the same one the server announces', () => {
  // The workflow publishes only a version the registry does not have yet, so
  // a listing change without a bump is silently not published.
  assert.match(entry.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  assert.equal(entry.version, VERSION);
});

test('the one remote is the public streamable-HTTP endpoint', () => {
  assert.deepEqual(entry.remotes, [{ type: 'streamable-http', url: 'https://mcp.gagarin.cloud/mcp' }]);
});

// The README states how many tools there are, because a directory reading it
// should get the number; a count in prose goes stale the day a tool is added.
test('the README states the real number of tools', () => {
  const count = Object.keys(TOOLS_SNAPSHOT).length;
  const stated = /as tools: (\d+) of\s+them/.exec(read('README.md'));
  assert.ok(stated, 'the README intro no longer states a tool count');
  assert.equal(Number(stated[1]), count);
});

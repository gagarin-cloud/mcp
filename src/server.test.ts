/*
  The instructions every client receives on connect.

  They go out on every connection, before the agent has asked for anything, so
  they stay short: a budget, asserted. And the one piece of behaviour they carry
  beyond the API's facts is the tour after a first address, whose order matters
  (graph, then alerts, then memory) and whose consent rule matters more, since
  alerts reach a person's phone.
*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { INSTRUCTIONS } from './server.js';

const BUDGET = 3600;

test('the instructions stay within their budget', () => {
  assert.ok(INSTRUCTIONS.length <= BUDGET, `${INSTRUCTIONS.length} characters; the budget is ${BUDGET}`);
});

test('after the first address: graph, then alerts, then memory', () => {
  const tour = INSTRUCTIONS.slice(INSTRUCTIONS.indexOf('After the first address'));
  assert.ok(tour.length < INSTRUCTIONS.length, 'the tour paragraph is missing');
  const graph = tour.indexOf('my.gagarin.cloud/projects/<id>');
  const alerts = tour.indexOf('`set_alerts`');
  const memory = tour.indexOf('`remember`');
  assert.ok(graph > 0 && alerts > graph && memory > alerts, 'steps out of order');
});

test('alerts are asked for, never switched on unasked', () => {
  assert.match(INSTRUCTIONS, /ask before `set_alerts`/);
  assert.match(INSTRUCTIONS, /one step per turn, and\s+stop if they decline/);
});

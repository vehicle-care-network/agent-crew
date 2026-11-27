// node --test scripts/setup/required.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from './required.mjs';

test('valid JSON parses to the config', () => {
  assert.deepEqual(parseConfig('{"product":"Shop","scout":{"port":3000}}'), { config: { product: 'Shop', scout: { port: 3000 } } });
});

test('invalid JSON gives a [CrewSetup] reason, not a throw', () => {
  const { config, error } = parseConfig('{"product": "Shop",}');
  assert.equal(config, undefined);
  assert.match(error, /^\[CrewSetup\] \.github\/agents\/crew\.json is not valid JSON: /);
  assert.doesNotMatch(error, /conflict/i);
});

test('conflict markers are named as the cause', () => {
  const text = '{\n<<<<<<< HEAD\n  "product": "A"\n=======\n  "product": "B"\n>>>>>>> origin/main\n}\n';
  const { error } = parseConfig(text);
  assert.match(error, /^\[CrewSetup\] \.github\/agents\/crew\.json is not valid JSON: it still has merge conflict markers/);
});

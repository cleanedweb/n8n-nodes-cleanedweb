'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { gf } = require('./helpers');
const constants = require('../dist/nodes/CleanedWeb/constants');

test('buildRunBody sends only the options that were set', () => {
	assert.deepEqual(gf.buildRunBody({ input: {} }), { input: {} });
	assert.deepEqual(
		gf.buildRunBody({
			input: { sort: 'desc_stars' },
			maxItems: 25,
			timeoutSeconds: 3600,
			waitSeconds: 90,
			fields: ['title', 'url'],
			nulls: true,
			version: 2,
		}),
		{
			input: { sort: 'desc_stars' },
			max_items: 25,
			timeout_seconds: 3600,
			wait_seconds: 90,
			fields: ['title', 'url'],
			nulls: true,
			version: 2,
		},
	);
	// nulls false is the default and is not sent
	assert.equal('nulls' in gf.buildRunBody({ input: {}, nulls: false }), false);
});

test('buildRunBody keeps wait_seconds 0 and rejects values outside the documented ranges', () => {
	assert.equal(gf.buildRunBody({ input: {}, waitSeconds: 0 }).wait_seconds, 0);
	assert.throws(() => gf.buildRunBody({ input: {}, timeoutSeconds: 59 }), /60 to 86400/);
	assert.throws(() => gf.buildRunBody({ input: {}, timeoutSeconds: 86401 }), /60 to 86400/);
	assert.throws(() => gf.buildRunBody({ input: {}, waitSeconds: -1 }), /0 to 86400/);
	assert.throws(() => gf.buildRunBody({ input: {}, maxItems: 0 }), /whole number/);
	assert.throws(() => gf.buildRunBody({ input: {}, maxItems: 1.5 }), /whole number/);
});

test('buildRunBody never combines expected_version and definition_version', () => {
	const v = 'a'.repeat(64);
	assert.equal(gf.buildRunBody({ input: {}, expectedVersion: v }).expected_version, v);
	assert.equal(gf.buildRunBody({ input: {}, definitionVersion: v }).definition_version, v);
	assert.throws(
		() => gf.buildRunBody({ input: {}, expectedVersion: v, definitionVersion: v }),
		/not both/,
	);
});

test('idempotency key grammar: 1-200 of letters, numbers, . _ : -', () => {
	assert.equal(gf.validateIdempotencyKey(' 72ad1b16-20ad:x_y.z '), '72ad1b16-20ad:x_y.z');
	assert.equal(gf.validateIdempotencyKey('a'.repeat(200)).length, 200);
	for (const bad of ['', '   ', 'a'.repeat(201), 'has space', 'slash/x', 'ü', undefined, 5]) {
		assert.throws(() => gf.validateIdempotencyKey(bad), /Idempotency Key/);
	}
});

test('the default key is an expression unique per execution, run index and item', () => {
	assert.match(constants.IDEMPOTENCY_KEY_DEFAULT, /^=\{\{ \$execution\.id \}\}/);
	assert.match(constants.IDEMPOTENCY_KEY_DEFAULT, /\$runIndex/);
	assert.match(constants.IDEMPOTENCY_KEY_DEFAULT, /\$itemIndex/);
});

test('parseInput accepts JSON text or an object and refuses anything else', () => {
	assert.deepEqual(gf.parseInput(''), {});
	assert.deepEqual(gf.parseInput(undefined), {});
	assert.deepEqual(gf.parseInput('{"a":1}'), { a: 1 });
	assert.deepEqual(gf.parseInput({ a: 1 }), { a: 1 });
	assert.throws(() => gf.parseInput('{nope'), /not valid JSON/);
	assert.throws(() => gf.parseInput('[1]'), /JSON object/);
	assert.throws(() => gf.parseInput('3'), /JSON object/);
});

test('parseFields trims, drops blanks and duplicates', () => {
	assert.deepEqual(gf.parseFields(' title, url ,,title'), ['title', 'url']);
	assert.equal(gf.parseFields(''), undefined);
	assert.equal(gf.parseFields(undefined), undefined);
});

test('normalizeOrigin: https only (http for localhost), no path', () => {
	assert.equal(gf.normalizeOrigin(''), 'https://broker.cleanedweb.com');
	assert.equal(gf.normalizeOrigin('https://broker.cleanedweb.com/'), 'https://broker.cleanedweb.com');
	assert.equal(gf.normalizeOrigin('http://localhost:8080'), 'http://localhost:8080');
	assert.throws(() => gf.normalizeOrigin('http://broker.cleanedweb.com'), /https/);
	assert.throws(() => gf.normalizeOrigin('https://broker.cleanedweb.com/v1'), /path/);
	assert.throws(() => gf.normalizeOrigin('not a url'), /not a valid URL/);
});

test('parseRetryAfter reads seconds and HTTP dates', () => {
	assert.equal(gf.parseRetryAfter({ 'retry-after': '30' }), 30);
	assert.equal(gf.parseRetryAfter({ 'Retry-After': ' 7 ' }), 7);
	assert.equal(gf.parseRetryAfter({}), undefined);
	assert.equal(gf.parseRetryAfter({ 'retry-after': 'soon' }), undefined);
	const now = Date.parse('2026-11-20T10:00:00Z');
	assert.equal(gf.parseRetryAfter({ 'retry-after': 'Fri, 20 Nov 2026 10:00:45 GMT' }, now), 45);
});

test('assertAccepted follows the documented acceptance rule', () => {
	const ok = { summary: { status: 'bounded', within_scope_passed: true }, records: [] };
	gf.assertAccepted(ok);
	gf.assertAccepted({ summary: { status: 'completed', within_scope_passed: true } });
	assert.throws(
		() => gf.assertAccepted({ summary: { status: 'partial', within_scope_passed: true }, run: { run_id: 'r', stop_reason: 'error' } }),
		/partial.*stop reason: error/,
	);
	assert.throws(() => gf.assertAccepted({ summary: { status: 'completed', within_scope_passed: false } }), /within_scope_passed/);
	assert.throws(
		() => gf.assertAccepted({ summary: { status: 'completed', within_scope_passed: true, definition_version: 'x' } }, 'y'),
		/definition_version/,
	);
	// no summary: nothing to check
	gf.assertAccepted({ records: [] });
});

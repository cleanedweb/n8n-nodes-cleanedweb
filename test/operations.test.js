'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCtx, makeDeps, fullResponse, gf } = require('./helpers');
const ops = require('../dist/nodes/CleanedWeb/Operations');

const API = 'generated_047a8ebb25911ccf62f4a212';
const EP = `${API}_search`;
const RUN = 'a'.repeat(32);
const KEY = 'exec-1-0-0';
const catalogParams = (extra = {}) => ({
	apiId: API,
	endpointId: EP,
	input: '{"sort":"desc_stars"}',
	noMaxItems: false,
	maxItems: 25,
	waitForResult: true,
	idempotencyKey: KEY,
	options: {},
	...extra,
});
const finalBody = (records, summary = {}) => ({
	records,
	summary: { status: 'bounded', within_scope_passed: true, records: records.length, ...summary },
	metadata: {},
	run: { run_id: RUN, status: 'finished', stop_reason: 'max_items' },
	delivery: { runId: RUN, recordCount: records.length },
});
const runObject = (extra = {}) => ({ run_id: RUN, status: 'running', ...extra });

test('Run Catalog Endpoint builds the documented request and returns one item per record', async () => {
	const records = [{ title: 'a' }, { title: 'b' }, { title: 'c' }];
	const ctx = makeCtx({ params: catalogParams(), broker: [fullResponse(200, finalBody(records))] });
	const { deps } = makeDeps();
	const out = await ops.startRun(ctx, 3, 'catalog', deps);
	assert.deepEqual(out.map((o) => o.json), records);
	assert.deepEqual(out.map((o) => o.pairedItem), [{ item: 3 }, { item: 3 }, { item: 3 }]);

	assert.equal(ctx.calls.broker.length, 1);
	const call = ctx.calls.broker[0];
	assert.equal(call.type, 'cleanedWebApi');
	assert.equal(call.method, 'POST');
	assert.equal(call.url, `https://api.cleanedweb.com/v1/catalog/public/apis/${API}/endpoints/${EP}/run`);
	assert.equal(call.headers['Idempotency-Key'], KEY);
	assert.deepEqual(call.body, { input: { sort: 'desc_stars' }, max_items: 25 });
	assert.equal(call.returnFullResponse, true);
	assert.equal(call.disableFollowRedirect, true);
	// the client limit outlasts the server's default 90 s wait
	assert.equal(call.timeout, 120_000);
	assert.equal(JSON.stringify(call).includes('test-key'), false, 'the key is added by n8n auth, never put in the request here');
});

test('the client timeout follows an explicit wait per request', async () => {
	const ctx = makeCtx({
		params: catalogParams({ options: { waitSeconds: 300, timeoutSeconds: 3600 } }),
		broker: [fullResponse(200, finalBody([]))],
	});
	await ops.startRun(ctx, 0, 'catalog', makeDeps().deps);
	assert.equal(ctx.calls.broker[0].timeout, 330_000);
	assert.equal(ctx.calls.broker[0].body.wait_seconds, 300);
	assert.equal(ctx.calls.broker[0].body.timeout_seconds, 3600);
});

test('a 202 is read from the catalog result route with the same key, honoring Retry-After', async () => {
	const records = [{ title: 'x' }];
	const answers = [
		fullResponse(202, runObject(), { 'retry-after': '7', location: `/v1/runs/${RUN}` }),
		fullResponse(202, runObject({ poll_after_seconds: 30 }), { 'retry-after': '3' }),
		fullResponse(200, finalBody(records)),
	];
	const ctx = makeCtx({ params: catalogParams(), broker: answers });
	const { deps, state } = makeDeps();
	const out = await ops.startRun(ctx, 0, 'catalog', deps);
	assert.deepEqual(out.map((o) => o.json), records);
	assert.deepEqual(state.sleeps, [7000, 3000]);
	// exactly one POST; the rest are GETs of /result with the same key
	assert.deepEqual(ctx.calls.broker.map((c) => c.method), ['POST', 'GET', 'GET']);
	for (const call of ctx.calls.broker.slice(1)) {
		assert.equal(call.url, `https://api.cleanedweb.com/v1/catalog/public/apis/${API}/endpoints/${EP}/result`);
		assert.equal(call.headers['Idempotency-Key'], KEY);
		assert.equal(call.body, undefined);
	}
});

test('without Retry-After the poll waits poll_after_seconds, then the fallback', async () => {
	const answers = [
		fullResponse(202, runObject({ poll_after_seconds: 12 })),
		fullResponse(202, runObject()),
		fullResponse(200, finalBody([])),
	];
	const ctx = makeCtx({ params: catalogParams({ options: { pollFallbackSeconds: 20 } }), broker: answers });
	const { deps, state } = makeDeps();
	await ops.startRun(ctx, 0, 'catalog', deps);
	assert.deepEqual(state.sleeps, [12_000, 20_000]);
});

test('a run still going at Max Wait fails with the run id; the POST is never resent', async () => {
	const ctx = makeCtx({
		params: catalogParams({ options: { maxWaitSeconds: 60 } }),
		broker: () => fullResponse(202, runObject(), { 'retry-after': '25' }),
	});
	const { deps } = makeDeps();
	await assert.rejects(ops.startRun(ctx, 0, 'catalog', deps), (error) => {
		assert.ok(error instanceof gf.RunStillRunningError);
		assert.equal(error.runId, RUN);
		return true;
	});
	assert.equal(ctx.calls.broker.filter((c) => c.method === 'POST').length, 1);
});

test('Wait for Result off returns the run object at once with wait_seconds 0', async () => {
	const ctx = makeCtx({
		params: catalogParams({ waitForResult: false, options: { waitSeconds: 90 } }),
		broker: [fullResponse(202, runObject(), { 'retry-after': '30' })],
	});
	const { deps, state } = makeDeps();
	const out = await ops.startRun(ctx, 0, 'catalog', deps);
	assert.equal(out.length, 1);
	assert.equal(out[0].json.run_id, RUN);
	assert.equal(ctx.calls.broker[0].body.wait_seconds, 0);
	assert.equal(ctx.calls.broker.length, 1);
	assert.deepEqual(state.sleeps, []);
});

test('a failed run is final: no retry, the marker and run id are kept', async () => {
	const ctx = makeCtx({
		params: catalogParams(),
		broker: [fullResponse(500, { detail: { code: 'source_failed', error_code: 'run_failed', run_id: RUN, replayed: false } })],
	});
	await assert.rejects(ops.startRun(ctx, 0, 'catalog', makeDeps().deps), (error) => {
		assert.ok(error instanceof gf.BrokerError);
		assert.equal(error.unsure, false);
		assert.equal(error.errorCode, 'run_failed');
		assert.equal(error.runId, RUN);
		assert.match(error.message, /failed \(run_failed\)/);
		assert.match(error.description, /new key/i);
		return true;
	});
	assert.equal(ctx.calls.broker.length, 1);
});

test('an unsure failure (503 without a marker) repeats the same request with the same key', async () => {
	const answers = [
		fullResponse(503, { detail: { code: 'runs_unavailable' } }),
		new Error('socket hang up'),
		fullResponse(200, finalBody([{ title: 'ok' }])),
	];
	const ctx = makeCtx({ params: catalogParams(), broker: answers });
	const { deps, state } = makeDeps();
	const out = await ops.startRun(ctx, 0, 'catalog', deps);
	assert.equal(out.length, 1);
	assert.deepEqual(ctx.calls.broker.map((c) => c.headers['Idempotency-Key']), [KEY, KEY, KEY]);
	assert.deepEqual(state.sleeps, [2000, 4000]);
});

test('retries stop after three attempts', async () => {
	const ctx = makeCtx({ params: catalogParams(), broker: () => fullResponse(503, { detail: 'down' }) });
	await assert.rejects(ops.startRun(ctx, 0, 'catalog', makeDeps().deps), /503/);
	assert.equal(ctx.calls.broker.length, 3);
});

test('definite errors are not retried and carry a hint', async () => {
	for (const [status, body, hint] of [
		[402, { detail: { code: 'insufficient_units', required: 5, available: 1 } }, /Add credit/],
		[409, { detail: { code: 'delivery_identity_conflict' } }, /new key/i],
		[401, { detail: 'Unauthorized' }, /API key/],
		[422, { detail: { code: 'run_option_invalid' } }, /range/],
	]) {
		const ctx = makeCtx({ params: catalogParams(), broker: [fullResponse(status, body)] });
		await assert.rejects(ops.startRun(ctx, 0, 'catalog', makeDeps().deps), (error) => {
			assert.equal(error.statusCode, status);
			assert.equal(error.unsure, false);
			assert.match(error.description, hint);
			return true;
		});
		assert.equal(ctx.calls.broker.length, 1);
	}
});

test('a poll that fails with a gateway error is read again with the same key', async () => {
	const answers = [
		fullResponse(202, runObject(), { 'retry-after': '5' }),
		fullResponse(502, { detail: 'bad gateway' }),
		fullResponse(200, finalBody([{ title: 'z' }])),
	];
	const ctx = makeCtx({ params: catalogParams(), broker: answers });
	const out = await ops.startRun(ctx, 0, 'catalog', makeDeps().deps);
	assert.equal(out.length, 1);
	assert.deepEqual(ctx.calls.broker.map((c) => c.method), ['POST', 'GET', 'GET']);
});

test('a redirect means the wrong origin and nothing ran', async () => {
	const ctx = makeCtx({ params: catalogParams(), broker: [fullResponse(301, '', { location: 'https://app.cleanedweb.com/' })] });
	await assert.rejects(ops.startRun(ctx, 0, 'catalog', makeDeps().deps), /redirect.*nothing ran/);
	assert.equal(ctx.calls.broker.length, 1);
});

test('a partial result fails by default and is returned when the check is off', async () => {
	const partial = finalBody([{ t: 1 }], { status: 'partial' });
	const failing = makeCtx({ params: catalogParams(), broker: [fullResponse(200, partial)] });
	await assert.rejects(ops.startRun(failing, 0, 'catalog', makeDeps().deps), (e) => e instanceof gf.ResultNotAcceptedError && e.runId === RUN);
	const lenient = makeCtx({
		params: catalogParams({ options: { failOnUnaccepted: false } }),
		broker: [fullResponse(200, partial)],
	});
	assert.equal((await ops.startRun(lenient, 0, 'catalog', makeDeps().deps)).length, 1);
});

test('Output "full" returns one item with the whole response', async () => {
	const body = finalBody([{ t: 1 }, { t: 2 }]);
	const ctx = makeCtx({ params: catalogParams({ options: { outputMode: 'full' } }), broker: [fullResponse(200, body)] });
	const out = await ops.startRun(ctx, 0, 'catalog', makeDeps().deps);
	assert.equal(out.length, 1);
	assert.deepEqual(out[0].json, body);
});

test('Run Without Max Items omits max_items; options map to the body', async () => {
	const ctx = makeCtx({
		params: catalogParams({ noMaxItems: true, options: { version: 2, fields: 'title, url', nulls: true } }),
		broker: [fullResponse(200, finalBody([]))],
	});
	await ops.startRun(ctx, 0, 'catalog', makeDeps().deps);
	assert.deepEqual(ctx.calls.broker[0].body, { input: { sort: 'desc_stars' }, version: 2, fields: ['title', 'url'], nulls: true });
});

test('an invalid key or input stops before any request', async () => {
	for (const params of [catalogParams({ idempotencyKey: 'bad key' }), catalogParams({ input: '{oops' })]) {
		const ctx = makeCtx({ params, broker: [] });
		await assert.rejects(ops.startRun(ctx, 0, 'catalog', makeDeps().deps));
		assert.equal(ctx.calls.broker.length, 0);
	}
});

test('path segments are encoded', async () => {
	const ctx = makeCtx({
		params: catalogParams({ apiId: 'a/b c', endpointId: 'e?x' }),
		broker: [fullResponse(200, finalBody([]))],
	});
	await ops.startRun(ctx, 0, 'catalog', makeDeps().deps);
	assert.equal(ctx.calls.broker[0].url, 'https://api.cleanedweb.com/v1/catalog/public/apis/a%2Fb%20c/endpoints/e%3Fx/run');
});

test('Run Source: expected_version in the body, pending runs read from /v1/runs/{id}/result', async () => {
	const version = 'b'.repeat(64);
	const params = {
		sourceId: 'src_1',
		expectedVersion: version,
		input: '{}',
		noMaxItems: false,
		maxItems: 10,
		waitForResult: true,
		idempotencyKey: KEY,
		options: { nulls: true },
	};
	const body = finalBody([{ id: 1 }], { definition_version: version });
	const ctx = makeCtx({
		params,
		broker: [fullResponse(202, runObject(), { 'retry-after': '4' }), fullResponse(200, body)],
	});
	const { deps, state } = makeDeps();
	const out = await ops.startRun(ctx, 0, 'source', deps);
	assert.equal(out.length, 1);
	assert.equal(ctx.calls.broker[0].url, 'https://api.cleanedweb.com/v1/sources/src_1/run');
	assert.deepEqual(ctx.calls.broker[0].body, { input: {}, max_items: 10, nulls: true, expected_version: version });
	assert.equal(ctx.calls.broker[1].url, `https://api.cleanedweb.com/v1/runs/${RUN}/result?nulls=true`);
	assert.deepEqual(state.sleeps, [4000]);
});

test('Run Source refuses a result whose definition version differs from the expected one', async () => {
	const params = { sourceId: 's', expectedVersion: 'c'.repeat(64), input: '{}', noMaxItems: true, waitForResult: true, idempotencyKey: KEY, options: {} };
	const ctx = makeCtx({ params, broker: [fullResponse(200, finalBody([{ a: 1 }], { definition_version: 'd'.repeat(64) }))] });
	await assert.rejects(ops.startRun(ctx, 0, 'source', makeDeps().deps), /definition_version/);
});

test('Get Run and Abort Run use the run routes', async () => {
	const ctx = makeCtx({ params: { runId: RUN }, broker: [fullResponse(200, runObject({ status: 'finished' })), fullResponse(202, runObject({ abort_requested: true }))] });
	const got = await ops.getRun(ctx, 0);
	assert.equal(got[0].json.status, 'finished');
	const aborted = await ops.abortRun(ctx, 0);
	assert.equal(aborted[0].json.abort_requested, true);
	assert.deepEqual(ctx.calls.broker.map((c) => `${c.method} ${c.url}`), [
		`GET https://api.cleanedweb.com/v1/runs/${RUN}`,
		`POST https://api.cleanedweb.com/v1/runs/${RUN}/abort`,
	]);
});

test('Get Run Items follows next_cursor until it is null', async () => {
	const page = (items, next) => fullResponse(200, { run_id: RUN, items, count: items.length, next_cursor: next, run_status: 'finished' });
	const ctx = makeCtx({
		params: { runId: RUN, returnAll: true, options: { pageSize: 2 } },
		broker: [page([{ n: 1 }, { n: 2 }], '2'), page([{ n: 3 }, { n: 4 }], '4'), page([{ n: 5 }], null)],
	});
	const out = await ops.getRunItems(ctx, 1);
	assert.deepEqual(out.map((o) => o.json.n), [1, 2, 3, 4, 5]);
	assert.ok(out.every((o) => o.pairedItem.item === 1));
	assert.deepEqual(ctx.calls.broker.map((c) => c.qs), [
		{ cursor: '0', limit: 2 },
		{ cursor: '2', limit: 2 },
		{ cursor: '4', limit: 2 },
	]);
});

test('Get Run Items with a limit asks only for what is left and slices', async () => {
	const page = (items, next) => fullResponse(200, { items, next_cursor: next });
	const ctx = makeCtx({
		params: { runId: RUN, returnAll: false, limit: 3, options: { pageSize: 2, startCursor: '10', nulls: true } },
		broker: [page([{ n: 1 }, { n: 2 }], '12'), page([{ n: 3 }], '13')],
	});
	const out = await ops.getRunItems(ctx, 0);
	assert.equal(out.length, 3);
	assert.deepEqual(ctx.calls.broker.map((c) => c.qs), [
		{ cursor: '10', limit: 2, nulls: true },
		{ cursor: '12', limit: 1, nulls: true },
	]);
});

test('Get Run Items on a running run stops at an empty page (the cursor stays non-null)', async () => {
	const ctx = makeCtx({
		params: { runId: RUN, returnAll: true, options: {} },
		broker: [
			fullResponse(200, { items: [{ n: 1 }], next_cursor: '1', run_status: 'running' }),
			fullResponse(200, { items: [], next_cursor: '1', run_status: 'running' }),
		],
	});
	assert.equal((await ops.getRunItems(ctx, 0)).length, 1);
	assert.equal(ctx.calls.broker.length, 2);
});

test('List APIs pages through the live catalog (limit 1-100, offset)', async () => {
	const make = (n, from) => ({ items: Array.from({ length: n }, (_, i) => ({ api_id: `a${from + i}`, name: `API ${from + i}` })) });
	const ctx = makeCtx({
		params: { returnAll: true, filters: { q: 'github', sort: 'name' } },
		catalog: [make(100, 0), make(100, 100), make(30, 200)],
	});
	const out = await ops.listApis(ctx, 0);
	assert.equal(out.length, 230);
	assert.deepEqual(ctx.calls.catalog.map((c) => c.qs), [
		{ limit: 100, offset: 0, q: 'github', sort: 'name' },
		{ limit: 100, offset: 100, q: 'github', sort: 'name' },
		{ limit: 100, offset: 200, q: 'github', sort: 'name' },
	]);
	assert.ok(ctx.calls.catalog.every((c) => c.url.startsWith('https://app.cleanedweb.com/api/catalog/apis')));
	assert.equal(ctx.calls.broker.length, 0, 'catalog reads send no credential');
});

test('List APIs with a limit asks for just that many', async () => {
	const ctx = makeCtx({ params: { returnAll: false, limit: 5, filters: {} }, catalog: [{ items: Array.from({ length: 5 }, (_, i) => ({ api_id: `a${i}` })) }] });
	assert.equal((await ops.listApis(ctx, 0)).length, 5);
	assert.deepEqual(ctx.calls.catalog[0].qs, { limit: 5, offset: 0 });
});

test('Get API Contract reads the live contract, with an optional pinned major', async () => {
	const ctx = makeCtx({ params: { apiId: API, endpointId: EP, options: { version: 1 } }, catalog: [{ definition_version: 'v', input_schema: {} }] });
	const out = await ops.getApiContract(ctx, 0);
	assert.equal(out[0].json.definition_version, 'v');
	assert.equal(ctx.calls.catalog[0].url, `https://app.cleanedweb.com/api/catalog/apis/${API}/endpoints/${EP}/contract`);
	assert.deepEqual(ctx.calls.catalog[0].qs, { version: 1 });
});

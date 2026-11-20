'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { NodeApiError, NodeOperationError } = require('n8n-workflow');
const { makeCtx, fullResponse } = require('./helpers');
const { CleanedWeb } = require('../dist/nodes/CleanedWeb/CleanedWeb.node');
const { CleanedWebApi } = require('../dist/credentials/CleanedWebApi.credentials');
const pkg = require('../package.json');

const node = new CleanedWeb();
const props = node.description.properties;

test('package registers the node and credential, with no runtime dependencies', () => {
	assert.deepEqual(pkg.n8n.nodes, ['dist/nodes/CleanedWeb/CleanedWeb.node.js']);
	assert.deepEqual(pkg.n8n.credentials, ['dist/credentials/CleanedWebApi.credentials.js']);
	assert.equal(pkg.dependencies, undefined);
	assert.ok(pkg.keywords.includes('n8n-community-node-package'));
});

test('node description: resources, operations, tool use, credential only where a key is needed', () => {
	assert.equal(node.description.usableAsTool, true);
	const resource = props.find((p) => p.name === 'resource');
	assert.deepEqual(resource.options.map((o) => o.value), ['catalog', 'privateApi', 'run']);
	const operations = (r) => props.find((p) => p.name === 'operation' && p.displayOptions.show.resource[0] === r).options.map((o) => o.value);
	assert.deepEqual(operations('catalog'), ['getContract', 'list']);
	assert.deepEqual(operations('run'), ['abort', 'get', 'getItems', 'runCatalog']);
	assert.deepEqual(operations('privateApi'), ['runSource']);
	const [cred] = node.description.credentials;
	assert.equal(cred.name, 'cleanedWebApi');
	assert.deepEqual(cred.displayOptions.show.resource, ['run', 'privateApi']);
});

test('run fields: Idempotency Key defaults to an execution expression; Wait for Result defaults on', () => {
	const forRun = (name) => props.find((p) => p.name === name && p.displayOptions?.show?.operation?.includes('runCatalog'));
	assert.match(forRun('idempotencyKey').default, /^=\{\{ \$execution\.id \}\}-\{\{ \$runIndex \}\}/);
	assert.equal(forRun('waitForResult').default, true);
	assert.equal(forRun('maxItems').default, 25);
	assert.equal(forRun('apiId').typeOptions.loadOptionsMethod, 'getCatalogApis');
	assert.deepEqual(forRun('endpointId').typeOptions.loadOptionsDependsOn, ['apiId']);
	assert.ok(node.methods.loadOptions.getCatalogApis && node.methods.loadOptions.getCatalogEndpoints);
});

test('credential: Bearer auth and a read-only test against GET /v1/runs?limit=1', () => {
	const cred = new CleanedWebApi();
	assert.equal(cred.properties.find((p) => p.name === 'apiKey').typeOptions.password, true);
	assert.equal(cred.authenticate.properties.headers.Authorization, '=Bearer {{$credentials.apiKey}}');
	assert.equal(cred.test.request.method, 'GET');
	assert.equal(cred.test.request.url, '/v1/runs');
	assert.deepEqual(cred.test.request.qs, { limit: 1 });
	assert.match(cred.test.request.baseURL, /api\.cleanedweb\.com/);
});

test('loadOptions lists the live catalog and an API\'s available endpoints', async () => {
	const apis = makeCtx({ catalog: [{ items: [{ api_id: 'a1', name: 'One', site: { domain: 'one.test' }, short_description: 'd' }, { name: 'no id' }] }] });
	const options = await node.methods.loadOptions.getCatalogApis.call(apis);
	assert.deepEqual(options, [{ name: 'One (one.test)', value: 'a1', description: 'd' }]);
	assert.equal(apis.calls.catalog[0].qs.sort, 'name');

	const endpoints = makeCtx({
		params: { apiId: 'a1' },
		catalog: [{ endpoints: [{ endpoint_id: 'a1_search', name: 'Extract records', description: 'Return records', status: 'available' }] }],
	});
	const list = await node.methods.loadOptions.getCatalogEndpoints.call(endpoints);
	assert.equal(list[0].value, 'a1_search');
	// an unresolved expression yields no list, and no request
	const none = makeCtx({ params: { apiId: '={{ $json.api }}' } });
	assert.deepEqual(await node.methods.loadOptions.getCatalogEndpoints.call(none), []);
	assert.equal(none.calls.catalog.length, 0);
});

test('execute: one output item per record across several input items', async () => {
	const body = (records) => ({
		records,
		summary: { status: 'completed', within_scope_passed: true },
		run: { run_id: 'r' },
	});
	const ctx = makeCtx({
		items: [{ json: {} }, { json: {} }],
		params: { resource: 'run', operation: 'runCatalog', apiId: 'a', endpointId: 'e', input: '{}', noMaxItems: true, waitForResult: true, idempotencyKey: 'k', options: {} },
		broker: [fullResponse(200, body([{ n: 1 }, { n: 2 }])), fullResponse(200, body([{ n: 3 }]))],
	});
	const [out] = await node.execute.call(ctx);
	assert.deepEqual(out.map((o) => [o.json.n, o.pairedItem.item]), [[1, 0], [2, 0], [3, 1]]);
});

test('execute: API errors become NodeApiError; usage errors NodeOperationError; continueOnFail keeps going', async () => {
	const base = { resource: 'run', operation: 'runCatalog', apiId: 'a', endpointId: 'e', input: '{}', noMaxItems: true, waitForResult: true, options: {} };
	const apiFail = makeCtx({ params: { ...base, idempotencyKey: 'k' }, broker: [fullResponse(402, { detail: { code: 'insufficient_units' } })] });
	await assert.rejects(node.execute.call(apiFail), (e) => e instanceof NodeApiError && /insufficient_units/.test(e.message));

	const usage = makeCtx({ params: { ...base, idempotencyKey: 'not valid!' } });
	await assert.rejects(node.execute.call(usage), (e) => e instanceof NodeOperationError && /Idempotency Key/.test(e.message));

	const soft = makeCtx({ params: { ...base, idempotencyKey: 'not valid!' } });
	soft.continueOnFail = () => true;
	const [out] = await node.execute.call(soft);
	assert.match(out[0].json.error, /Idempotency Key/);
	assert.deepEqual(out[0].pairedItem, { item: 0 });
});

test('execute: Get Run through the node', async () => {
	const ctx = makeCtx({ params: { resource: 'run', operation: 'get', runId: 'r1' }, broker: [fullResponse(200, { run_id: 'r1', status: 'finished' })] });
	const [out] = await node.execute.call(ctx);
	assert.equal(out[0].json.status, 'finished');
});

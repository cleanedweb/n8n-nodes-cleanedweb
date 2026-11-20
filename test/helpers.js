'use strict';

/** A minimal stand-in for n8n's IExecuteFunctions: mocked helpers, no network. */

const gf = require('../dist/nodes/CleanedWeb/GenericFunctions');

function fullResponse(statusCode, body, headers = {}) {
	return { statusCode, headers, body };
}

/**
 * @param {object} options
 * @param {Record<string, unknown>} [options.params]   node parameters, by name (same for every item)
 * @param {Array|Function} [options.broker]            queued answers (or a function) for authenticated requests
 * @param {Array|Function} [options.catalog]           queued answers (or a function) for anonymous requests
 */
function makeCtx({ params = {}, broker = [], catalog = [], credentials = {}, items = [{ json: {} }] } = {}) {
	const calls = { broker: [], catalog: [] };
	const next = (queue, call) => {
		const value = typeof queue === 'function' ? queue(call) : queue.shift();
		if (value === undefined) throw new Error(`unexpected request: ${call.method} ${call.url}`);
		if (value instanceof Error) throw value;
		return value;
	};
	const ctx = {
		calls,
		getNode: () => ({ name: 'CleanedWeb', type: 'n8n-nodes-cleanedweb.cleanedWeb', typeVersion: 1, id: 'n', position: [0, 0], parameters: {} }),
		getInputData: () => items,
		getNodeParameter: (name, _i, fallback) => (name in params ? params[name] : fallback),
		getCurrentNodeParameter: (name) => params[name],
		getCredentials: async (type) => {
			if (type !== 'cleanedWebApi') throw new Error(`unknown credential ${type}`);
			return { apiKey: 'test-key', origin: 'https://api.cleanedweb.com', ...credentials };
		},
		getExecutionCancelSignal: () => undefined,
		continueOnFail: () => false,
		helpers: {
			httpRequestWithAuthentication: async function (type, options) {
				const call = { type, ...options };
				calls.broker.push(call);
				return next(broker, call);
			},
			httpRequest: async (options) => {
				calls.catalog.push(options);
				return next(catalog, options);
			},
		},
	};
	return ctx;
}

/** Deterministic time: sleeping advances the clock instead of waiting. */
function makeDeps(start = 1_000_000) {
	const state = { t: start, sleeps: [] };
	return {
		state,
		deps: {
			now: () => state.t,
			sleep: async (_ctx, ms) => {
				state.sleeps.push(ms);
				state.t += ms;
			},
		},
	};
}

module.exports = { makeCtx, makeDeps, fullResponse, gf };

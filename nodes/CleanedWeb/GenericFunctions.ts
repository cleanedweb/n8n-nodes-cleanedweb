import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	ILoadOptionsFunctions,
} from 'n8n-workflow';
import { sleep } from 'n8n-workflow';

import {
	ACCEPTED_SUMMARY_STATUSES,
	CATALOG_MAX_PAGES,
	CATALOG_ORIGIN,
	CATALOG_PAGE_SIZE,
	CREDENTIAL_NAME,
	DEFAULT_RUN_ORIGIN,
	DEFAULT_WAIT_SECONDS,
	FAILED_RUN_MARKERS,
	IDEMPOTENCY_KEY_PATTERN,
	MAX_RUN_SECONDS,
	MIN_TIMEOUT_SECONDS,
	UNSURE_RETRY_ATTEMPTS,
	UNSURE_RETRY_BASE_MS,
} from './constants';

export type Ctx = IExecuteFunctions | ILoadOptionsFunctions;

/** A failure the node reports as a validation or configuration problem. */
export class CleanedWebUsageError extends Error {
	constructor(
		message: string,
		readonly description?: string,
	) {
		super(message);
		this.name = 'CleanedWebUsageError';
	}
}

export interface BrokerErrorInit {
	message: string;
	statusCode: number;
	description?: string;
	code?: string;
	errorCode?: string;
	runId?: string;
	unsure: boolean;
	retryAfterSeconds?: number;
	body?: unknown;
}

/** An HTTP or transport failure from the run origin or the catalog. */
export class BrokerError extends Error {
	readonly statusCode: number;
	readonly description?: string;
	readonly code?: string;
	/** `run_failed` or `failed_run_replayed`: the run failed and its key is final. */
	readonly errorCode?: string;
	readonly runId?: string;
	/** True when the outcome is unknown (timeout, lost connection, 5xx without a failed-run marker). */
	readonly unsure: boolean;
	readonly retryAfterSeconds?: number;
	readonly body?: unknown;

	constructor(init: BrokerErrorInit) {
		super(init.message);
		this.name = 'BrokerError';
		this.statusCode = init.statusCode;
		this.description = init.description;
		this.code = init.code;
		this.errorCode = init.errorCode;
		this.runId = init.runId;
		this.unsure = init.unsure;
		this.retryAfterSeconds = init.retryAfterSeconds;
		this.body = init.body;
	}
}

/** The run was still going when the maximum wait ended. The run continues on the server. */
export class RunStillRunningError extends Error {
	constructor(
		readonly runId: string | undefined,
		readonly waitedSeconds: number,
	) {
		super(
			`The run was still going after waiting ${waitedSeconds} seconds` +
				(runId ? ` (run ${runId})` : ''),
		);
		this.name = 'RunStillRunningError';
	}
}

/** The run ended but its result is not one to process downstream (partial, out of scope, wrong version). */
export class ResultNotAcceptedError extends Error {
	constructor(
		message: string,
		readonly runId: string | undefined,
		readonly body: IDataObject,
	) {
		super(message);
		this.name = 'ResultNotAcceptedError';
	}
}

export interface BrokerResponse {
	statusCode: number;
	headers: Record<string, string | string[] | undefined>;
	body: IDataObject;
}

export interface Deps {
	sleep: (ctx: IExecuteFunctions, ms: number) => Promise<void>;
	now: () => number;
}

export const defaultDeps: Deps = {
	async sleep(ctx, ms) {
		await sleep(ms);
		if (ctx.getExecutionCancelSignal?.()?.aborted) {
			throw new CleanedWebUsageError('The execution was cancelled while waiting for the run');
		}
	},
	now: () => Date.now(),
};

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Await a promise without a catch block: the caller decides what to do with the failure. */
export async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
	return await promise.then(
		(value): Settled<T> => ({ ok: true, value }),
		(error: unknown): Settled<T> => ({ ok: false, error }),
	);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is IDataObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Accept `https://host` (or http only for localhost). The credential holds an origin, not a path. */
export function normalizeOrigin(raw: unknown): string {
	const text = typeof raw === 'string' ? raw.trim() : '';
	if (!text) return DEFAULT_RUN_ORIGIN;
	const url = URL.canParse(text) ? new URL(text) : undefined;
	if (!url) {
		throw new CleanedWebUsageError(
			'The run origin in the credential is not a valid URL',
			'Use https://api.cleanedweb.com, or the origin your workspace supplies.',
		);
	}
	const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
		throw new CleanedWebUsageError(
			'The run origin must use https',
			'The API key is sent to this origin; plain http is only accepted for localhost.',
		);
	}
	if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
		throw new CleanedWebUsageError(
			'The run origin must not include a path',
			'Use only the origin, for example https://api.cleanedweb.com.',
		);
	}
	return url.origin;
}

export function validateIdempotencyKey(value: unknown): string {
	const key = typeof value === 'string' ? value.trim() : '';
	if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
		throw new CleanedWebUsageError(
			'The Idempotency Key is not valid',
			'Use 1-200 characters: letters, numbers, ".", "_", ":" and "-". Use one key per intended run and reuse it only to recover that same run.',
		);
	}
	return key;
}

const INVALID_JSON = Symbol('invalid json');

function safeJsonParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return INVALID_JSON;
	}
}

/** Parse the Input parameter: a JSON string or an object from an expression. */
export function parseInput(value: unknown): IDataObject {
	if (value === undefined || value === null || value === '') return {};
	if (isRecord(value)) return value;
	if (typeof value === 'string') {
		const text = value.trim();
		if (text === '') return {};
		const parsed = safeJsonParse(text);
		if (parsed === INVALID_JSON) throw new CleanedWebUsageError('Input is not valid JSON');
		if (isRecord(parsed)) return parsed;
	}
	throw new CleanedWebUsageError(
		'Input must be a JSON object',
		'Use the inputs listed by the API contract, for example {"sort": "desc_stars"}. An empty object {} is valid when the contract requires no inputs.',
	);
}

export function parseFields(value: unknown): string[] | undefined {
	if (Array.isArray(value)) value = value.join(',');
	if (typeof value !== 'string') return undefined;
	const names = value
		.split(',')
		.map((name) => name.trim())
		.filter((name) => name !== '');
	if (names.length === 0) return undefined;
	return [...new Set(names)];
}

function integerInRange(name: string, value: unknown, min: number, max: number): number {
	const n = typeof value === 'number' ? value : Number(value);
	if (!Number.isInteger(n) || n < min || n > max) {
		throw new CleanedWebUsageError(`${name} must be a whole number from ${min} to ${max}`);
	}
	return n;
}

export interface RunBodyInput {
	input: IDataObject;
	/** Undefined means no cap. */
	maxItems?: number;
	timeoutSeconds?: number;
	waitSeconds?: number;
	fields?: string[];
	nulls?: boolean;
	/** Catalog only: pin a major version. */
	version?: number;
	/** Private API only: require the active definition to match this version. */
	expectedVersion?: string;
	/** Private API only: select an accepted revision. */
	definitionVersion?: string;
}

/** Build the JSON body of a run request. Only options the caller set are sent. */
export function buildRunBody(init: RunBodyInput): IDataObject {
	const body: IDataObject = { input: init.input };
	if (init.maxItems !== undefined) {
		body.max_items = integerInRange('Limit', init.maxItems, 1, Number.MAX_SAFE_INTEGER);
	}
	if (init.timeoutSeconds !== undefined) {
		body.timeout_seconds = integerInRange(
			'Run Timeout (Seconds)',
			init.timeoutSeconds,
			MIN_TIMEOUT_SECONDS,
			MAX_RUN_SECONDS,
		);
	}
	if (init.waitSeconds !== undefined) {
		body.wait_seconds = integerInRange('Wait Seconds', init.waitSeconds, 0, MAX_RUN_SECONDS);
	}
	if (init.fields && init.fields.length > 0) body.fields = init.fields;
	if (init.nulls === true) body.nulls = true;
	if (init.version !== undefined) {
		body.version = integerInRange('Version', init.version, 1, Number.MAX_SAFE_INTEGER);
	}
	const expected = init.expectedVersion?.trim();
	const definition = init.definitionVersion?.trim();
	if (expected && definition) {
		throw new CleanedWebUsageError(
			'Use either Expected Version or Definition Version, not both',
			'Expected Version requires the active definition to match; Definition Version selects an accepted revision explicitly.',
		);
	}
	if (expected) body.expected_version = expected;
	if (definition) body.definition_version = definition;
	return body;
}

function headerValue(
	headers: BrokerResponse['headers'] | undefined,
	name: string,
): string | undefined {
	if (!headers) return undefined;
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === name.toLowerCase()) {
			return Array.isArray(value) ? value[0] : value;
		}
	}
	return undefined;
}

/** Retry-After in seconds (delay-seconds or HTTP-date); undefined when absent or unreadable. */
export function parseRetryAfter(
	headers: BrokerResponse['headers'] | undefined,
	now: number = Date.now(),
): number | undefined {
	const raw = headerValue(headers, 'retry-after')?.trim();
	if (!raw) return undefined;
	if (/^\d+(\.\d+)?$/.test(raw)) return Math.ceil(Number(raw));
	const at = Date.parse(raw);
	if (Number.isNaN(at)) return undefined;
	return Math.max(0, Math.ceil((at - now) / 1000));
}

const HINTS: Record<string, string> = {
	insufficient_units:
		'The workspace balance cannot fund the run. Add credit in Billing, then use a new Idempotency Key if the run failed.',
	usage_budget_exceeded: "The workspace's monthly usage budget cannot cover the request.",
	delivery_identity_conflict:
		'This Idempotency Key was already used for a different endpoint, version or request. Use a new key for a new request.',
	run_option_invalid: 'A run option is outside its range. Fix it; do not retry unchanged.',
	idempotency_key_required: 'The Idempotency Key is missing or invalid.',
	builder_billing_unavailable:
		'Billing could not be confirmed, so the run was refused. Retry later with the same key and request.',
	runs_unavailable: 'The run store could not answer. Retry later with the same key.',
	source_input_invalid:
		'An input value is not accepted by the API. Check the input against the API contract.',
};

function statusHint(status: number): string | undefined {
	switch (status) {
		case 401:
			return 'No valid credential. Check the API key; it needs the run scope.';
		case 403:
			return 'The key is not tied to a workspace account or lacks permission. Use a workspace key with the run scope.';
		case 404:
			return 'Not found: the API, endpoint, run or delivery does not exist for this key. The API may be unpublished.';
		case 422:
			return 'The request was rejected. Correct the input against the API contract.';
		default:
			return undefined;
	}
}

function buildBrokerError(response: BrokerResponse): BrokerError {
	const { statusCode, body, headers } = response;
	const rawDetail = isRecord(body) ? body.detail : undefined;
	const detail = isRecord(rawDetail) ? rawDetail : undefined;
	const text =
		typeof rawDetail === 'string'
			? rawDetail
			: typeof detail?.message === 'string'
				? detail.message
				: undefined;
	const code = typeof detail?.code === 'string' ? detail.code : undefined;
	const errorCode = typeof detail?.error_code === 'string' ? detail.error_code : undefined;
	const runId = typeof detail?.run_id === 'string' ? detail.run_id : undefined;
	const failedRun = errorCode !== undefined && FAILED_RUN_MARKERS.includes(errorCode);
	const unsure =
		!failedRun && (statusCode >= 500 || statusCode === 408 || statusCode === 429);

	let message = `CleanedWeb answered ${statusCode}`;
	if (code) message += ` ${code}`;
	if (text && text !== code) message += `: ${text}`;
	let description = (code && HINTS[code]) || statusHint(statusCode);
	if (failedRun) {
		message = `${runId ? `Run ${runId}` : 'The run'} failed (${errorCode}): HTTP ${statusCode}${code ? ` ${code}` : ''}`;
		description =
			'A failed run is final for its Idempotency Key: the same key returns the same error for 7 days. Use a new key to run again. Records saved before the failure stay readable with Get Run Items.';
	} else if (unsure) {
		description =
			(description ? `${description} ` : '') +
			'This does not show whether a run started. Keep the Idempotency Key and read the result before using a new key.';
	}
	return new BrokerError({
		message,
		statusCode,
		description,
		code,
		errorCode,
		runId,
		unsure,
		retryAfterSeconds: parseRetryAfter(headers),
		body,
	});
}

/** The `run_id` of a run object or a final run body. */
export function extractRunId(body: IDataObject | undefined): string | undefined {
	if (!body) return undefined;
	if (typeof body.run_id === 'string') return body.run_id;
	if (isRecord(body.run) && typeof body.run.run_id === 'string') return body.run.run_id;
	if (isRecord(body.delivery) && typeof body.delivery.runId === 'string') return body.delivery.runId;
	return undefined;
}

/**
 * Check a final run body before downstream processing (see "Accept the result" in the run
 * reference): `summary.status` completed or bounded, `within_scope_passed` true and, when a
 * version was expected, `summary.definition_version` equal to it.
 */
export function assertAccepted(body: IDataObject, expectedVersion?: string): void {
	const summary = isRecord(body.summary) ? body.summary : undefined;
	if (!summary) return;
	const runId = extractRunId(body);
	const run = isRecord(body.run) ? body.run : undefined;
	const problems: string[] = [];
	if (!ACCEPTED_SUMMARY_STATUSES.includes(String(summary.status))) {
		problems.push(`summary.status is "${String(summary.status)}"`);
	}
	if (summary.within_scope_passed !== true) problems.push('summary.within_scope_passed is not true');
	if (expectedVersion && summary.definition_version !== expectedVersion) {
		problems.push('summary.definition_version does not match the expected version');
	}
	if (problems.length > 0) {
		const stop = run && run.stop_reason ? ` (stop reason: ${String(run.stop_reason)})` : '';
		throw new ResultNotAcceptedError(
			`The run result needs review: ${problems.join('; ')}${stop}`,
			runId,
			body,
		);
	}
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface BrokerRequest {
	method: IHttpRequestMethods;
	path: string;
	qs?: IDataObject;
	body?: IDataObject;
	headers?: Record<string, string>;
	timeoutMs?: number;
}

/**
 * Authenticated request to the run origin. Returns 2xx responses (200 and 202 included);
 * throws BrokerError for redirects, errors and lost connections.
 */
export async function brokerRequest(
	ctx: IExecuteFunctions,
	request: BrokerRequest,
): Promise<BrokerResponse> {
	const credentials = await ctx.getCredentials<{ origin?: string }>(CREDENTIAL_NAME);
	const origin = normalizeOrigin(credentials.origin);
	type Raw = { statusCode?: number; headers?: BrokerResponse['headers']; body?: unknown };
	const settled = await settle<Raw>(
		ctx.helpers.httpRequestWithAuthentication.call(ctx, CREDENTIAL_NAME, {
			method: request.method,
			url: `${origin}${request.path}`,
			qs: request.qs,
			body: request.body,
			headers: { Accept: 'application/json', ...request.headers },
			json: true,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			disableFollowRedirect: true,
			timeout: request.timeoutMs ?? 60_000,
		}) as Promise<Raw>,
	);
	if (!settled.ok) {
		throw new BrokerError({
			message: 'No answer from the run origin (timeout or lost connection)',
			description:
				'A lost connection does not show whether a run started. Keep the Idempotency Key and read the result before using a new key.',
			statusCode: 0,
			unsure: true,
			body: { message: (settled.error as Error).message },
		});
	}
	const response = settled.value;
	const statusCode = response.statusCode ?? 0;
	const result: BrokerResponse = {
		statusCode,
		headers: response.headers ?? {},
		body: isRecord(response.body) ? response.body : { raw: String(response.body ?? '') },
	};
	if (statusCode >= 300 && statusCode < 400) {
		throw new BrokerError({
			message: `The run origin answered a redirect (${statusCode}); nothing ran`,
			description:
				'The request went to the wrong origin. Use https://api.cleanedweb.com, or the origin your workspace supplies, in the credential.',
			statusCode,
			unsure: false,
		});
	}
	if (statusCode >= 400 || statusCode === 0) throw buildBrokerError(result);
	return result;
}

/** Anonymous GET against the public catalog (no credential is sent). */
export async function catalogGet(
	ctx: Ctx,
	path: string,
	qs: IDataObject = {},
): Promise<IDataObject> {
	const response = await ctx.helpers.httpRequest({
		method: 'GET',
		url: `${CATALOG_ORIGIN}${path}`,
		qs,
		headers: { Accept: 'application/json' },
		json: true,
		timeout: 30_000,
	});
	if (!isRecord(response)) {
		throw new CleanedWebUsageError('The catalog answered without a JSON object');
	}
	return response;
}

export interface CatalogListOptions {
	/** Undefined reads every page. */
	limit?: number;
	query?: string;
	category?: string;
	sort?: string;
}

/** Page through `/api/catalog/apis` (limit 1-100, offset paging) until the list ends. */
export async function listCatalogApis(
	ctx: Ctx,
	options: CatalogListOptions = {},
): Promise<IDataObject[]> {
	const out: IDataObject[] = [];
	for (let page = 0; page < CATALOG_MAX_PAGES; page++) {
		const remaining = options.limit === undefined ? Infinity : options.limit - out.length;
		if (remaining <= 0) break;
		const pageSize = Math.min(CATALOG_PAGE_SIZE, remaining);
		const qs: IDataObject = { limit: pageSize, offset: out.length };
		if (options.query) qs.q = options.query;
		if (options.category) qs.category = options.category;
		if (options.sort) qs.sort = options.sort;
		const response = await catalogGet(ctx, '/api/catalog/apis', qs);
		const items = Array.isArray(response.items) ? (response.items as IDataObject[]) : [];
		out.push(...items);
		if (items.length < pageSize) break;
	}
	return options.limit === undefined ? out : out.slice(0, options.limit);
}

export async function getCatalogApi(ctx: Ctx, apiId: string): Promise<IDataObject> {
	return await catalogGet(ctx, `/api/catalog/apis/${encodeURIComponent(apiId)}`);
}

export async function getCatalogContract(
	ctx: Ctx,
	apiId: string,
	endpointId: string,
	version?: number,
): Promise<IDataObject> {
	const qs: IDataObject = {};
	if (version !== undefined) qs.version = version;
	return await catalogGet(
		ctx,
		`/api/catalog/apis/${encodeURIComponent(apiId)}/endpoints/${encodeURIComponent(endpointId)}/contract`,
		qs,
	);
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/**
 * Repeat the same request after an unsure failure. The Idempotency Key stays the same, so a
 * repeat returns the original run instead of starting another (see "Recover a lost response").
 */
async function withSameKeyRetry<T>(
	ctx: IExecuteFunctions,
	deps: Deps,
	attempt: () => Promise<T>,
	attempts: number = UNSURE_RETRY_ATTEMPTS,
): Promise<T> {
	for (let n = 1; ; n++) {
		const result = await settle(attempt());
		if (result.ok) return result.value;
		const error = result.error;
		if (!(error instanceof BrokerError) || !error.unsure || n >= attempts) {
			throw error;
		}
		const waitMs =
			error.retryAfterSeconds !== undefined
				? Math.min(error.retryAfterSeconds, 60) * 1000
				: UNSURE_RETRY_BASE_MS * 2 ** (n - 1);
		await deps.sleep(ctx, waitMs);
	}
}

export interface RunRequest {
	/** Path that starts the run (POST). */
	startPath: string;
	body: IDataObject;
	idempotencyKey: string;
	/** Poll until the run ends; when false the answer to the POST is returned as it is. */
	waitForResult: boolean;
	/** Where to read the result of a pending run. */
	resultRequest: (runId: string | undefined) => { path: string; headers?: Record<string, string> };
	maxWaitSeconds: number;
	pollFallbackSeconds: number;
}

export interface RunOutcome {
	/** True when `body` is a final result body; false when it is the run object of a pending run. */
	finished: boolean;
	body: IDataObject;
	runId?: string;
}

/**
 * Start a run once and, when asked, wait for its result: send the POST with the Idempotency
 * Key, and on 202 read the result route after Retry-After until it answers 200 or an error.
 * The POST is never resent with a new key.
 */
export async function executeRun(
	ctx: IExecuteFunctions,
	request: RunRequest,
	deps: Deps = defaultDeps,
): Promise<RunOutcome> {
	const requestedWait = request.body.wait_seconds;
	const serverWait = typeof requestedWait === 'number' ? requestedWait : DEFAULT_WAIT_SECONDS;
	const start = await withSameKeyRetry(ctx, deps, () =>
		brokerRequest(ctx, {
			method: 'POST',
			path: request.startPath,
			body: request.body,
			headers: { 'Idempotency-Key': request.idempotencyKey },
			// The client limit must outlast the server's wait, or a slow answer looks like a failure.
			timeoutMs: (serverWait + 30) * 1000,
		}),
	);
	if (start.statusCode === 200) {
		return { finished: true, body: start.body, runId: extractRunId(start.body) };
	}
	const runId = extractRunId(start.body);
	if (start.statusCode !== 202) {
		throw new BrokerError({
			message: `CleanedWeb answered an unexpected ${start.statusCode}`,
			statusCode: start.statusCode,
			unsure: false,
			body: start.body,
		});
	}
	if (!request.waitForResult) return { finished: false, body: start.body, runId };

	const deadline = deps.now() + request.maxWaitSeconds * 1000;
	let latest: Pick<BrokerResponse, 'headers' | 'body'> = start;
	let currentRunId = runId;
	let failures = 0;
	for (;;) {
		const remainingMs = deadline - deps.now();
		if (remainingMs <= 0) throw new RunStillRunningError(currentRunId, request.maxWaitSeconds);
		const hinted =
			parseRetryAfter(latest.headers, deps.now()) ??
			(typeof latest.body.poll_after_seconds === 'number'
				? latest.body.poll_after_seconds
				: undefined) ??
			request.pollFallbackSeconds;
		const delaySeconds = Math.min(Math.max(hinted, 1), 3600);
		await deps.sleep(ctx, Math.min(delaySeconds * 1000, remainingMs));

		const target = request.resultRequest(currentRunId);
		const read = await settle(
			brokerRequest(ctx, {
				method: 'GET',
				path: target.path,
				headers: target.headers,
				timeoutMs: 120_000,
			}),
		);
		if (!read.ok) {
			const error = read.error;
			// A gateway fault or lost connection proves nothing: keep the key and read again.
			if (error instanceof BrokerError && error.unsure && ++failures <= UNSURE_RETRY_ATTEMPTS + 2) {
				latest = {
					headers:
						error.retryAfterSeconds !== undefined
							? { 'retry-after': String(error.retryAfterSeconds) }
							: {},
					body: {},
				};
				continue;
			}
			throw error;
		}
		failures = 0;
		const poll = read.value;
		if (poll.statusCode === 200) {
			return { finished: true, body: poll.body, runId: extractRunId(poll.body) ?? currentRunId };
		}
		if (poll.statusCode !== 202) {
			throw new BrokerError({
				message: `CleanedWeb answered an unexpected ${poll.statusCode} while reading the result`,
				statusCode: poll.statusCode,
				unsure: false,
				body: poll.body,
			});
		}
		latest = poll;
		currentRunId = extractRunId(poll.body) ?? currentRunId;
	}
}

export interface RunItemsOptions {
	returnAll: boolean;
	limit?: number;
	pageSize: number;
	startCursor: string;
	nulls?: boolean;
}

/**
 * Read `/v1/runs/{run_id}/items` page by page, following `next_cursor`. While a run is still
 * going the cursor can stay non-null; an empty page, a repeated cursor or the limit ends the read.
 */
export async function fetchRunItems(
	ctx: IExecuteFunctions,
	runId: string,
	options: RunItemsOptions,
): Promise<IDataObject[]> {
	const out: IDataObject[] = [];
	let cursor: string | undefined = options.startCursor || '0';
	for (;;) {
		const remaining = options.returnAll ? Infinity : (options.limit ?? 50) - out.length;
		if (remaining <= 0) break;
		const qs: IDataObject = {
			cursor,
			limit: Math.min(options.pageSize, Number.isFinite(remaining) ? remaining : options.pageSize),
		};
		if (options.nulls) qs.nulls = true;
		const page = await brokerRequest(ctx, {
			method: 'GET',
			path: `/v1/runs/${encodeURIComponent(runId)}/items`,
			qs,
		});
		const items = Array.isArray(page.body.items) ? (page.body.items as IDataObject[]) : [];
		out.push(...items);
		const next = page.body.next_cursor;
		const nextCursor = next === null || next === undefined || next === '' ? undefined : String(next);
		if (items.length === 0 || nextCursor === undefined || nextCursor === cursor) break;
		cursor = nextCursor;
	}
	return options.returnAll ? out : out.slice(0, options.limit ?? 50);
}

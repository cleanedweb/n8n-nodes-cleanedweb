import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';

import {
	assertAccepted,
	brokerRequest,
	buildRunBody,
	CleanedWebUsageError,
	defaultDeps,
	executeRun,
	fetchRunItems,
	getCatalogContract,
	isRecord,
	listCatalogApis,
	parseFields,
	parseInput,
	validateIdempotencyKey,
	type Deps,
	type RunOutcome,
} from './GenericFunctions';

function paired(json: IDataObject, itemIndex: number): INodeExecutionData {
	return { json, pairedItem: { item: itemIndex } };
}

function pairedAll(rows: IDataObject[], itemIndex: number): INodeExecutionData[] {
	return rows.map((row) => paired(isRecord(row) ? row : { value: row as never }, itemIndex));
}

function requiredString(ctx: IExecuteFunctions, name: string, itemIndex: number): string {
	const value = ctx.getNodeParameter(name, itemIndex, '');
	const text = typeof value === 'string' ? value.trim() : '';
	if (!text) {
		throw new CleanedWebUsageError(`${name} is required`);
	}
	return text;
}

function numberOption(options: IDataObject, name: string): number | undefined {
	const value = options[name];
	return typeof value === 'number' ? value : undefined;
}

// ---------------------------------------------------------------------------
// Catalog (no API key)
// ---------------------------------------------------------------------------

export async function listApis(ctx: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const returnAll = ctx.getNodeParameter('returnAll', i, false) as boolean;
	const filters = ctx.getNodeParameter('filters', i, {}) as IDataObject;
	const limit = returnAll ? undefined : (ctx.getNodeParameter('limit', i, 50) as number);
	const apis = await listCatalogApis(ctx, {
		limit,
		query: typeof filters.q === 'string' ? filters.q : undefined,
		category: typeof filters.category === 'string' ? filters.category : undefined,
		sort: typeof filters.sort === 'string' ? filters.sort : undefined,
	});
	return pairedAll(apis, i);
}

export async function getApiContract(
	ctx: IExecuteFunctions,
	i: number,
): Promise<INodeExecutionData[]> {
	const options = ctx.getNodeParameter('options', i, {}) as IDataObject;
	const contract = await getCatalogContract(
		ctx,
		requiredString(ctx, 'apiId', i),
		requiredString(ctx, 'endpointId', i),
		numberOption(options, 'version'),
	);
	return [paired(contract, i)];
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** Turn a run outcome into n8n items according to the Output option. */
export function outcomeToItems(
	outcome: RunOutcome,
	outputMode: string,
	itemIndex: number,
): INodeExecutionData[] {
	if (!outcome.finished || outputMode === 'full') return [paired(outcome.body, itemIndex)];
	const records = Array.isArray(outcome.body.records) ? (outcome.body.records as IDataObject[]) : [];
	return pairedAll(records, itemIndex);
}

/**
 * Run Catalog Endpoint (kind "catalog") and Run Source (kind "source"): send one run with a saved
 * Idempotency Key, optionally wait for it, and return one item per record.
 */
export async function startRun(
	ctx: IExecuteFunctions,
	i: number,
	kind: 'catalog' | 'source',
	deps: Deps = defaultDeps,
): Promise<INodeExecutionData[]> {
	const options = ctx.getNodeParameter('options', i, {}) as IDataObject;
	const input = parseInput(ctx.getNodeParameter('input', i, '{}'));
	const noMaxItems = ctx.getNodeParameter('noMaxItems', i, false) as boolean;
	const waitForResult = ctx.getNodeParameter('waitForResult', i, true) as boolean;
	const idempotencyKey = validateIdempotencyKey(ctx.getNodeParameter('idempotencyKey', i, ''));
	const nulls = options.nulls === true;
	const expectedVersion =
		kind === 'source'
			? String(ctx.getNodeParameter('expectedVersion', i, '') ?? '').trim() || undefined
			: undefined;

	const body = buildRunBody({
		input,
		maxItems: noMaxItems ? undefined : (ctx.getNodeParameter('maxItems', i, 25) as number),
		timeoutSeconds: numberOption(options, 'timeoutSeconds'),
		// Not waiting means the start request answers at once with the run object.
		waitSeconds: waitForResult ? numberOption(options, 'waitSeconds') : 0,
		fields: parseFields(options.fields),
		nulls,
		version: kind === 'catalog' ? numberOption(options, 'version') : undefined,
		expectedVersion,
		definitionVersion:
			kind === 'source' && typeof options.definitionVersion === 'string'
				? options.definitionVersion
				: undefined,
	});

	let startPath: string;
	let resultRequest: Parameters<typeof executeRun>[1]['resultRequest'];
	if (kind === 'catalog') {
		const api = encodeURIComponent(requiredString(ctx, 'apiId', i));
		const endpoint = encodeURIComponent(requiredString(ctx, 'endpointId', i));
		startPath = `/v1/catalog/public/apis/${api}/endpoints/${endpoint}/run`;
		// The result is read with the same API key and the same Idempotency-Key.
		resultRequest = () => ({
			path: `/v1/catalog/public/apis/${api}/endpoints/${endpoint}/result`,
			headers: { 'Idempotency-Key': idempotencyKey },
		});
	} else {
		startPath = `/v1/sources/${encodeURIComponent(requiredString(ctx, 'sourceId', i))}/run`;
		resultRequest = (runId) => {
			if (!runId) {
				throw new CleanedWebUsageError(
					'The run answered 202 without a run ID, so its result cannot be read',
					'Keep the Idempotency Key and resend the same request to recover the run.',
				);
			}
			return { path: `/v1/runs/${encodeURIComponent(runId)}/result${nulls ? '?nulls=true' : ''}` };
		};
	}

	const outcome = await executeRun(
		ctx,
		{
			startPath,
			body,
			idempotencyKey,
			waitForResult,
			resultRequest,
			maxWaitSeconds: numberOption(options, 'maxWaitSeconds') ?? 900,
			pollFallbackSeconds: numberOption(options, 'pollFallbackSeconds') ?? 30,
		},
		deps,
	);
	if (outcome.finished && options.failOnUnaccepted !== false) {
		assertAccepted(outcome.body, expectedVersion);
	}
	return outcomeToItems(outcome, String(options.outputMode ?? 'records'), i);
}

export async function getRun(ctx: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const runId = requiredString(ctx, 'runId', i);
	const response = await brokerRequest(ctx, {
		method: 'GET',
		path: `/v1/runs/${encodeURIComponent(runId)}`,
	});
	return [paired(response.body, i)];
}

export async function abortRun(ctx: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const runId = requiredString(ctx, 'runId', i);
	// 202 while the run stops; 200 if it had already ended. Both return the run object.
	const response = await brokerRequest(ctx, {
		method: 'POST',
		path: `/v1/runs/${encodeURIComponent(runId)}/abort`,
	});
	return [paired(response.body, i)];
}

export async function getRunItems(
	ctx: IExecuteFunctions,
	i: number,
): Promise<INodeExecutionData[]> {
	const runId = requiredString(ctx, 'runId', i);
	const returnAll = ctx.getNodeParameter('returnAll', i, false) as boolean;
	const options = ctx.getNodeParameter('options', i, {}) as IDataObject;
	const records = await fetchRunItems(ctx, runId, {
		returnAll,
		limit: returnAll ? undefined : (ctx.getNodeParameter('limit', i, 50) as number),
		pageSize: numberOption(options, 'pageSize') ?? 100,
		startCursor: typeof options.startCursor === 'string' ? options.startCursor : '0',
		nulls: options.nulls === true,
	});
	return pairedAll(records, i);
}

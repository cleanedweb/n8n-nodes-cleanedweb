import type { INodeProperties } from 'n8n-workflow';

import { IDEMPOTENCY_KEY_DEFAULT } from '../constants';
import { endpointPickers } from './CatalogDescription';

const show = { resource: ['run'] };

export const runOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show },
		options: [
			{
				name: 'Abort',
				value: 'abort',
				description:
					'Stop a run. Records committed so far stay readable and charged. Needs the run scope',
				action: 'Abort a run',
			},
			{
				name: 'Get',
				value: 'get',
				description: 'Read a run: status, stop reason, progress and units charged',
				action: 'Get a run',
			},
			{
				name: 'Get Items',
				value: 'getItems',
				description: 'Read the records a run has committed so far, one n8n item per record',
				action: 'Get the records of a run',
			},
			{
				name: 'Run Catalog Endpoint',
				value: 'runCatalog',
				description: 'Run a published catalog API and return its records. A run is charged per record delivered.',
				action: 'Run a catalog API endpoint',
			},
		],
		default: 'runCatalog',
	},
];

const runIdField = (operations: string[]): INodeProperties => ({
	displayName: 'Run ID',
	name: 'runId',
	type: 'string',
	required: true,
	default: '',
	placeholder: 'e.g. 3f0c2a9e5b7d4c1a8e6f0b2d4a6c8e10',
	displayOptions: { show: { ...show, operation: operations } },
	description: 'The run ID: 32 lowercase hexadecimal characters, as returned by a run',
});

/**
 * The fields every run-starting operation shares: input, record limit, wait behavior,
 * Idempotency Key and options. `kind` selects the options that exist only for one of the two.
 */
export function runStartFields(
	showOn: Record<string, string[]>,
	kind: 'catalog' | 'source',
): INodeProperties[] {
	const options: INodeProperties[] = [
		{
			displayName: 'Fail on Unaccepted Result',
			name: 'failOnUnaccepted',
			type: 'boolean',
			default: true,
			description:
				'Whether to fail the node when the finished run is partial or out of scope, instead of returning its records. The records stay readable with Get Items. Checks summary.status (completed or bounded) and summary.within_scope_passed.',
		},
		{
			displayName: 'Fields',
			name: 'fields',
			type: 'string',
			default: '',
			placeholder: 'e.g. title,url',
			description:
				'Comma-separated output fields to return. Required and identity fields are always kept. Names the API does not publish are rejected.',
		},
		{
			displayName: 'Include Null Fields',
			name: 'nulls',
			type: 'boolean',
			default: false,
			description: 'Whether to send every published field, with absent values as null',
		},
		{
			displayName: 'Max Wait (Seconds)',
			name: 'maxWaitSeconds',
			type: 'number',
			typeOptions: { minValue: 1, maxValue: 86400 },
			default: 900,
			description:
				'How long this node waits for a run to end before failing. The run itself continues on the server; read it later with Get or Get Items.',
		},
		{
			displayName: 'Output',
			name: 'outputMode',
			type: 'options',
			options: [
				{
					name: 'One Item per Record',
					value: 'records',
					description: 'One n8n item per record. The run summary is not included.',
				},
				{
					name: 'Full Response',
					value: 'full',
					description: 'One item with records, summary, metadata, run and delivery',
				},
			],
			default: 'records',
		},
		{
			displayName: 'Poll Interval Fallback (Seconds)',
			name: 'pollFallbackSeconds',
			type: 'number',
			typeOptions: { minValue: 1, maxValue: 3600 },
			default: 30,
			description:
				'How long to wait between result reads when the server gives no Retry-After or poll_after_seconds',
		},
		{
			displayName: 'Run Timeout (Seconds)',
			name: 'timeoutSeconds',
			type: 'number',
			typeOptions: { minValue: 60, maxValue: 86400 },
			default: 10800,
			description:
				"The run's own time budget, from when it starts running. The run then ends with the records it has. Changing it creates a new request identity.",
		},
		{
			displayName: 'Wait per Request (Seconds)',
			name: 'waitSeconds',
			type: 'number',
			typeOptions: { minValue: 0, maxValue: 86400 },
			default: 90,
			description:
				'How long the start request waits for the run to end before answering 202. It does not change the run or its identity.',
		},
	];

	if (kind === 'catalog') {
		options.push({
			displayName: 'Major Version',
			name: 'version',
			type: 'number',
			typeOptions: { minValue: 1 },
			default: 1,
			description:
				'Pin the API to this major version so a newer major cannot change your results. Leave unset to run the latest major.',
		});
	} else {
		options.push({
			displayName: 'Definition Version',
			name: 'definitionVersion',
			type: 'string',
			default: '',
			description:
				'Select an accepted immutable revision explicitly (64-character lowercase SHA-256). Use instead of Expected Version, never both.',
		});
	}
	options.sort((a, b) => a.displayName.localeCompare(b.displayName));

	return [
		{
			displayName: 'Input',
			name: 'input',
			type: 'json',
			required: true,
			default: '{}',
			displayOptions: { show: showOn },
			description:
				'The inputs from the API contract, as a JSON object. Read the contract first: every input its required list names must be sent, unknown inputs are rejected. {} is valid when none is required.',
		},
		{
			displayName: 'Run Without Max Items',
			name: 'noMaxItems',
			type: 'boolean',
			default: false,
			displayOptions: { show: showOn },
			description:
				'Whether to run without a record cap. The run then ends when the source has no more records, or by time or money. A run is charged per record delivered.',
		},
		{
			displayName: 'Max Items',
			name: 'maxItems',
			type: 'number',
			typeOptions: { minValue: 1 },
			default: 25,
			displayOptions: { show: { ...showOn, noMaxItems: [false] } },
			description:
				'Stop after this many de-duplicated records (max_items). Start small while you check the shape of the records.',
		},
		{
			displayName: 'Wait for Result',
			name: 'waitForResult',
			type: 'boolean',
			default: true,
			displayOptions: { show: showOn },
			description:
				'Whether to wait until the run ends and return its records. When off, the node returns the run object right away and the run continues on the server.',
		},
		{
			displayName: 'Idempotency Key',
			name: 'idempotencyKey',
			type: 'string',
			required: true,
			default: IDEMPOTENCY_KEY_DEFAULT,
			displayOptions: { show: showOn },
			description:
				'Identifies this one request. The same key and request return the original run instead of starting another, so a retry or a lost response never charges twice; a new key starts a new run. 1-200 characters: letters, numbers, ".", "_", ":", "-". The default is unique per execution, run index and item; two CleanedWeb nodes in one workflow need different keys.',
		},
		{
			displayName: 'Options',
			name: 'options',
			type: 'collection',
			placeholder: 'Add Option',
			default: {},
			displayOptions: { show: showOn },
			options,
		},
	];
}

export const runFields: INodeProperties[] = [
	// Run Catalog Endpoint
	...endpointPickers({ ...show, operation: ['runCatalog'] }),
	...runStartFields({ ...show, operation: ['runCatalog'] }, 'catalog'),
	// Get / Get Items / Abort
	runIdField(['get', 'getItems', 'abort']),
	// Get Items
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		displayOptions: { show: { ...show, operation: ['getItems'] } },
		description: 'Whether to return all results or only up to a given limit',
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: { minValue: 1 },
		default: 50,
		displayOptions: { show: { ...show, operation: ['getItems'], returnAll: [false] } },
		description: 'Max number of results to return',
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: { ...show, operation: ['getItems'] } },
		options: [
			{
				displayName: 'Include Null Fields',
				name: 'nulls',
				type: 'boolean',
				default: false,
				description: 'Whether to send every published field, with absent values as null',
			},
			{
				displayName: 'Page Size',
				name: 'pageSize',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 1000 },
				default: 100,
				description: 'Records requested per page while following the cursor',
			},
			{
				displayName: 'Start Cursor',
				name: 'startCursor',
				type: 'string',
				default: '0',
				description: 'Where to start reading; 0 is the first record',
			},
		],
	},
];

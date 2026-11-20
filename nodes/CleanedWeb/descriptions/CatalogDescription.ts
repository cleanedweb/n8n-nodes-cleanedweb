import type { INodeProperties } from 'n8n-workflow';

const show = { resource: ['catalog'] };

export const catalogOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show },
		options: [
			{
				name: 'Get API Contract',
				value: 'getContract',
				description:
					'Read the live contract of an endpoint: input schema, output schema and the definition version a run uses',
				action: 'Get the contract of a catalog API endpoint',
			},
			{
				name: 'List APIs',
				value: 'list',
				description: 'List the published catalog APIs (needs no API key)',
				action: 'List published API listings',
			},
		],
		default: 'list',
	},
];

/** The API and endpoint pickers, shared by every operation that targets a catalog endpoint. */
export function endpointPickers(show: Record<string, string[]>): INodeProperties[] {
	return [
		{
			displayName: 'API Name or ID',
			name: 'apiId',
			type: 'options',
			typeOptions: { loadOptionsMethod: 'getCatalogApis' },
			required: true,
			default: '',
			displayOptions: { show },
			description:
				'The published API from the live catalog. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		},
		{
			displayName: 'Endpoint Name or ID',
			name: 'endpointId',
			type: 'options',
			typeOptions: {
				loadOptionsMethod: 'getCatalogEndpoints',
				loadOptionsDependsOn: ['apiId'],
			},
			required: true,
			default: '',
			displayOptions: { show },
			description:
				'The endpoint to use. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		},
	];
}

export const catalogFields: INodeProperties[] = [
	// List APIs
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		description: 'Whether to return all results or only up to a given limit',
		displayOptions: { show: { ...show, operation: ['list'] } },
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: { minValue: 1 },
		default: 50,
		description: 'Max number of results to return',
		displayOptions: { show: { ...show, operation: ['list'], returnAll: [false] } },
	},
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: { show: { ...show, operation: ['list'] } },
		options: [
			{
				displayName: 'Category',
				name: 'category',
				type: 'string',
				default: '',
				description: 'Only APIs in this category, for example commerce',
			},
			{
				displayName: 'Search Text',
				name: 'q',
				type: 'string',
				default: '',
				description: 'Search the published APIs by text',
			},
			{
				displayName: 'Sort By',
				name: 'sort',
				type: 'options',
				options: [
					{ name: 'Name', value: 'name' },
					{ name: 'Recently Updated', value: 'updated' },
				],
				default: 'updated',
			},
		],
	},
	// Get API Contract
	...endpointPickers({ ...show, operation: ['getContract'] }),
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: { ...show, operation: ['getContract'] } },
		options: [
			{
				displayName: 'Major Version',
				name: 'version',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 1,
				description:
					'Read the contract of this major version, as the callers of that major receive it. Leave unset for the latest major.',
			},
		],
	},
];

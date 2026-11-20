import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { CREDENTIAL_NAME } from './constants';
import { catalogFields, catalogOperations } from './descriptions/CatalogDescription';
import { privateApiFields, privateApiOperations } from './descriptions/PrivateApiDescription';
import { runFields, runOperations } from './descriptions/RunDescription';
import {
	BrokerError,
	CleanedWebUsageError,
	getCatalogApi,
	isRecord,
	listCatalogApis,
	ResultNotAcceptedError,
	RunStillRunningError,
} from './GenericFunctions';
import {
	abortRun,
	getApiContract,
	getRun,
	getRunItems,
	listApis,
	startRun,
} from './Operations';

/** Turn any failure of this node into the n8n error type that shows the right message. */
function toNodeError(ctx: IExecuteFunctions, error: unknown, itemIndex: number): Error {
	const node = ctx.getNode();
	if (error instanceof BrokerError) {
		const response = { message: error.message, code: error.code, errorCode: error.errorCode } as JsonObject;
		return new NodeApiError(node, response, {
			message: error.message,
			description: error.description,
			httpCode: error.statusCode ? String(error.statusCode) : undefined,
			itemIndex,
		});
	}
	if (error instanceof RunStillRunningError) {
		return new NodeOperationError(node, error.message, {
			itemIndex,
			description:
				'The run continues on the server and is charged per record delivered. Read it with the Run > Get or Get Items operation, or stop it with Abort, using the run ID.',
		});
	}
	if (error instanceof ResultNotAcceptedError) {
		return new NodeOperationError(node, error.message, {
			itemIndex,
			description:
				'The records the run saved stay readable and charged: read them with Run > Get Items. Turn off "Fail on Unaccepted Result" to receive them directly.',
		});
	}
	if (error instanceof CleanedWebUsageError) {
		return new NodeOperationError(node, error.message, { itemIndex, description: error.description });
	}
	if (error instanceof NodeApiError || error instanceof NodeOperationError) return error;
	if (error instanceof Error && 'httpCode' in error) {
		// An error from the anonymous catalog read (httpRequest throws on non-2xx).
		return new NodeApiError(node, error as unknown as JsonObject, { itemIndex });
	}
	return new NodeOperationError(node, error as Error, { itemIndex });
}

export class CleanedWeb implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'CleanedWeb',
		name: 'cleanedWeb',
		icon: { light: 'file:cleanedweb.svg', dark: 'file:cleanedweb.dark.svg' },
		group: ['input'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Run maintained APIs for public website collections and read their structured records',
		defaults: { name: 'CleanedWeb' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: CREDENTIAL_NAME,
				required: true,
				// Reading the catalog needs no API key.
				displayOptions: { show: { resource: ['run', 'privateApi'] } },
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Catalog', value: 'catalog' },
					{ name: 'Private API', value: 'privateApi' },
					{ name: 'Run', value: 'run' },
				],
				default: 'run',
			},
			...catalogOperations,
			...catalogFields,
			...runOperations,
			...runFields,
			...privateApiOperations,
			...privateApiFields,
		],
	};

	methods = {
		loadOptions: {
			async getCatalogApis(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const apis = await listCatalogApis(this, { sort: 'name' });
				return apis
					.filter((api) => typeof api.api_id === 'string')
					.map((api) => {
						const site = isRecord(api.site) ? api.site : {};
						const domain = typeof site.domain === 'string' ? ` (${site.domain})` : '';
						return {
							name: `${String(api.name ?? api.api_id)}${domain}`,
							value: String(api.api_id),
							description:
								typeof api.short_description === 'string' ? api.short_description : undefined,
						};
					});
			},

			async getCatalogEndpoints(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const apiId = this.getCurrentNodeParameter('apiId');
				// An unresolved expression cannot name an API; the field then takes a typed ID.
				if (typeof apiId !== 'string' || apiId === '' || apiId.startsWith('=')) return [];
				const api = await getCatalogApi(this, apiId);
				const endpoints = Array.isArray(api.endpoints) ? (api.endpoints as IDataObject[]) : [];
				return endpoints
					.filter((endpoint) => typeof endpoint.endpoint_id === 'string')
					.map((endpoint) => ({
						name: String(endpoint.name ?? endpoint.endpoint_id),
						value: String(endpoint.endpoint_id),
						description:
							(typeof endpoint.description === 'string' ? endpoint.description : '') +
							(endpoint.status && endpoint.status !== 'available'
								? ` (status: ${String(endpoint.status)})`
								: ''),
					}));
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		for (let i = 0; i < items.length; i++) {
			try {
				let result: INodeExecutionData[];
				if (resource === 'catalog' && operation === 'list') {
					result = await listApis(this, i);
				} else if (resource === 'catalog' && operation === 'getContract') {
					result = await getApiContract(this, i);
				} else if (resource === 'run' && operation === 'runCatalog') {
					result = await startRun(this, i, 'catalog');
				} else if (resource === 'run' && operation === 'get') {
					result = await getRun(this, i);
				} else if (resource === 'run' && operation === 'getItems') {
					result = await getRunItems(this, i);
				} else if (resource === 'run' && operation === 'abort') {
					result = await abortRun(this, i);
				} else if (resource === 'privateApi' && operation === 'runSource') {
					result = await startRun(this, i, 'source');
				} else {
					throw new NodeOperationError(
						this.getNode(),
						`The operation "${operation}" is not supported for "${resource}"`,
						{ itemIndex: i },
					);
				}
				returnData.push(...result);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				throw toNodeError(this, error, i);
			}
		}
		return [returnData];
	}
}

import type { INodeProperties } from 'n8n-workflow';

import { runStartFields } from './RunDescription';

const show = { resource: ['privateApi'] };

export const privateApiOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show },
		options: [
			{
				name: 'Run Source',
				value: 'runSource',
				description:
					'Run one of your own private APIs (a source of your workspace) and return its records',
				action: 'Run a private API source',
			},
		],
		default: 'runSource',
	},
];

export const privateApiFields: INodeProperties[] = [
	{
		displayName: 'Source ID',
		name: 'sourceId',
		type: 'string',
		required: true,
		default: '',
		displayOptions: { show: { ...show, operation: ['runSource'] } },
		description: 'The source identifier from the API connection details in the console',
	},
	{
		displayName: 'Expected Version',
		name: 'expectedVersion',
		type: 'string',
		default: '',
		displayOptions: { show: { ...show, operation: ['runSource'] } },
		description:
			'Require the active definition to match this full 64-character lowercase SHA-256 version. Recommended for normal execution; the run fails on a mismatch instead of running another definition.',
	},
	...runStartFields({ ...show, operation: ['runSource'] }, 'source'),
];

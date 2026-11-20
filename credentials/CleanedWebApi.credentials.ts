import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

import { DEFAULT_RUN_ORIGIN } from '../nodes/CleanedWeb/constants';

export class CleanedWebApi implements ICredentialType {
	name = 'cleanedWebApi';

	displayName = 'CleanedWeb API';

	icon = {
		light: 'file:../nodes/CleanedWeb/cleanedweb.svg',
		dark: 'file:../nodes/CleanedWeb/cleanedweb.dark.svg',
	} as const;

	documentationUrl =
		'https://cleanedweb.com/docs/authentication/?utm_source=github&utm_medium=n8n-nodes-cleanedweb';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description:
				'A CleanedWeb API key with the run scope. Runs use the credits of its workspace; keep it secret.',
		},
		{
			displayName: 'Run Origin',
			name: 'origin',
			type: 'string',
			default: DEFAULT_RUN_ORIGIN,
			description:
				'Where runs and results are served, without a path. Leave the default unless your workspace supplies another origin. The API key is sent only to this origin, over https.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	// A cheap authenticated read: the caller's newest run. It never starts a run or uses credit.
	test: ICredentialTestRequest = {
		request: {
			baseURL: `={{$credentials.origin || '${DEFAULT_RUN_ORIGIN}'}}`,
			url: '/v1/runs',
			method: 'GET',
			qs: { limit: 1 },
		},
	};
}

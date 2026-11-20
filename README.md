# n8n-nodes-cleanedweb

This is an n8n community node for [CleanedWeb](https://cleanedweb.com/?utm_source=github&utm_medium=n8n-nodes-cleanedweb). It lets you run CleanedWeb's maintained REST APIs from n8n workflows and AI agents.

CleanedWeb turns public website collections into maintained REST APIs that return structured records. 5,000 records are free once, then credit is prepaid from $1 per 1,000 records. A run is charged per record delivered.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

> Status: private repository, not yet published to npm or submitted to the n8n Creator Portal.

- [Installation](#installation)
- [Operations](#operations)
- [Credentials](#credentials)
- [Using the node](#using-the-node)
- [Compatibility](#compatibility)
- [Example workflows](#example-workflows)
- [Development](#development)
- [Resources](#resources)
- [Version history](#version-history)

## Installation

Follow the [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) and install `n8n-nodes-cleanedweb`.

Until the package is on npm, build it and install the tarball into your n8n's `~/.n8n/nodes` folder:

```bash
npm ci && npm run build && npm pack
cd ~/.n8n/nodes && npm install /path/to/n8n-nodes-cleanedweb-0.1.0.tgz
```

Then restart n8n.

## Operations

| Resource | Operation | What it does | API key |
| --- | --- | --- | --- |
| Catalog | List APIs | Lists the published catalog APIs from the live catalog (`app.cleanedweb.com/api/catalog/apis`), with text search, category and sort. One item per API. | not needed |
| Catalog | Get API Contract | Reads the live contract of an endpoint: input schema, output schema, definition version. Optionally for a pinned major version. | not needed |
| Run | Run Catalog Endpoint | Runs a catalog API endpoint and returns its records, one n8n item per record. | `run` scope |
| Run | Get | Reads a run: status, stop reason, progress, units charged. | `run` or `results` scope |
| Run | Get Items | Reads the records a run has committed so far (also while it is running), following the cursor. | `run` or `results` scope |
| Run | Abort | Stops a run. Records committed so far stay readable and charged. | `run` scope |
| Private API | Run Source | Runs one of your own private APIs (`POST /v1/sources/{source_id}/run`) and returns its records. | `run` scope with access to the source |

The node is usable as a tool by n8n AI agents (`usableAsTool`).

## Credentials

1. Create a CleanedWeb account and an API key with the `run` scope ([authentication](https://cleanedweb.com/docs/authentication/?utm_source=github&utm_medium=n8n-nodes-cleanedweb)). Add `results` only if you also read retained results.
2. In n8n, create a **CleanedWeb API** credential and paste the key.
3. Leave **Run Origin** at `https://api.cleanedweb.com` unless your workspace supplies another origin. The key is sent only to this origin, over https, and the node does not follow redirects.

The credential test calls `GET /v1/runs?limit=1`, a read-only request that starts nothing and uses no credit.

The Catalog operations need no credential; n8n does not ask for one when only they are used.

## Using the node

### Run a catalog API

1. Choose **Run > Run Catalog Endpoint**, then the **API** and **Endpoint** from the live catalog. (Or use an expression with an API ID and endpoint ID.)
2. Read the endpoint's contract (**Catalog > Get API Contract**, or its page in the [catalog](https://cleanedweb.com/catalog/?utm_source=github&utm_medium=n8n-nodes-cleanedweb)) and set **Input** to a JSON object of the inputs it names. Every input in `input_schema.required` must be sent; `{}` is valid when none is required. Unknown inputs are rejected.
3. Set **Max Items**. The default is 25, so a first run stays small. **Run Without Max Items** lets the run end when the source has no more records, or by time or money.
4. Each output item is one record.

### Idempotency Key

CleanedWeb requires an `Idempotency-Key` on every run. The same key with the same request returns the original run instead of starting another, so an n8n retry or a lost response does not charge twice. A new key starts a new run.

The default is `{{ $execution.id }}-{{ $runIndex }}-{{ $itemIndex }}`:

- It is stable across n8n's *Retry On Fail* of the same node, so a retry recovers the same run.
- Every execution has its own id, so every scheduled run and every click on *Test workflow* is a new run, and a new charge.
- Two CleanedWeb run nodes in the same workflow share it; give one of them a different key (for example add a suffix) or the second answers `409 delivery_identity_conflict`.
- A key must be 1-200 characters: letters, numbers, `.`, `_`, `:`, `-`.
- A run that failed is final for its key: the same key returns the same error for 7 days. Use a new key to run again.

### Waiting for the result

With **Wait for Result** on (the default), the node sends the run request, and when the server answers `202` it reads `.../result` with the same API key and Idempotency Key, waiting `Retry-After` seconds (or `poll_after_seconds`, or **Poll Interval Fallback**) between reads, until the run ends. The POST is never sent again with a new key.

- If a request fails with a timeout, a lost connection, or a gateway error that does not show whether the run started, the node repeats the same request with the same key (up to 3 times), because a repeat returns the original run.
- If the run is still going after **Max Wait (Seconds)** (default 900), the node fails with the run ID. The run continues on the server and is charged per record delivered. Read it with **Run > Get** or **Get Items**, or stop it with **Abort**.
- With **Wait for Result** off, the node returns the run object right away (`run_id`, `status`, `links`). Pair it with a *Wait* node and **Get Items**; see the example.

### Accepting a result

HTTP 200 alone does not show a usable result. By default (**Fail on Unaccepted Result**) the node fails when `summary.status` is not `completed` or `bounded`, or `summary.within_scope_passed` is not `true`. The records the run saved stay readable and charged: switch the option off to receive them, or read them with **Get Items**. `bounded` and `partial` results can leave records uncollected at the source; see the stop reasons in the [run reference](https://cleanedweb.com/docs/run-catalog-api/?utm_source=github&utm_medium=n8n-nodes-cleanedweb#stop-reasons). For **Run Source** with an **Expected Version**, the result's `summary.definition_version` must also match it.

Choose **Output > Full Response** to get one item with `records`, `summary`, `metadata`, `run` and `delivery` (run ID, record count) for your own storage envelope.

### Other options

| Option | Meaning |
| --- | --- |
| Major Version | Pin the API to a major (`version`) so a newer major cannot change your results. Pin one in production. |
| Fields | Comma-separated output fields to return. |
| Include Null Fields | Send every published field, with absent values as `null`. |
| Run Timeout (Seconds) | The run's own time budget, 60-86400, default 10800. Changing it, `Input` or `Max Items` creates a new request identity. |
| Wait per Request (Seconds) | How long each start request waits before answering `202`, 0-86400, default 90. Not part of the request identity. |
| Definition Version (Run Source) | Select an accepted revision explicitly. Use instead of **Expected Version**, never both. |

Notes:

- **Include Null Fields** is applied to the first answer and to `Get Items`; the catalog result route does not take it, so a run that needed polling returns the records as that route delivers them.
- Reading a result never collects the website again and never charges again.

### Scheduling and storage

n8n's Schedule Trigger is the scheduler; see CleanedWeb's guides to [scheduled runs](https://cleanedweb.com/docs/scheduled-runs/?utm_source=github&utm_medium=n8n-nodes-cleanedweb) and [storing results](https://cleanedweb.com/docs/storing-results/?utm_source=github&utm_medium=n8n-nodes-cleanedweb): keep the run ID, deduplicate across runs yourself, and never delete rows missing from a bounded result.

## Compatibility

- Requires Node.js 20.15 or newer and an n8n version that supports `n8nNodesApiVersion` 1 (the `n8n-workflow` peer dependency is not pinned).
- The node was loaded and its no-key operations executed on n8n 2.48.6 (see `CHANGELOG.md`). The paid run operations are covered by unit tests with mocked helpers; they have not yet been run live.
- The package has no runtime dependencies.

## Example workflows

Import these from n8n's **Import from File**:

| File | What it shows |
| --- | --- |
| [`examples/catalog-list-and-contract.json`](examples/catalog-list-and-contract.json) | List APIs, then read each one's contract. Needs no API key. |
| [`examples/run-catalog-api-daily.json`](examples/run-catalog-api-daily.json) | Schedule, run the GitHub Topics Repositories API (25 records), keep two fields. |
| [`examples/recover-a-run.json`](examples/recover-a-run.json) | Start without waiting, wait, then read the run's items. |

Replace the credential placeholder after import. The run examples use real runs that are charged per record.

## Development

```bash
npm ci
npm run lint      # n8n's linter (@n8n/node-cli)
npm run build
npm test          # builds, then runs the unit tests (mocked helpers, no network)
npm run dev       # n8n with the node linked (needs Docker or Podman)
```

The unit tests in `test/` cover request building, idempotency and retry behavior, `Retry-After` polling, result acceptance and pagination. No test sends a request to CleanedWeb.

## Resources

- [CleanedWeb](https://cleanedweb.com/?utm_source=github&utm_medium=n8n-nodes-cleanedweb)
- [Published catalog APIs](https://cleanedweb.com/docs/catalog-apis/?utm_source=github&utm_medium=n8n-nodes-cleanedweb) and the [catalog](https://cleanedweb.com/catalog/?utm_source=github&utm_medium=n8n-nodes-cleanedweb)
- [Run a catalog API](https://cleanedweb.com/docs/run-catalog-api/?utm_source=github&utm_medium=n8n-nodes-cleanedweb)
- [Run an API (private sources)](https://cleanedweb.com/docs/run-api/?utm_source=github&utm_medium=n8n-nodes-cleanedweb)
- [Idempotency and recovery](https://cleanedweb.com/docs/idempotency/?utm_source=github&utm_medium=n8n-nodes-cleanedweb)
- [Billing and Units](https://cleanedweb.com/docs/billing/?utm_source=github&utm_medium=n8n-nodes-cleanedweb)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)

## Version history

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)

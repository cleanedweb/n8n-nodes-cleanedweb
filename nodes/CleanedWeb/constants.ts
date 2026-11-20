/** Run origin: runs, results and run routes are served here. Also the credential default. */
export const DEFAULT_RUN_ORIGIN = 'https://api.cleanedweb.com';

/** Anonymous catalog reads (live list and live contracts). */
export const CATALOG_ORIGIN = 'https://app.cleanedweb.com';

export const CREDENTIAL_NAME = 'cleanedWebApi';

/** Catalog page size accepted by `/api/catalog/apis` is 1-100. */
export const CATALOG_PAGE_SIZE = 100;
/** Upper bound for the dropdown loader (50 pages of 100 APIs). */
export const CATALOG_MAX_PAGES = 50;

/** Server defaults, mirrored from the run reference. */
export const DEFAULT_WAIT_SECONDS = 90;
export const MIN_TIMEOUT_SECONDS = 60;
export const MAX_RUN_SECONDS = 86400;

/** Idempotency-Key grammar: 1-200 of letters, numbers, `.`, `_`, `:`, `-`. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

/** Default for the Idempotency Key parameter (an n8n expression). */
export const IDEMPOTENCY_KEY_DEFAULT = '={{ $execution.id }}-{{ $runIndex }}-{{ $itemIndex }}';

/** Run summary statuses a result may be accepted with. */
export const ACCEPTED_SUMMARY_STATUSES = ['completed', 'bounded'];

/** Failed-run markers: the run failed and the key is final. */
export const FAILED_RUN_MARKERS = ['run_failed', 'failed_run_replayed'];

/** Bounded retry of an identical (same key) request after an unsure failure. */
export const UNSURE_RETRY_ATTEMPTS = 3;
export const UNSURE_RETRY_BASE_MS = 2000;

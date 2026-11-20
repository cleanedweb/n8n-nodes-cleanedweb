# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-20

First version, kept private until reviewed.

### Added

- Credential `CleanedWeb API` (API key sent as a Bearer token, optional run origin) with a
  credential test against `GET /v1/runs?limit=1`.
- Node `CleanedWeb` (usable as an AI agent tool) with:
  - Catalog: List APIs, Get API Contract (no API key needed).
  - Run: Run Catalog Endpoint, Get, Get Items, Abort.
  - Private API: Run Source.
- API and endpoint pickers loaded from the live catalog.
- Run options: input JSON, max items, Idempotency Key (default `{{ $execution.id }}-{{ $runIndex }}-{{ $itemIndex }}`),
  wait for result with polling that honors `Retry-After`, major version pin, output field selection, null filling,
  run timeout and per-request wait.
- One n8n item per record; full-response output as an option.
- Result check from the run reference: partial or out-of-scope results fail the node unless switched off.
- Example workflows in `examples/`.

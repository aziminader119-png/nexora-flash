# NEXORA Flash — Profit Engine v3 (predeployment release candidate)

**Operational mode: SCAN_ONLY.** This package does not turn on live execution.
The existing website UI, deployed server, signer, exchange credentials and
operator settings are NOT changed by creating this branch.

## Phase A — Opportunity discovery and sizing
Inherited from PRs 19–23: original market metadata discovery reintroduced
for ten DEX targets (Base/Arbitrum), canonicalized token addresses, conservative
liquidity/volume heuristics and documented `venueCoverage`. Uses only
DEX Screener metadata for **discovery**. Discovery signals cannot fund orders.
The on-chain catalog independently quotes 2–10-leg loops with priority toward
low-hop high-net-USD routes, fair depth floors, exact same-block quote cache,
and adaptive midpoint loan-size quotes on near-positive route families.
It never infers an amount optimum outside the actual quoted sample.

## Phase B — Independent next-block economic quality
New `lib/shadow-verifier.mjs` examines up to two high-estimate opportunities
from the previous cycle, only after a *newer* block. It re-quotes each swap,
fresh native/fiat rate, current gas estimate, **fresh provider liquidity and
flash-loan fee**, and labels quote decay. All routes and pools must match the
pre-existing exact registry. A different/unknown pool or a failed quote is
excluded. The work is bounded to 16 swap quotes per network and the module
has a time budget; it is strictly non-executable.

`GET /api/shadow/quality` returns the latest observation for each network.
`GET /api/shadow/metrics` provides bounded, persistent, sampled 24-hour
retention statistics and estimated USD quote decay (p10/p50/p90); append-only
JSONL is stored in `DATA_DIR/shadow-metrics.jsonl`.
**This is NOT a full atomic transaction simulation, not realized P&L,
and not an execution authorization.** The route's quoted gas model remains
a conservative approximation rather than actual transaction gas.

## Phase C — Reliability and error containment
PR 24 invalidates stale opportunities, erroneous cross-network/cross-block
quotes and unclosed routes. PR 25 requires the execution journal to be intact,
even after restart; malformed/torn records block any new funded transaction.
It also blocks recommending apparently profitable routes whose venue or gas
limits do not qualify.

New `lib/scan-breaker.mjs` detects repeated RPC scan failures **per chain**,
temporarily stops *scan-only* heavy quoting for that network, and safely
returns to it after a cooldown with a single half-open probe. It NEVER
blocks pending transaction receipt/nonce recovery. Other networks continue.
`GET /api/scanner/health` reports circuit state, without UI changes.

## Phase D — Acceptance and one-shot deployment
CI required for exact release SHA:
- Node unit tests (including shadow economic scenarios, failed lenders,
  time budget and RPC half-open recovery).
- Solidity contract suite.
- All five configured fork suites.
- Local E2E and Base-fork E2E.
- Installer smoke, lockfile and final gate-report.

The one-shot installer `scripts/install-scan-only-update.sh` already exists.
It preserves the frontend, source data directory, keys, and operational
settings, checks exact SHA, requires explicit trading-off settings, backs up
the backend, runs preflight checks and rolls back on failure.
**Installation has NOT occurred in this branch.**

## Unresolved safety and profitability gates
1. Ten target DEX brands are discovery metadata, NOT ten independently
   verified exchange adapters. Venue-specific factory, quoter/router,
   fee model, token decimals, code identity, real reserves and fork
   round trips require further audits before any funded integration.
2. A shadow quote retaining a profit target is not proof the same transaction
   can capture that amount, survive front-running, or be ordered in time.
3. The bot still needs sustained real-network shadow observation of liquidity,
   stale-block lag, RPC errors, net quote decay and full atomic fork simulation
   for actual discovered pools. CI tests may use deterministic test fixtures.
4. Explicit operator approval is required before any change to
   `LIVE_EXECUTION=false`, `MULTIHOP_EXECUTION_ENABLED=false`,
   `autoExecute:false`, or `liveChains:[]`. Do NOT activate without a
   successful live-shadow acceptance report and independent contract audit.
5. No trading strategy can guarantee a profitable arbitrage opportunity.

## Post-install acceptance (all read-only)
```bash
curl -fsS http://127.0.0.1:3080/api/status | jq '{mode,liveExecutionEnabled,longRouteExecutionOptIn,networks}'
curl -fsS http://127.0.0.1:3080/api/scanner/health | jq .
curl -fsS http://127.0.0.1:3080/api/routes/ranked | jq '{total,bestObserved,recommendedForFurtherReview}'
curl -fsS http://127.0.0.1:3080/api/shadow/metrics | jq .
curl -fsS 'http://127.0.0.1:3080/api/discovery/spreads?chain=base' | jq '{observedPools,totalSignals,venueCoverage,sourceCoverage}'
```

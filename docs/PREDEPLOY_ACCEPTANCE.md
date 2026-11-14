# NEXORA predeployment acceptance — 2026-11-14

Status: source changes in a branch; not installed to any server. No live orders.

## Verified scope
- Market metadata discovery: the original HTML `priceUsd`-spread concept
  has been replaced with more restrictive *same ordered token* `priceNative`
  screening. Ten DEX protocols are discovery targets, not approved executable
  venues. `venueCoverage` lists present and missing targets.
- Seed coverage: per-chain bounded public token-pair queries. One unavailable
  token seed cannot erase other observed results; `sourceCoverage.complete`
  explicitly reports completeness. Total outage returns HTTP 503, not zero
  opportunities. Same-hour cache and request coalescing bound upstream calls.
- Amount selection: `GET /api/routes/intelligence` compares observed
  2–10-hop candidates from the latest scan at *the same block* per exact
  pool+token-direction+fee route, selecting the largest **quoted net USD**
  outcome, not the largest percentage return. It cannot infer an
  unquoted optimum or trade size from external published pool metadata.
- The impact probe budget is allocated only to routes clearing the
  configured estimated net-profit threshold and distinct pool paths.
  If no candidate qualifies, it is safer to probe none than claim
  they are liquid. Diagnostics are independent of all trade permissions.
- Existing authenticated execution endpoints, authorization checks,
  contracts, signer, UI and configuration are unchanged. All outputs
  added here are scan-only and `executable:false`.

## Explicit remaining gates
Live real-price correctness, exact pair-address mapping and market data
availability depend on the public API and actual network RPC, and cannot
be proven solely by mocked tests. All 10 DEX target labels are not equivalent
to functional chain adapters. **No automatic promotion** from DEX Screener
metadata to the trusted venue registry; such promotion requires separate
contract-identity, fee-tier, token/decimals, liquidity and fork validation.

No strategy can guarantee opportunities or profit in adversarial
DEX markets. The historical HTML's $10,000 ratio-based profits were
indicative. Cross-check by capturing same-block fee-inclusive route quotes,
then independently simulating the full atomic swap and lender repayment.

## Installation constraints
Do not touch the running server until all exact-commit workflows succeed
and a deploy rollback artifact is prepared. On final deployment preserve
`LIVE_EXECUTION=false`, `MULTIHOP_EXECUTION_ENABLED=false`,
`liveChains:[]`, and `autoExecute:false`. Do not expose the
localhost API to the public internet or alter the original dashboard.

First production scan should inspect:
- `/api/status` for all five networks and 3–10-hop counters
- `/api/discovery/spreads?chain=base` (and `arbitrum`) for actual target
  coverage and partial failures
- `/api/routes/intelligence` for same-block quote-size selection
- `/api/routes/ranked` for lender/impact/fork review reasons

All deployment steps are intentionally deferred to a separate server turn.

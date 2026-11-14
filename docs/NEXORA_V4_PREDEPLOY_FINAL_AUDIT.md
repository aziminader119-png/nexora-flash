# NEXORA v4 predeployment hardening — exact-source release checklist

**Status:** Source implementation for scan-only analysis. DO NOT run funded trades.
**Scope:** NEXORA Flash, not MITMARKET or the Binance Futures bot. Original UI untouched.

## Implemented in this phase (PR #27)
1. `lib/catalog-preflight.mjs`: validates explicit on-chain route catalog
   at one pinned block: chain ID, bytecode existence, token bytecode/decimals,
   conservative bounded test quotes, invalid quote and wrong network rejection.\n   The audit CLI checks every catalog edge in bounded 12-edge batches at\n   the same pinned block; it never marks a partially verified catalog passed.
   Does not verify a factory signature, token implementation behavior,
   actual reserves or execution mechanics. Any partial coverage is NOT passed.
2. `scripts/audit-multihop-catalog.mjs`: command-line read-only report for
   configured `MULTIHOP_CATALOG_FILE`. It also requires exact match to the
   hardcoded, independently fork-reviewed venue registry before reporting
   an audit **passed**. External source metadata never creates trust.
3. `lib/atomic-preflight.mjs`: read-only exact deployed executor
   `eth_call` plus `estimateGas`, with real on-chain lender liquidity,
   contract allowlists, loan cap, hop cap, candidate block lag, verified
   router registry, known token continuity, gas cap and net-profit floor.
   For paths over 4 swaps, requires approved long-route plan hash.
   Rejects if the head block changes during audit. No signing/broadcast.
4. `scripts/audit-atomic-opportunities.mjs`: operator-independent
   offline batch on an observed candidate JSON. Requires publicly
   readable EXECUTOR_<chainId> and OPERATOR_ADDRESS; no operator private
   key or signer. If not configured or any route fails, prints UNVERIFIED.
5. `lib/soak-acceptance.mjs`, `scripts/soak-scan-only.mjs`:
   conservative, strict scan-only 72h availability measurement,
   per-network error coverage, incident reasons, quote samples,
   no funded transactions, and persistent JSON/JSONL report.
   The monitor only reads localhost GET endpoints, never accesses
   admin API, private keys or executes a transaction.
6. Tests cover chain IDs, invalid contracts, missing token decimals,
   truncated source coverage, quote outages, lender and on-chain
   allowlists, stale/cross-block candidates, revert, gas cap, scan-only
   availability, and script safety/syntax.

## Commands for a later *single* server acceptance
Use an approved reviewed exact commit. With server off to live execution,
the following are read-only. Do not paste private keys.

```bash
# Before any scan-only audit:
grep -x 'LIVE_EXECUTION=false' /etc/nexora/nexora.env
grep -x 'MULTIHOP_EXECUTION_ENABLED=false' /etc/nexora/nexora.env

# After installing the exact reviewed ZIP:
node scripts/audit-multihop-catalog.mjs
# Takes JSON array of on-chain candidate objects from the existing status API.
curl -fsS http://127.0.0.1:3080/api/status | jq '.opportunities' > validation/latest-opportunities.json
node scripts/audit-atomic-opportunities.mjs --candidates validation/latest-opportunities.json

# 72-hour soak acceptance, using localhost-only GET endpoints.
node scripts/soak-scan-only.mjs --hours 72 --interval 30
```

`audit-atomic-opportunities.mjs` requires the operator **public** address
and a deployed executor, and may validly return UNVERIFIED for all candidates.
This is not a defect to bypass; it means the deployed execution proof is absent.

## Important unfinished external validation
- Ten DEX **discovery** protocol labels are not ten fully verified quote
  adapters. Connecting missing real venues requires accurate factory /
  pool interfaces, valid routers and tests on a recent fork per protocol.
  No external `dexId` has been auto-promoted to trusted trading authority.
- No independently confirmed profitable atomic trade from fresh public
  opportunities. A positive shadow quote/eth_call is not a mined transaction
  or net realized P&L.
- 72h host soak cannot be performed without the user's server.
- Independent contract security review cannot be substituted with author
  or GitHub CI tests.
- The executable strategy remains disabled: `LIVE_EXECUTION=false`,
  `MULTIHOP_EXECUTION_ENABLED=false`, `autoExecute:false`,
  `liveChains:[]`; no server change in this branch.

**Release rule:** The only approved deliverable is a scan-only predeployment
artifact tied to a precise SHA with a completely green GitHub Actions CI.
A funded-trading release requires separate explicit owner authorization,
real-network evidence and independent security audit.

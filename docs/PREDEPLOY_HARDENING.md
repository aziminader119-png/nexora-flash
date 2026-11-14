# NEXORA hardening pass — predeployment only

Read-only safety and correctness changes:
1. Public pool comparisons now canonicalize the exact token contract pair and
   normalize published `priceNative` for opposite base/quote token order.
   Underlying tokens are never matched by symbol. This recovers potentially
   missed price dislocations without inventing token equivalence.
2. Pair comparisons are limited to the 20 highest reported 24-hour volume
   pools per token pair, with liquidity as deterministic tie-breaker.
   This prevents quadratic explosion from crowded token indexes and makes
   exclusion observable in `comparisonPoolCapPerPair`.
3. Contradictory quotes for the same chain, pool route, fee tier, block and
   input size are excluded from size recommendations, rather than silently
   accepting one. Distinct size observations can still be compared.
4. Pausing clears the previous top dashboard opportunity list. No stale
   quotes remain visible as if freshly scanned in the legacy dashboard.
5. No changes to contract code, private keys, signer, execution approvals,
   validated router registry, live flags, UI, systemd service or server data.

Still not a full end-to-end proof:
- Actual DEX Screener `dexId` may differ from a configured venue label.
  A nonobserved DEX is `missing`, not described as live.
- Published DEX quote ratios cannot stand in for exact same-block amount
  quotes, gas, swap fees, lender fee, liquidity, and atomic swap simulation.
- The 2-hop scan is separate from the explicit Base route catalog. There
  is no automatic authorized promotion for external pool addresses.
- Exhaustive optimal loan sizing over a continuous amount domain is not
  claimed; only the observed capped sample amounts are compared.
- Fork-simulated profitability has not been verified for live discovered
  opportunities. Funded execution must remain disabled.

Deployment acceptance requires exact current commit's node-unit, Solidity,
five forks, local and Base fork E2E, installer smoke, lockfile and gate-report
CI checks to pass. One-time server installation should use a backup and
automatic rollback, then verify 5 network health, price source coverage,
on-chain quote status, and `SCAN_ONLY` flags.

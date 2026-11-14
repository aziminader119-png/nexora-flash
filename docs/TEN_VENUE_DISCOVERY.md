# Ten-venue public market discovery — read-only

This change expands NEXORA's **market metadata discovery**, not its
execution venues, pool approvals, or executable arbitrage reach.

Curated protocols (as of 2026-11-14, relevant activity across Base /
Arbitrum): Aerodrome, Uniswap, PancakeSwap, Metric, Fluid, WOOFi,
Camelot, Curve, Sushi and DODO. Selection is informed by chain
DEX-volume rankings (DefiLlama); it is *not* a promise that each one
has swap pools exposed under the current DEX Screener `dexId`, or is
supported by NEXORA's transaction executor.

**Network targeting:** Base: Aerodrome, Uniswap, PancakeSwap, Metric,
Fluid, WOOFi, Curve, Sushi (8). Arbitrum: Uniswap, PancakeSwap, Metric,
Fluid, WOOFi, Camelot, Curve, Sushi, DODO (9). Union: 10.

The API returns `venueCoverage.targets`, `observed` and `missing`
rather than presenting a configured name as a connected DEX. A target
has **observed coverage** only if a qualifying pool from that network
was actually returned in the current API response with a matching
published `dexId`. Unsupported/unmatched IDs are visible under
`ignoredDexIds` to facilitate verification; NEVER auto-trust
unknown IDs.

Seed pairs per chain expanded:
- Base: USDC, WETH, cbBTC, AERO.
- Arbitrum: USDC, WETH, USDT, ARB, WBTC.

Every seed address is explicit. Discovery reads up to 250 records per
token seed (1500 total maximum per chain), maintains a 60-second cache
and coalesces concurrent requests per network. Requests still use
`api.dexscreener.com/token-pairs/v1/{chain}/{token}` and no unapproved
URL from market metadata is fetched.

The API `GET /api/discovery/spreads?chain=base` shows **indicative**
spreads with `executable:false` and `actionable:false`. Published
spot price discrepancies are not amount-specific pool quotes, profit,
liquidity proof or flash-loan execution validation. The existing
`/api/routes/ranked` is not changed.

No additional DEX is given a trusted router/quoter, swap adapter,
contract signature, token approval, signing privileges, or transaction
authority. No public exchange price feeds are inserted into the
executor's opportunity list. Pool integration remains a separate
per-venue on-chain audit and fork testing process.

Before server deployment, validate exact-source SHA GitHub CI
(node-unit, installer smoke, Solidity, 5 network forks, local/fork
E2E and gate-report). The service must remain
`LIVE_EXECUTION=false`, `MULTIHOP_EXECUTION_ENABLED=false`.

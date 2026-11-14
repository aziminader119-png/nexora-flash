# Short-cycle discovery v1 — 3–4 hop, scan only

NEXORA currently ranks direct 2-hop opportunities and 5–10-hop catalog cycles.
This feature adds **three- and four-hop closed simple cycles** from the existing
operator-approved catalog, without granting trade permissions.

- Existing 2-hop scanner: unchanged, all enabled chains.
- New 3-hop scanner: 24 quote calls maximum per Base scan, independent of 4-hop.
- New 4-hop scanner: 24 quote calls maximum per Base scan, independent of 3-hop.
- Existing 5–10-hop scanner: up to 80 quotes, unchanged execution permissions and gate.
- All prices are on-chain quoter responses pinned to the same network block per scan.
- New 3/4-hop candidates are created with `allowExecution:false` **even if the long-route
  execution feature flags were separately enabled**.
- Per-size fairness continues; default four loan sizes share each depth's budget.
- `/api/status` network state includes `threeHopCycles`, `fourHopCycles`,
  `shortCycleQuotes`, `shortCycleCount`, `longCycleQuotes`, and
  `longCycleCount`.
- `/api/multihop/cycles?chainId=8453&minHops=3&maxHops=4`
  shows all scanned short cycles independent of the top-100 dashboard projection.
- `/api/routes/ranked` sorts currently surfaced candidates by net estimate,
  not route length. Quote rankings do not prove profit nor authorize funded execution.

**Scope limitation:** 3–4-hop discovery uses the existing Base route catalog;
it does not invent pools, token addresses, or venue adapters, and is **not**
automatic discovery of every pool on every chain. More topology coverage may
require a larger on-chain-verified catalog, with per-pool identity and liquidity checks.

**Safety:** the service must remain in `SCAN_ONLY`; retain
`LIVE_EXECUTION=false` and `MULTIHOP_EXECUTION_ENABLED=false`.
Do not deploy until the exact source commit passes tests and review. No UI changes.

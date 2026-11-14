# NEXORA Flash Arbitrage — v1.1 multi-hop review

Atomic flash-loan arbitrage for low-cost EVM networks: scan on-chain DEX quotes, choose the cheapest flash-liquidity
provider, compute executable net profit (lender fee + gas + L1 data fee), re-simulate the exact transaction, and execute
unattended behind a validation gate. A single-page dashboard has Opportunities, Trades, Logs and Settings.

> **Status: review candidate, NOT authorized for funded multi-hop trading.** Foundry compilation and local Solidity/Node
> test jobs have passed in GitHub Actions for the 5–10 hop implementation. This is NOT proof of 5–10 hop execution
> against real DEX liquidity on every target chain. The separate `test_multihop_roundTrip` network fork gate is not
> present in the fork suite as of this review; therefore the long-route execution gate remains locked. A passing
> `npm run validate:full`, validated on-chain bytecode, explicit cold-owner approvals, and independent security review
> are required before any live deployment. The project defaults to `LIVE_EXECUTION=false` and
> `MULTIHOP_EXECUTION_ENABLED=false`.

## What it does

| Stage | Implementation |
|---|---|
| Flash liquidity | Aave V3 `flashLoanSimple`, Balancer V2 Vault `flashLoan`, Morpho Blue `flashLoan`, Euler V2 EVault `flashLoan` (`contracts/NexoraFlashExecutor.sol`) |
| Swap venues | Uniswap-V2-compatible routers (Uniswap V2, PancakeSwap V2, SushiSwap, QuickSwap), V3 SwapRouter with deadline (Uniswap V3 SwapRouter, PancakeSwap V3), V3 SwapRouter02 (Uniswap on Base) |
| Atomicity | borrow → 2–4 standard legs (5–10 only after separate owner, fork, and operator approvals) → repay principal + fee → surplus to profit receiver; any shortfall reverts the whole transaction |
| On-chain guards | owner/operator split, provider/router/token allow-lists, per-asset loan cap, lender-fee ceiling, deadline, per-leg balance-delta slippage floors, mandatory `minProfit > 0`, callback authentication (only the lender that `start()` called, only during execution, plan hash must match), reentrancy lock, pause |
| Scanner | `lib/scanner.mjs`: V2 `getAmountsOut` and V3 `QuoterV2` pinned to one block; every venue × fee tier, both directions, several loan sizes; native gas price taken from the highest on-chain quote; OP-stack L1 data fee |
| Provider selection | `lib/profit.mjs`: the cheapest healthy lender with enough liquidity (Aave reserve flags + virtual balance, Balancer pause state + fee collector, Morpho/Euler balances); ties go to the lower-gas lender |
| Execution | `lib/engine.mjs`: freshness → bytecode/fork gate → on-chain role and allow-list check → `eth_call` → quote/simulation consistency → `estimateGas` + L1 fee → per-tx, daily and gas-unit caps → profit floor re-derived from real gas → second `eth_call` → sign → journal → broadcast → receipt → realized profit from the `Executed` event |
| Recovery | journal-driven nonce handling; no new broadcast while a transaction is pending (including after restarts); rebroadcast if dropped; same-nonce cancel when stuck; circuit breaker auto-pauses after N failures |
| Emergency stop | dashboard button: local pause, plus `pause()` on every executor (replaces a stuck trade at the same nonce). Only the owner can unpause. |


## Multi-hop routes (5–10 swaps)

- `lib/multihop.mjs` enumerates bounded, block-pinned quotes for closed, non-repeating cycles using an explicit chain-scoped catalog of directed token/pool edges supplied in `MULTIHOP_CATALOG_FILE`. It does not invent pools or prices; an empty catalog discovers zero multi-hop routes.
- The executor contract permits at most 10 legs but keeps `maxRouteLegs=4` by default. A cold owner must explicitly raise the cap and approve the exact route hash; allow-lists, slippage floors, flash-fee ceiling, minimum profit, full atomic rollback, and callback authentication also apply.
- The server requires a separate long-route opt-in, chain selector, trusted venue registry, and the named network-specific mainnet-fork test `test_multihop_roundTrip` in its validation gate. **Do not add a stub, fake, or mocked mainnet-fork pass to bypass this gate.** The current fork tests cover their existing round-trips, not complete 5–10 hop real-liquidity execution.
- Tests for route lengths 5, 6, 7, 8, 9, 10 exist for the mock-contract and on-chain-quote scanner. Real-market profitability, current liquidity, priority inclusion, gas costs, and the deployment security posture remain unproven.
- Safe audit commands: `npm test`, `forge build --sizes`, `forge test --no-match-path 'test/fork/*' -vvv`, `npm run validate:full`. A read-only route introspection utility is `node scripts/check-long-route.mjs <chainId> <executorAddress> <candidate.json>`.
- Never set `LIVE_EXECUTION=true` or `MULTIHOP_EXECUTION_ENABLED=true` based on mock tests alone. Keep owner credentials and operator signing keys out of GitHub and review artifacts.

## Quick start (development)

```bash
npm install                     # ethers
npm test                        # Node tests (no network needed)
forge build --sizes             # requires Foundry
forge test --no-match-path 'test/fork/*' -vvv
node scripts/e2e-anvil.mjs local
BASE_RPC_URL=... BSC_RPC_URL=... ARBITRUM_RPC_URL=... OPTIMISM_RPC_URL=... POLYGON_RPC_URL=... \
  npm run validate:full         # writes validation/gate-report.json; exit 1 on any critical failure
node --env-file=.env server.js  # dashboard at http://127.0.0.1:3080 (scan-only unless LIVE_EXECUTION=true)
```

## Production

See `docs/OPERATIONS.md` for the go-live procedure: install, validate, deploy, operator key, preflight, enable.
`docs/SECURITY.md` covers the threat model and controls. `docs/NETWORKS.md` lists the networks, providers and venues.

## Layout

```
contracts/NexoraFlashExecutor.sol   executor (all providers/venues)
contracts/mocks/Mocks.sol           test-only lenders, routers, quoter, attackers
test/NexoraFlashExecutor.t.sol      local-EVM unit/security/fuzz tests (Foundry, no forge-std needed)
test/fork/                          mainnet-fork tests: Base, BNB, Arbitrum, Optimism, Polygon
lib/                                scanner, profit math, planner, engine, journal, gates, ethers adapter, keys, logger
scripts/                            run-validation, e2e-anvil, deploy, preflight, create-operator-key
tests/                              Node test-suite (fake chain mirrors executor rules)
public/index.html                   single-page dashboard
install-ubuntu.sh                   Ubuntu 24.04 installer (hardened systemd unit)
.github/workflows/ci.yml            CI: every job blocking; publishes the gate report
```

No profit is guaranteed. Real opportunities are competitive and many disappear within a block. The on-chain profit
floor makes a lost race cost only gas.

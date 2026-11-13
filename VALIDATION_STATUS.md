# NEXORA v1.0 — Validation status and remaining blockers (2026-11-13)

## Changes from v0.9
- **Contract rewritten** (`NexoraFlashExecutor` 1.0.0): Aave V3, Balancer V2, Morpho Blue and Euler V2 flash
  providers; V2, V3 (deadline) and V3 Router02 venues; 2–4 leg routes; owner/operator role split; balance-delta
  accounting; lender-fee ceiling; authenticated callbacks bound to a plan hash; deployed paused.
- **Off-chain stack restructured** into `lib/`, behind a chain adapter. Added a block-pinned multi-venue/fee-tier
  scanner, cheapest-lender selection (restricted to gate-eligible lenders), exact integer profit math, OP-stack L1 fee,
  two-pass simulation with an on-chain profit floor, per-tx/daily/gas-unit caps, an fsync'd journal with restart
  recovery, rebroadcast, same-nonce cancel, a circuit breaker and an emergency stop that pauses on-chain.
- **Validation gate**: live execution requires a fresh gate report whose codehash matches the deployed executor,
  plus passing fork tests for the network and the lender used.
- **Networks**: BNB, Base, Arbitrum, Optimism and Polygon (execution). The 16 monitor-only networks and the
  `@bgd-labs/aave-address-book` dependency were removed. Their status was informational only and they had no
  execution path.
- **Dashboard**: the single page is kept, with Opportunities / Trades / Logs / Settings tabs, a gate banner,
  emergency stop / resume and manual execute. The maximum loan is configurable, starts at $1,000 and is bounded by a
  server ceiling.
- **Tests/CI**: 60 Node tests; 31 Foundry unit/security/fuzz tests; 20 fork tests; anvil E2E (local + Base fork);
  blocking CI that publishes the gate report.

## Changes in v1.0.1 (this round, no EVM available)
- Balancer V2 disabled by default (`ENABLE_BALANCER_V2`), after the 3 Nov 2025 V2 Vault exploit on Base, Arbitrum, Optimism and Polygon.
- Private transaction submission: `PRIVATE_TX_RPC_<chainId>` (https only) receives signed transactions; reads stay on the normal RPC.
- Fork tests pin `FORK_BLOCK` (latest − 5, looked up by `run-validation.mjs`) and the block is recorded per test in the gate report.
- `scripts/observe-market.mjs`: passive observation (no transactions, no price movement). Records quoted / simulated results per network and writes zero counts when nothing is found.
- Addresses checked against official docs by web lookup: Uniswap V2 router/factory (Base, Optimism), Uniswap V2 factory (Arbitrum), Morpho Blue (Base).
- In this session a compiler run was attempted again and denied again by the safety policy. The npm registry and all 5 RPCs were unreachable.

## Remaining blockers (must be cleared before funding)
1. **Never compiled or executed on an EVM.** forge build, Foundry tests, anvil E2E and fork tests did not run in the
   build environment (no compiler/Foundry execution permitted, no RPC access). First action: run CI or
   `npm run validate:full`.
2. **ethers adapter, server runtime, deploy/preflight/key scripts are untested at runtime** (ethers could not be
   installed). They are covered by the E2E/CI steps above.
3. **No package-lock.json.** Generate it with the first `npm install` and commit it. The installer then uses `npm ci`.
4. **Addresses not verified on-chain from here.** They come from public deployment docs and are checksum-valid. Fork
   `setUp` and preflight fail loudly on any missing contract.
5. **Euler V2** has no verified vault and no fork test, so it is never live-eligible. **Morpho** is configured on Base
   only. **Balancer V2** availability after its November 2025 exploit must be confirmed by the fork tests.
6. **Profitability is unproven.** No real opportunity has been observed or executed. BNB uses a public mempool, and
   private transaction submission is not implemented: losing a race costs gas, not principal.
7. **No third-party audit.**

The code fails closed. While any of items 1–4 is open, the validation gate keeps funded execution locked.

# NEXORA v1.1 Long-Cycle Review Handoff (Claude Code)

**Scope:** Independent review of source branch `feature/multihop-execution-5-10` against `main` for safe, atomic 5–10 conversion Flash Loan arbitrage. Do NOT assume CI implies production safety.

## Security-sensitive implementation

- `contracts/NexoraFlashExecutor.sol`: increases MAX_LEGS from 4 to 10, but owner-controlled `maxRouteLegs` defaults to 4; owner-only route hash approval required for n>4; duplicate intermediate token/pool restrictions; original callback authentication and atomic repayment preserved.
- `lib/planner.mjs`: 5–10 leg plan serialization and cumulative per-leg slippage floors.
- `lib/chain-ethers.mjs`: contract maxRouteLegs and longRouteHash/approvedLongRoute read-only RPC checks.
- `lib/engine.mjs`: extra longRouteEnabled flag, per-network dedicated fork test gate, owner max leg and route hash validation before signing, existing simulation/nonce/recovery/gas caps.
- `server.js`: independent environment opt-in and explicitly listed chains, canonical router and fee-tier matching, trusted validation report.
- `lib/multihop.mjs`: 80 quote default, eight-second scan budget, exact same-block quotes, loop/pool checks, lender and gas estimates, standalone no-execution fallback.
- `.env.example`: both multi-hop funded execution gates are OFF.

## Review tasks (must challenge assumptions)

1. Verify ABI hash and route-hash determinism, calldata vs memory handling, collision resistance, chain binding, edge fees, approval revocation, and nested callback safety.
2. Run adversarial Foundry tests for 5 and 10 distinct-token swaps, unauthorized operator, unapproved route, revoked route, repeated token/pool, balance-delta accounting, fee-on-transfer tokens, revert after leg 9, approval cleanup and fee drift.
3. Audit gas / calldata / L2 data fees for a worst-case ten-leg path. In particular determine whether total quote age 6000 ms and scanner budget 8000 ms make some paths stale. Ensure re-simulation fails closed.
4. Inspect real-token discovery and route catalog trust boundaries: operator-controlled JSON must never grant permissions by claiming `forkValidated=true`. Verify canonical venue/fee mapping; review token metadata and potential symbol spoofing.
5. Check route `minOut` math for all 10 legs and consider rounding errors, negative gross, partial output changes and cumulative tolerance, plus quote-to-simulation consistency.
6. Verify cold-owner approvals and off-chain signer operator isolation. Check pausing during and between simulations, before signing, and before broadcast. Check nonce recovery and RPC ambiguity.
7. The fork harness uses real Aave V3 pools but mock intermediate DEXes. Treat this as *partial* fork validation, NOT a proof of execution through a genuine five/ten-pool cycle. Design and execute route-specific tests using real forked DEX pools and production tokens before any mainnet funds.
8. Verify that an upgrade requires a new deployed executor, gate-report codehash match, owner allowlists and correct per-network deployment. Never rely on old v1.0 executor state.
9. Check `LIVE_EXECUTION=false`, `MULTIHOP_EXECUTION_ENABLED=false`, empty chain consent, and absence of any funded mainnet transaction, wallet keys or secrets.
10. Review `npm test`, `forge test`, all five forks, local/Base E2E, Ubuntu smoke, lockfile, and full validation gate. Fix reproducible failures without relaxing tests.

## Approval decision

Report exactly PASS / FAIL for **SCAN-ONLY deployment** separately from **FUNDED 5–10 LEG execution**. List critical/high/medium/low issues, file+line, tests and commit hashes. Never call developer/unit/fork tests an independent professional security audit. Do not enable funded mode or deploy to any real network.

**Expected stance until route-specific real-DEX validation and third-party audit:** SCAN_ONLY can proceed when CI is green; FUNDED LONG ROUTES are NOT authorized.

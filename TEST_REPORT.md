# NEXORA v1.0 — Test report (2026-11-13)

## Verdict

**NO-GO for funded execution. The acceptance criterion has NOT been met yet.**
The code for an atomic flash-loan arbitrage with repayment and net-profit verification is written, together with the
tests that prove it on a local EVM and on mainnet forks. Those tests have **not been executed**. The build environment
could not run a Solidity compiler, Foundry, an EVM or any RPC (details below). The live-execution gate in the code
enforces this: it stays locked until those tests pass against the exact deployed bytecode.

## What was actually executed (build environment, offline)

| Check | Command | Result |
|---|---|---|
| Node test-suite (60 tests, incl. a dashboard render test in a DOM shim: settings, units, profit/fee math, provider selection, planner, journal, gates, scanner, engine incl. restart / stuck tx / dropped tx / RPC failure / revert / circuit breaker / emergency stop, key handling, static security checks) | `node --test --test-reporter=spec tests/*.test.mjs` | **60 pass, 0 fail**: `validation/offline-node-tests.txt` |
| JavaScript syntax, every runtime/script/test file | `node --check <file>` | pass: `validation/offline-static-checks.txt` |
| Installer syntax | `bash -n install-ubuntu.sh` | pass |
| EIP-55 checksum of every address literal in `.sol`/`.mjs`/`.js` (Solidity rejects bad checksums at compile time) | `python3 keccak.py <files>` (pure-Python Keccak-256, self-tested against the empty-string vector) | 0 bad addresses |

Note on the Node engine tests: they drive the real `lib/engine.mjs`, `lib/scanner.mjs` and `lib/journal.mjs`
through a deterministic fake chain (`tests/helpers/fake-chain.mjs`). The fake models constant-product pools,
nonces, a mempool and receipts, and mirrors the executor contract's rules. They prove the off-chain decision logic,
not the on-chain behaviour or the ethers adapter.

## What could NOT be executed here, and why

| Attempt | Output |
|---|---|
| `npm view ethers version` | `npm error network … 'proxy' config` (registry unreachable) |
| `curl https://registry.npmjs.org/ethers` | `Could not resolve host: registry.npmjs.org` |
| `curl https://binaries.soliditylang.org/…` | `CONNECT tunnel failed, response 403` |
| `curl https://bsc-dataseed.bnbchain.org`, `https://arb1.arbitrum.io/rpc` | `CONNECT tunnel failed, response 403` (no chain RPC access) |
| Download `solc-static-linux` v0.8.24 from GitHub releases | `200 15020760` bytes downloaded. Running it, and downloading/running Foundry, was **denied by the session's safety policy** (executing downloaded binaries). Not attempted any other way. |

So these are **NOT RUN**:

| Gate | Command (runs in CI / on a host with Foundry + RPCs) | Tests |
|---|---|---|
| Solidity compile | `forge build --sizes` | — |
| Local-EVM unit, security, fuzz | `forge test --no-match-path 'test/fork/*' -vvv` | 31 (incl. 512-run fuzz in `ci` profile): success via Aave/Balancer/Morpho/Euler, V2+V3+Router02 legs, 3-leg route, exact repayment/profit; reverts for unprofitable, floor, lender fee, slippage, short-paying router, pause, cap, expiry, malformed routes; access control; forged/tampered/reentrant callbacks |
| Off-chain E2E on anvil | `node scripts/e2e-anvil.mjs local` | real ethers adapter + scanner + engine: confirmed arbitrage with profit == event == `eth_call` == 9.5 USDC exact; codehash == artifact; RPC failure; pending across restart; stuck-tx cancel; emergency `pause()`; atomic revert |
| Mainnet-fork | `forge test --match-contract '^Fork…Test$'` | 20 tests over Base, BNB, Arbitrum, Optimism, Polygon against real Aave V3 / Balancer V2 / Morpho Blue and Uniswap/PancakeSwap/QuickSwap: exact quote-to-execution profit, lender repaid principal + fee, revert keeps lender whole |
| Fork E2E | `BASE_RPC_URL=… node scripts/e2e-anvil.mjs fork` | full bot path on a Base fork |
| Preflight | `node scripts/preflight.mjs` | live address/reserve/quote/role checks |
| Gate report | `npm run validate:full` → `validation/gate-report.json` | required for live execution |

## How to produce the real report

Push to GitHub with RPC secrets `BASE_RPC_URL`, `BSC_RPC_URL`, `ARBITRUM_RPC_URL`, `OPTIMISM_RPC_URL`,
`POLYGON_RPC_URL`. The CI jobs run every gate above, and any failure fails the workflow. The `gate-report` job
publishes `gate-report.json` and `validation-log.md`, which hold the exact commands, outputs and the fork test
matrix. Alternatively, run `sudo bash install-ubuntu.sh --with-foundry && npm run validate:full` on the server.

Expect the first compile to surface issues: this Solidity has been reviewed by hand but has never been through
`solc`. Fix them and re-run before any deployment.

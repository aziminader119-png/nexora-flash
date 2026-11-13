# Networks, flash-liquidity providers and venues (v1.0)

"Configured" means wired into `lib/networks.mjs`, the deploy script and the fork tests. **None of these is
operationally verified yet.** On-chain verification happens in three places: the fork test `setUp` (code at every
address), `scripts/preflight.mjs` (code, reserve state, liquidity, live quotes) and the runtime gate. The address
values below come from the protocols' public deployment documentation.

| Network | Stable / wrapped | Flash providers | Fork-validated venues (executable) | Quote-only venues | Fork suite |
|---|---|---|---|---|---|
| BNB Chain (56) | USDT `0x55d3…7955` (18 dec) / WBNB `0xbb4C…095c` | Aave V3 Pool `0x6807…e0cB` | PancakeSwap V2 router `0x10ED…024E`; PancakeSwap V3 SwapRouter `0x1b81…eB14` (QuoterV2 `0xB048…5997`) | Uniswap V2 `0x4752…aD24` | `ForkBNBTest` |
| Base (8453) | USDC `0x8335…2913` / WETH `0x4200…0006` | Aave V3 `0xA238…d1c5`, Morpho Blue `0xBBBB…FFCb`, Balancer V2 Vault `0xBA12…F2C8` | Uniswap V2 `0x4752…aD24`; Uniswap V3 SwapRouter02 `0x2626…e481` (QuoterV2 `0x3d4e…B76a`) | — | `ForkBaseTest` (Aave, Morpho, Balancer) |
| Arbitrum (42161) | USDC `0xaf88…5831` / WETH `0x82aF…Bab1` | Aave V3 `0x794a…14aD`, Balancer V2 Vault | Uniswap V2 `0x4752…aD24`; Uniswap V3 SwapRouter `0xE592…1564` (QuoterV2 `0x61fF…B21e`) | SushiSwap V2 `0x1b02…7506` | `ForkArbitrumTest` (Aave, Balancer) |
| Optimism (10) | USDC `0x0b2C…Ff85` / WETH `0x4200…0006` | Aave V3 `0x794a…14aD`, Balancer V2 Vault | Uniswap V2 `0x4A7b…62c2`; Uniswap V3 SwapRouter | — | `ForkOptimismTest` (Aave, Balancer) |
| Polygon (137) | USDC `0x3c49…3359` / WPOL `0x0d50…1270` | Aave V3 `0x794a…14aD`, Balancer V2 Vault | QuickSwap V2 `0xa5E0…78ff`; Uniswap V3 SwapRouter | SushiSwap V2 `0x1b02…7506` | `ForkPolygonTest` (Aave, Balancer) |

Full addresses are in `lib/networks.mjs` and `test/fork/ForkNetworks.t.sol`. All are EIP-55 checksum-verified.

## Readiness matrix (2026-11-13)

Legend: **C** = configured in code; **Doc** = address confirmed against official docs by web lookup; **Fork** = fork test result; **Live** = live-eligible. No fork test has run yet, so nothing is live-eligible.

| Network | Aave V3 | Morpho Blue | Balancer V2 | Euler V2 | Execution venues |
|---|---|---|---|---|---|
| BNB Chain | C · Fork: not run · Live: no | not deployed/configured | not on BNB | not configured | PancakeSwap V2 + V3: C · Fork: not run |
| Base | C · Fork: not run · Live: no | C · Doc ✓ (universal address) · Fork: not run · Live: no | C, **disabled by default** · Fork: not run | not configured | Uniswap V2 (Doc ✓) + V3 Router02: C · Fork: not run |
| Arbitrum | C · Fork: not run · Live: no | Doc: chain-specific address exists; not configured (negligible TVL) | C, disabled · Fork: not run | not configured | Uniswap V2 (factory Doc ✓) + V3: C · Fork: not run |
| Optimism | C · Fork: not run · Live: no | not configured (negligible TVL) | C, disabled · Fork: not run | not configured | Uniswap V2 (Doc ✓) + V3: C · Fork: not run |
| Polygon | C · Fork: not run · Live: no | not configured | C, disabled · Fork: not run | not configured | QuickSwap V2 + Uniswap V3: C · Fork: not run |

Balancer V2: the Vault was exploited on 3 Nov 2025 through Composable Stable Pool rounding combined with batchSwap.
Base, Arbitrum, Optimism and Polygon were all affected. Flash loans themselves were not the bug, but vault balances
and protocol state changed. Balancer stays excluded unless `ENABLE_BALANCER_V2=true` **and** its fork test passes.

## Provider status

| Provider | Contract adapter | Mock tests | Fork test | Live-eligible after gate |
|---|---|---|---|---|
| Aave V3 | yes | yes | all 5 networks | yes, per network |
| Balancer V2 | yes | yes (0 fee and with fee) | Base, Arbitrum, Optimism, Polygon | only where its fork test passes |
| Morpho Blue | yes | yes | Base | Base only |
| Euler V2 (EVK) | yes | yes | **none**: no vault address verified | **no**. `EULER_VAULT_<id>` can be set for quoting, but without a `test_euler_roundTrip` pass the gate never allows it |
| Uniswap V3 / PancakeSwap V3 `flash()` | not implemented | — | — | no |

The scanner restricts lender selection to providers whose fork round-trip passed for that network (from the gate
report), and among those picks the cheapest one with enough liquidity. If no configured lender is gate-eligible,
it shows the cheapest one for information, and the engine refuses to execute.

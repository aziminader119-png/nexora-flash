// Execution network registry. Every address is checked on-chain at runtime (code present + chainId match) and
// the executor additionally requires a passing mainnet-fork test for the network/provider before live use.
//
// forkValidated: the venue is the one exercised by test/fork/ForkNetworks.t.sol for that network. Venues that are
// quoted but not fork-validated are shown on the dashboard and are NEVER executed.

export const PROVIDER_KIND = Object.freeze({AAVE_V3: 1, BALANCER_V2: 2, MORPHO_BLUE: 3, EULER_V2: 4});
export const ROUTER_KIND = Object.freeze({V2: 0, V3_DEADLINE: 1, V3_ROUTER02: 2});
export const PROVIDER_FORK_TEST = Object.freeze({
  AAVE_V3: 'test_aave_roundTrip',
  BALANCER_V2: 'test_balancer_roundTrip',
  MORPHO_BLUE: 'test_morpho_roundTrip',
  EULER_V2: 'test_euler_roundTrip',
});
// Typical execution gas per component (conservative; the executor always uses eth_estimateGas before broadcast).
export const GAS_MODEL = Object.freeze({base: 60000n, AAVE_V3: 110000n, BALANCER_V2: 90000n, MORPHO_BLUE: 70000n, EULER_V2: 90000n, v2Leg: 110000n, v3Leg: 150000n});

const AAVE_L2 = '0x794a61358D6845594F94dc1DB02A252b5b4814aD';
const BALANCER_VAULT = '0xBA12222222228d8Ba445958a75a0704d566BF2C8';
const UNI_V3_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';
const UNI_QUOTER_V2 = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';
const UNI_FEES = [100, 500, 3000, 10000];

export const NETWORKS = Object.freeze([
  {
    id: 56, name: 'BNB Chain', native: 'BNB', rpcDefault: 'https://bsc-rpc.publicnode.com', txType: 0, l1Fee: null,
    maxQuoteAgeMs: 6000, forkSuite: 'ForkBNBTest',
    stable: {address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', decimals: 18},
    wrapped: {address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', symbol: 'WBNB', decimals: 18},
    providers: [{kind: 'AAVE_V3', address: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB'}],
    venues: [
      {id: 'pcs-v2', name: 'PancakeSwap V2', type: 'v2', router: '0x10ED43C718714eb63d5aA57B78B54704E256024E', forkValidated: true},
      {id: 'uni-v2', name: 'Uniswap V2', type: 'v2', router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24', forkValidated: false},
      {id: 'pcs-v3', name: 'PancakeSwap V3', type: 'v3', router: '0x1b81D678ffb9C0263b24A97847620C99d213eB14', routerKind: 1, quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997', fees: [100, 500, 2500, 10000], forkValidated: true},
    ],
  },
  {
    id: 8453, name: 'Base', native: 'ETH', rpcDefault: 'https://base-rpc.publicnode.com', txType: 2, l1Fee: 'op-stack',
    maxQuoteAgeMs: 6000, forkSuite: 'ForkBaseTest',
    stable: {address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6},
    wrapped: {address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18},
    providers: [
      {kind: 'AAVE_V3', address: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5'},
      {kind: 'MORPHO_BLUE', address: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb'},
      {kind: 'BALANCER_V2', address: BALANCER_VAULT, optIn: 'ENABLE_BALANCER_V2'},
    ],
    venues: [
      {id: 'uni-v2', name: 'Uniswap V2', type: 'v2', router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24', forkValidated: true},
      {id: 'uni-v3', name: 'Uniswap V3', type: 'v3', router: '0x2626664c2603336E57B271c5C0b26F421741e481', routerKind: 2, quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a', fees: UNI_FEES, forkValidated: true},
    ],
  },
  {
    id: 42161, name: 'Arbitrum', native: 'ETH', rpcDefault: 'https://arbitrum-one-rpc.publicnode.com', txType: 2, l1Fee: null, // L1 cost is included in Arbitrum gas estimates
    maxQuoteAgeMs: 4000, forkSuite: 'ForkArbitrumTest',
    stable: {address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6},
    wrapped: {address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', symbol: 'WETH', decimals: 18},
    providers: [
      {kind: 'AAVE_V3', address: AAVE_L2},
      {kind: 'BALANCER_V2', address: BALANCER_VAULT, optIn: 'ENABLE_BALANCER_V2'},
    ],
    venues: [
      {id: 'uni-v2', name: 'Uniswap V2', type: 'v2', router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24', forkValidated: true},
      {id: 'sushi-v2', name: 'SushiSwap V2', type: 'v2', router: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506', forkValidated: false},
      {id: 'uni-v3', name: 'Uniswap V3', type: 'v3', router: UNI_V3_ROUTER, routerKind: 1, quoter: UNI_QUOTER_V2, fees: UNI_FEES, forkValidated: true},
    ],
  },
  {
    id: 10, name: 'Optimism', native: 'ETH', rpcDefault: 'https://optimism-rpc.publicnode.com', txType: 2, l1Fee: 'op-stack',
    maxQuoteAgeMs: 6000, forkSuite: 'ForkOptimismTest',
    stable: {address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', symbol: 'USDC', decimals: 6},
    wrapped: {address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18},
    providers: [
      {kind: 'AAVE_V3', address: AAVE_L2},
      {kind: 'BALANCER_V2', address: BALANCER_VAULT, optIn: 'ENABLE_BALANCER_V2'},
    ],
    venues: [
      {id: 'uni-v2', name: 'Uniswap V2', type: 'v2', router: '0x4A7b5Da61326A6379179b40d00F57E5bbDC962c2', forkValidated: false},
      {id: 'uni-v3', name: 'Uniswap V3', type: 'v3', router: UNI_V3_ROUTER, routerKind: 1, quoter: UNI_QUOTER_V2, fees: UNI_FEES, forkValidated: true},
    ],
  },
  {
    id: 137, name: 'Polygon', native: 'POL', rpcDefault: 'https://polygon-bor-rpc.publicnode.com', txType: 2, l1Fee: null,
    maxQuoteAgeMs: 6000, forkSuite: 'ForkPolygonTest',
    stable: {address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', symbol: 'USDC', decimals: 6},
    wrapped: {address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', symbol: 'WPOL', decimals: 18},
    providers: [
      {kind: 'AAVE_V3', address: AAVE_L2},
      {kind: 'BALANCER_V2', address: BALANCER_VAULT, optIn: 'ENABLE_BALANCER_V2'},
    ],
    venues: [
      {id: 'quick-v2', name: 'QuickSwap V2', type: 'v2', router: '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff', forkValidated: true},
      {id: 'sushi-v2', name: 'SushiSwap V2', type: 'v2', router: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506', forkValidated: false},
      {id: 'uni-v3', name: 'Uniswap V3', type: 'v3', router: UNI_V3_ROUTER, routerKind: 1, quoter: UNI_QUOTER_V2, fees: UNI_FEES, forkValidated: true},
    ],
  },
]);

export const NETWORK_IDS = Object.freeze(NETWORKS.map((n) => n.id));
export const networkById = (id) => NETWORKS.find((n) => n.id === id) || null;

/** Optional operator-supplied Euler V2 vaults: EULER_VAULT_<chainId>=0x... (stable-asset EVK vault). */
// Balancer V2 is disabled unless ENABLE_BALANCER_V2=true: its V2 Vault was hit by the 3 Nov 2025 exploit on Base,
// Arbitrum, Optimism and Polygon (Composable Stable Pools); vault liquidity and flash-loan availability must be
// re-established by a passing fork test before an operator opts in.
export function withEnvProviders(net, env = process.env) {
  net = {...net, providers: net.providers.filter((p) => !p.optIn || env[p.optIn] === 'true')};
  const extra = [];
  const euler = env[`EULER_VAULT_${net.id}`];
  if (euler && /^0x[0-9a-fA-F]{40}$/.test(euler)) extra.push({kind: 'EULER_V2', address: euler});
  return extra.length ? {...net, providers: [...net.providers, ...extra]} : net;
}

/** Expand venues into concrete quotable pools (one entry per V3 fee tier). */
export function pools(net) {
  const out = [];
  for (const v of net.venues) {
    if (v.type === 'v2') out.push({key: v.id, venueId: v.id, name: v.name, type: 'v2', router: v.router, routerKind: 0, fee: 0, forkValidated: v.forkValidated});
    else for (const fee of v.fees) out.push({key: `${v.id}:${fee}`, venueId: v.id, name: `${v.name} ${fee / 10000}%`, type: 'v3', router: v.router, routerKind: v.routerKind, quoter: v.quoter, fee, forkValidated: v.forkValidated});
  }
  return out;
}

/**
 * Where signed transactions are sent. PRIVATE_TX_RPC_<chainId> (e.g. a builder/MEV-protected endpoint on BNB Chain)
 * receives the raw transaction instead of the public RPC; reads always use the normal RPC. On Base, Optimism and
 * Arbitrum the sequencer has no public mempool, so the default endpoint is already private to the sequencer.
 */
export function broadcastUrl(net, env = process.env) {
  const u = env[`PRIVATE_TX_RPC_${net.id}`];
  return u && /^https:\/\//.test(u) ? u : null;
}

// Production chain adapter (ethers v6). Implements the interface consumed by scanner.mjs and engine.mjs.
import {JsonRpcProvider, Contract, Interface, keccak256, getAddress} from 'ethers';
import {broadcastUrl} from './networks.mjs';

export const EXECUTOR_ABI = [
  'function owner() view returns (address)',
  'function operator() view returns (address)',
  'function profitReceiver() view returns (address)',
  'function paused() view returns (bool)',
  'function providerKind(address) view returns (uint8)',
  'function allowedRouter(address) view returns (bool)',
  'function allowedToken(address) view returns (bool)',
  'function maxLoan(address) view returns (uint256)',
  'function VERSION() view returns (string)',
  'function start((address provider,address asset,uint256 amount,uint256 maxFee,uint256 minProfit,uint256 deadline,(address router,uint8 kind,address tokenIn,address tokenOut,uint24 fee,uint256 minOut)[] legs) plan) returns (uint256 profit, uint256 fee)',
  'function pause()',
  'function unpause()',
  'function setProvider(address provider, uint8 kind)',
  'function setRouter(address router, bool enabled)',
  'function setToken(address token, bool enabled)',
  'function setMaxLoan(address asset, uint256 amount)',
  'event Executed(address indexed provider, address indexed asset, uint256 amount, uint256 fee, uint256 profit, bytes32 planHash)',
];
const ERC20 = ['function balanceOf(address) view returns (uint256)'];
const V2 = ['function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)'];
const QUOTER = ['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)'];
const AAVE = [
  'function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)',
  'function getConfiguration(address asset) view returns (uint256)',
  'function getReserveAToken(address asset) view returns (address)',
  'function getVirtualUnderlyingBalance(address asset) view returns (uint128)',
  'function getReserveData(address asset) view returns ((uint256,uint128,uint128,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128))',
];
const BALANCER = ['function getProtocolFeesCollector() view returns (address)', 'function getPausedState() view returns (bool paused, uint256 pauseWindowEndTime, uint256 bufferPeriodEndTime)'];
const BAL_FEES = ['function getFlashLoanFeePercentage() view returns (uint256)'];
const EULER = ['function asset() view returns (address)', 'function cash() view returns (uint256)'];
const OP_ORACLE = '0x420000000000000000000000000000000000000F';
const OP_ORACLE_ABI = ['function getL1Fee(bytes data) view returns (uint256)'];

export const executorInterface = new Interface(EXECUTOR_ABI);

function withTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(Error('RPC timeout')), ms); })]).finally(() => clearTimeout(t));
}

function revertReason(e) {
  return e?.revert?.args?.[0] || e?.reason || e?.shortMessage || e?.info?.error?.message || e?.message || String(e);
}

export function makeChain(net, url, {timeoutMs = 9000, env = process.env} = {}) {
  const provider = new JsonRpcProvider(url, net.id, {staticNetwork: true, batchMaxCount: 1});
  const t = (p) => withTimeout(p, timeoutMs);
  const rpc = (m, params) => t(provider.send(m, params));
  const exe = (address) => new Contract(address, EXECUTOR_ABI, provider);
  const privateUrl = broadcastUrl(net, env);
  const privateProvider = privateUrl ? new JsonRpcProvider(privateUrl, net.id, {staticNetwork: true, batchMaxCount: 1}) : null;
  const balanceOf = (token, who, blockTag) => t(new Contract(token, ERC20, provider).balanceOf(who, {blockTag}));

  return {
    provider,
    url,
    destroy: () => { provider.destroy(); privateProvider?.destroy(); },
    chainId: async () => Number(BigInt(await rpc('eth_chainId', []))),
    blockNumber: () => t(provider.getBlockNumber()),

    async feeData() {
      if (net.txType === 0) return {gasPrice: BigInt(await rpc('eth_gasPrice', []))};
      const block = await rpc('eth_getBlockByNumber', ['latest', false]);
      const base = BigInt(block.baseFeePerGas ?? '0x0');
      let tip;
      try { tip = BigInt(await rpc('eth_maxPriorityFeePerGas', [])); } catch { tip = 1_000_000n; }
      const gasPrice = BigInt(await rpc('eth_gasPrice', []));
      return {gasPrice, maxFeePerGas: base * 2n + tip, maxPriorityFeePerGas: tip, baseFeePerGas: base};
    },

    getBalance: (a) => t(provider.getBalance(a)),
    getNonce: (a, tag = 'pending') => t(provider.getTransactionCount(a, tag)),
    getTx: (h) => rpc('eth_getTransactionByHash', [h]),
    privateSubmission: Boolean(privateProvider),
    broadcast: (raw) => (privateProvider ? t(privateProvider.send('eth_sendRawTransaction', [raw])) : rpc('eth_sendRawTransaction', [raw])),
    estimateGas: (tx) => t(provider.estimateGas(tx)),

    async getReceipt(hash) {
      const r = await rpc('eth_getTransactionReceipt', [hash]);
      if (!r) return null;
      return {status: Number(BigInt(r.status)), gasUsed: BigInt(r.gasUsed), effectiveGasPrice: BigInt(r.effectiveGasPrice ?? '0x0'),
        l1Fee: r.l1Fee ? BigInt(r.l1Fee) : 0n, blockNumber: Number(BigInt(r.blockNumber)), logs: r.logs || []};
    },

    async codehash(address) {
      const code = await t(provider.getCode(address));
      return code && code !== '0x' ? keccak256(code) : null;
    },

    async l1FeeWei(nBytes) {
      const oracle = new Contract(OP_ORACLE, OP_ORACLE_ABI, provider);
      return BigInt(await t(oracle.getL1Fee('0x' + 'ff'.repeat(nBytes))));
    },

    async quoteV2(router, amountIn, a, b, blockTag) {
      const out = await t(new Contract(router, V2, provider).getAmountsOut(amountIn, [a, b], {blockTag}));
      return BigInt(out[out.length - 1]);
    },

    async quoteV3(quoter, a, b, fee, amountIn, blockTag) {
      const q = new Contract(quoter, QUOTER, provider);
      const r = await t(q.quoteExactInputSingle.staticCall({tokenIn: a, tokenOut: b, amountIn, fee, sqrtPriceLimitX96: 0n}, {blockTag}));
      return BigInt(r[0]);
    },

    async providerInfo(p, asset, blockTag) {
      if (p.kind === 'AAVE_V3') {
        const pool = new Contract(p.address, AAVE, provider);
        const [bps, cfg] = await Promise.all([t(pool.FLASHLOAN_PREMIUM_TOTAL({blockTag})), t(pool.getConfiguration(asset, {blockTag}))]);
        const c = BigInt(cfg);
        if (((c >> 56n) & 1n) !== 1n) return {ok: false, error: 'reserve inactive'};
        if (((c >> 60n) & 1n) === 1n) return {ok: false, error: 'reserve paused'};
        if (((c >> 63n) & 1n) !== 1n) return {ok: false, error: 'flash loans disabled for reserve'};
        let aToken;
        try { aToken = await t(pool.getReserveAToken(asset, {blockTag})); } catch { aToken = (await t(pool.getReserveData(asset, {blockTag})))[8]; }
        let available = BigInt(await balanceOf(asset, aToken, blockTag));
        try { const v = BigInt(await t(pool.getVirtualUnderlyingBalance(asset, {blockTag}))); if (v < available) available = v; } catch { /* pre-3.1 pool */ }
        return {ok: true, available, feeModel: 'aave-bps', feeParam: Number(bps), holder: aToken};
      }
      if (p.kind === 'BALANCER_V2') {
        const vault = new Contract(p.address, BALANCER, provider);
        const [state, collector] = await Promise.all([t(vault.getPausedState({blockTag})), t(vault.getProtocolFeesCollector({blockTag}))]);
        if (state[0]) return {ok: false, error: 'vault paused'};
        const pct = BigInt(await t(new Contract(collector, BAL_FEES, provider).getFlashLoanFeePercentage({blockTag})));
        return {ok: true, available: BigInt(await balanceOf(asset, p.address, blockTag)), feeModel: 'balancer-wad', feeParam: pct, holder: p.address};
      }
      if (p.kind === 'MORPHO_BLUE') {
        return {ok: true, available: BigInt(await balanceOf(asset, p.address, blockTag)), feeModel: 'zero', feeParam: 0, holder: p.address};
      }
      if (p.kind === 'EULER_V2') {
        const v = new Contract(p.address, EULER, provider);
        if (getAddress(await t(v.asset({blockTag}))) !== getAddress(asset)) return {ok: false, error: 'vault asset mismatch'};
        return {ok: true, available: BigInt(await t(v.cash({blockTag}))), feeModel: 'zero', feeParam: 0, holder: p.address};
      }
      return {ok: false, error: `unsupported provider ${p.kind}`};
    },

    async executorState(address, {provider: lender, routers, tokens, asset}) {
      const c = exe(address);
      const [owner, operator, paused, providerKind, maxLoan, routersAllowed, tokensAllowed] = await Promise.all([
        t(c.owner()), t(c.operator()), t(c.paused()), t(c.providerKind(lender)), t(c.maxLoan(asset)),
        Promise.all(routers.map((r) => t(c.allowedRouter(r)))), Promise.all(tokens.map((x) => t(c.allowedToken(x)))),
      ]);
      return {owner, operator, paused, providerKind: Number(providerKind), maxLoan: BigInt(maxLoan), routersAllowed, tokensAllowed};
    },

    encodeStart: (plan) => executorInterface.encodeFunctionData('start', [plan]),
    encodePause: () => executorInterface.encodeFunctionData('pause', []),

    async simulateStart(address, plan, from) {
      const data = executorInterface.encodeFunctionData('start', [plan]);
      try {
        const out = await t(provider.call({to: address, from, data}));
        const [profit, fee] = executorInterface.decodeFunctionResult('start', out);
        return {profit: BigInt(profit), fee: BigInt(fee)};
      } catch (e) {
        throw Error(`simulation reverted: ${revertReason(e)}`);
      }
    },

    async estimateStart(address, plan, from) {
      try { return BigInt(await t(provider.estimateGas({to: address, from, data: executorInterface.encodeFunctionData('start', [plan])}))); }
      catch (e) { throw Error(`gas estimation failed: ${revertReason(e)}`); }
    },

    decodeExecuted(receipt, address) {
      for (const log of receipt.logs || []) {
        if (String(log.address).toLowerCase() !== address.toLowerCase()) continue;
        try {
          const p = executorInterface.parseLog({topics: log.topics, data: log.data});
          if (p?.name === 'Executed') return {profit: BigInt(p.args.profit), fee: BigInt(p.args.fee), amount: BigInt(p.args.amount)};
        } catch { /* other event */ }
      }
      return null;
    },
  };
}

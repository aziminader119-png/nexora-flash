// Deterministic in-memory chain used by the Node test-suite. It models constant-product pools, a mempool with
// nonces, receipts, RPC outages, and the NexoraFlashExecutor rules (mirrors contracts/NexoraFlashExecutor.sol).
import crypto from 'node:crypto';

export const S = '0x00000000000000000000000000000000000000a1';
export const W = '0x00000000000000000000000000000000000000b2';
export const AAVE = '0x00000000000000000000000000000000000000c3';
export const MORPHO = '0x00000000000000000000000000000000000000c4';
export const RA = '0x00000000000000000000000000000000000000d5';
export const RB = '0x00000000000000000000000000000000000000d6';
export const QB = '0x00000000000000000000000000000000000000d7';
export const EXE = '0x00000000000000000000000000000000000000e8';
export const OPERATOR = '0x00000000000000000000000000000000000000f9';
export const CODEHASH = '0x' + 'ab'.repeat(32);

export const testNet = (over = {}) => ({
  id: 8453, name: 'TestNet', native: 'ETH', txType: 2, l1Fee: null, maxQuoteAgeMs: 60000, forkSuite: 'ForkBaseTest',
  stable: {address: S, symbol: 'USDC', decimals: 6}, wrapped: {address: W, symbol: 'WETH', decimals: 18},
  providers: [{kind: 'AAVE_V3', address: AAVE}, {kind: 'MORPHO_BLUE', address: MORPHO}],
  venues: [
    {id: 'a', name: 'DexA V2', type: 'v2', router: RA, forkValidated: true},
    {id: 'b', name: 'DexB V3', type: 'v3', router: RB, routerKind: 1, quoter: QB, fees: [500], forkValidated: true},
  ],
  ...over,
});

const ser = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? `${v}n` : v));
const de = (s) => JSON.parse(s, (k, v) => (typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));
const lc = (a) => String(a).toLowerCase();

export class FakeChain {
  constructor({chainId = 8453, now = () => Date.now()} = {}) {
    this.id = chainId;
    this.now = now;
    this.block = 1000;
    this.down = false;
    this.pools = {
      // key -> {router/quoter, type, fee(ppm), rS, rW}
      a: {type: 'v2', router: RA, fee: 3000, rS: 1_000_000n * 10n ** 6n, rW: 500n * 10n ** 18n},
      b: {type: 'v3', router: RB, quoter: QB, fee: 500, rS: 20_400_000n * 10n ** 6n, rW: 10_000n * 10n ** 18n},
    };
    this.providers = {
      [AAVE]: {ok: true, available: 5_000_000n * 10n ** 6n, feeModel: 'aave-bps', feeParam: 5},
      [MORPHO]: {ok: true, available: 0n, feeModel: 'zero', feeParam: 0},
    };
    this.exe = {owner: '0x0000000000000000000000000000000000000001', operator: OPERATOR, paused: false, codehash: CODEHASH,
      providerKind: {[AAVE]: 1, [MORPHO]: 3}, routers: {[RA]: true, [RB]: true}, tokens: {[S]: true, [W]: true}, maxLoan: 1000n * 10n ** 6n};
    this.gas = {gasPrice: 10n ** 9n, maxFeePerGas: 2n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 8n};
    this.nonceLatest = 0;
    this.mempool = [];
    this.mined = new Map();
    this.receipts = new Map();
    this.broadcasts = [];
    this.autoMine = true;
    this.balance = 10n ** 18n;
    this.broadcastError = null;
  }

  guard() { if (this.down) throw Error('RPC down: connection refused'); }

  // ---------------------------------------------------- market
  static out(p, amountIn, sToW) {
    const [rin, rout] = sToW ? [p.rS, p.rW] : [p.rW, p.rS];
    const inFee = amountIn * BigInt(1_000_000 - p.fee) / 1_000_000n;
    return inFee * rout / (rin + inFee);
  }
  poolBy(addr, fee) { return Object.values(this.pools).find((p) => (lc(p.router) === lc(addr) || lc(p.quoter || '') === lc(addr)) && (fee == null || p.type === 'v2' || p.fee === fee)); }
  swap(p, amountIn, sToW) {
    const o = FakeChain.out(p, amountIn, sToW);
    if (sToW) { p.rS += amountIn; p.rW -= o; } else { p.rW += amountIn; p.rS -= o; }
    return o;
  }

  // ---------------------------------------------------- scanner interface
  async chainId() { this.guard(); return this.id; }
  async blockNumber() { this.guard(); return this.block; }
  async feeData() { this.guard(); return {...this.gas}; }
  async quoteV2(router, amountIn, a, b) { this.guard(); const p = this.poolBy(router); if (!p || p.type !== 'v2') throw Error('no pool'); return FakeChain.out(p, amountIn, lc(a) === lc(S)); }
  async quoteV3(quoter, a, b, fee, amountIn) { this.guard(); const p = this.poolBy(quoter, fee); if (!p || p.type !== 'v3' || p.fee !== fee) throw Error('no pool'); return FakeChain.out(p, amountIn, lc(a) === lc(S)); }
  async providerInfo(p) { this.guard(); const i = this.providers[p.address]; if (!i) throw Error('unknown provider'); return {...i}; }
  async l1FeeWei(n) { this.guard(); return BigInt(n) * 10n ** 9n; }

  // ---------------------------------------------------- executor interface
  async codehash() { this.guard(); return this.exe.codehash; }
  async getBalance() { this.guard(); return this.balance; }
  async getNonce(addr, tag) { this.guard(); return tag === 'latest' ? this.nonceLatest : this.nonceLatest + this.mempool.length; }
  async getReceipt(h) { this.guard(); return this.receipts.get(h) || null; }
  async getTx(h) { this.guard(); return this.mempool.find((t) => t.hash === h) || this.mined.get(h) || null; }
  async estimateGas() { this.guard(); return 21000n; }
  async executorState(address, {provider, routers, tokens}) {
    this.guard();
    const e = this.exe;
    return {owner: e.owner, operator: e.operator, paused: e.paused, providerKind: e.providerKind[provider] || 0, maxLoan: e.maxLoan,
      routersAllowed: routers.map((r) => !!e.routers[r]), tokensAllowed: tokens.map((t) => !!e.tokens[Object.keys(e.tokens).find((k) => lc(k) === lc(t))])};
  }
  encodeStart(plan) { return '0x' + Buffer.from(ser({fn: 'start', plan})).toString('hex'); }
  encodePause() { return '0x' + Buffer.from(ser({fn: 'pause'})).toString('hex'); }
  decodeCall(data) { return data === '0x' ? {fn: 'transfer'} : de(Buffer.from(data.slice(2), 'hex').toString()); }

  /** Mirror of NexoraFlashExecutor.start(); `commit` applies swaps to the pools. */
  runStart(plan, from, commit) {
    const e = this.exe;
    if (lc(from) !== lc(e.operator) && lc(from) !== lc(e.owner)) throw Error('operator only');
    if (e.paused) throw Error('paused');
    const kind = e.providerKind[plan.provider];
    if (!kind) throw Error('provider not allowed');
    if (plan.amount <= 0n || plan.amount > e.maxLoan) throw Error('loan limit');
    if (BigInt(Math.floor(this.now() / 1000)) > plan.deadline) throw Error('expired');
    if (plan.minProfit <= 0n) throw Error('positive min profit required');
    for (const l of plan.legs) if (!e.routers[l.router]) throw Error('router not allowed');
    const info = this.providers[plan.provider];
    const fee = info.feeModel === 'aave-bps' ? (plan.amount * BigInt(info.feeParam) + 5000n) / 10000n : 0n;
    if (fee > plan.maxFee) throw Error('lender fee above limit');
    const saved = commit ? null : structuredClone(this.pools);
    let amt = plan.amount;
    try {
      for (const l of plan.legs) {
        const p = this.poolBy(l.router, l.fee || null);
        amt = this.swap(p, amt, lc(l.tokenIn) === lc(S));
        if (amt < l.minOut) throw Error('slippage');
      }
      if (amt < plan.amount + fee + plan.minProfit) throw Error('insufficient profit');
      return {profit: amt - plan.amount - fee, fee};
    } catch (err) {
      if (commit) throw err;
      throw err;
    } finally {
      if (saved) this.pools = saved;
    }
  }
  async simulateStart(address, plan, from) { this.guard(); try { return this.runStart(plan, from, false); } catch (e) { throw Error(`simulation reverted: ${e.message}`); } }
  async estimateStart(address, plan, from) { this.guard(); this.runStart(plan, from, false); return this.startGas ?? 400000n; }
  decodeExecuted(receipt) { return receipt.executed || null; }

  async broadcast(raw) {
    this.guard();
    if (this.broadcastError) { const m = this.broadcastError; this.broadcastError = null; throw Error(m); }
    const tx = de(raw);
    this.broadcasts.push(tx);
    if (tx.nonce < this.nonceLatest) throw Error('nonce too low');
    const same = this.mempool.findIndex((t) => t.nonce === tx.nonce);
    if (same >= 0) {
      const old = this.mempool[same];
      if ((tx.maxFeePerGas ?? tx.gasPrice) < (old.maxFeePerGas ?? old.gasPrice) * 11n / 10n) throw Error('replacement transaction underpriced');
      this.mempool.splice(same, 1);
    }
    this.mempool.push({...tx, hash: tx.hash, raw});
    if (this.autoMine) this.mine();
    return tx.hash;
  }

  mine() {
    this.block++;
    this.mempool.sort((a, b) => a.nonce - b.nonce);
    while (this.mempool.length && this.mempool[0].nonce === this.nonceLatest) {
      const tx = this.mempool.shift();
      const call = this.decodeCall(tx.data);
      const r = {status: 1, gasUsed: 300000n, effectiveGasPrice: tx.maxFeePerGas ?? tx.gasPrice, l1Fee: 0n, blockNumber: this.block, logs: []};
      try {
        if (call.fn === 'start') r.executed = this.runStart(call.plan, OPERATOR, true);
        if (call.fn === 'pause') this.exe.paused = true;
      } catch { r.status = 0; }
      this.receipts.set(tx.hash, r);
      this.mined.set(tx.hash, {...tx, blockNumber: this.block});
      this.nonceLatest++;
    }
  }
}

export function fakeSigner(address = OPERATOR) {
  return {
    address,
    async signTransaction(tx) {
      const hash = '0x' + crypto.createHash('sha256').update(ser(tx)).digest('hex');
      return {raw: ser({...tx, hash}), hash};
    },
  };
}

export function passingReport(over = {}) {
  return {
    schema: 1, generatedAt: new Date().toISOString(),
    steps: ['node-unit', 'forge-build', 'forge-unit', 'e2e-local'].map((id) => ({id, exitCode: 0})),
    executor: {runtimeCodehash: CODEHASH},
    forge: {fork: [
      {suite: 'ForkBaseTest', test: 'test_aave_roundTrip', status: 'Success'},
      {suite: 'ForkBaseTest', test: 'test_aave_revertKeepsLenderWhole', status: 'Success'},
    ]},
    ...over,
  };
}

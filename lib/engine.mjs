// Unattended execution engine. All chain access goes through an injected adapter (see chain-ethers.mjs), so the
// complete decision path - gates, simulation, gas accounting, signing, nonce handling, recovery - is unit-tested.
import {parseUnits, toFloat} from './units.mjs';
import {PROVIDER_KIND} from './networks.mjs';
import {weiToStable, protectedFloorUnits} from './profit.mjs';
import {buildPlan, validateFreshCandidate, checkQuoteConsistency} from './planner.mjs';
import {globalGateBlockers, networkGateBlockers} from './gates.mjs';

const DEFAULTS = {receiptTimeoutMs: 120000, pollMs: 1500, rebroadcastAfterMs: 30000, cancelAfterMs: 180000, gateMaxAgeDays: 14, deadlineSeconds: 60};
const msg = (e) => String(e?.shortMessage || e?.reason || e?.message || e).slice(0, 240);

export class Executor {
  /**
   * @param o.journal Journal
   * @param o.settings () => current settings
   * @param o.chainFor (net) => chain adapter
   * @param o.signer {address, signTransaction(tx) => {raw, hash}} | null
   * @param o.contracts {[chainId]: executorAddress}
   * @param o.gateReport () => validation report | null
   * @param o.liveEnabled boolean (LIVE_EXECUTION=true)
   * @param o.onAutoPause (reason) => void  persists paused=true
   */
  constructor(o) {
    this.journal = o.journal;
    this.settings = o.settings;
    this.chainFor = o.chainFor;
    this.signer = o.signer || null;
    this.contracts = o.contracts || {};
    this.gateReport = o.gateReport || (() => null);
    this.liveEnabled = o.liveEnabled === true;
    this.onAutoPause = o.onAutoPause || (() => {});
    this.log = o.log || (() => {});
    this.now = o.now || (() => Date.now());
    this.sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.opt = {...DEFAULTS, ...(o.options || {})};
    this.busy = false;
    this.seen = new Set();
    this.attempts = [];
    this.lastRebroadcast = new Map();
  }

  // ---------------------------------------------------------------- gates

  liveBlockers(net, c = null) {
    const s = this.settings();
    const b = [];
    if (!this.liveEnabled) b.push('LIVE_EXECUTION is not enabled');
    if (s.paused) b.push('emergency stop / paused');
    if (!s.liveChains.includes(net.id)) b.push(`${net.name} not enabled for live execution`);
    if (!this.signer) b.push('no signer loaded');
    if (!/^0x[0-9a-fA-F]{40}$/.test(this.contracts[net.id] || '')) b.push(`no executor contract configured for ${net.name}`);
    b.push(...globalGateBlockers(this.gateReport(), {now: this.now(), maxAgeDays: this.opt.gateMaxAgeDays}));
    if (this.journal.consecutiveFailures() >= s.maxConsecutiveFailures) b.push('circuit breaker: too many consecutive failures');
    if (this.journal.gasSpentToday() >= s.maxDailyGasUSD) b.push('daily gas budget exhausted');
    if (c) {
      if (c.size > s.maxLoanUSD) b.push('loan above configured maximum');
      if (!c.executable) b.push(`route not executable: ${(c.blockers || []).join('; ')}`);
      if (this.seen.has(c.id)) b.push('opportunity already attempted');
    }
    return b;
  }

  record(c, net, status, extra = {}) {
    const r = {at: new Date(this.now()).toISOString(), chainId: net.id, network: net.name, candidateId: c?.id, status, ...extra};
    this.attempts.push(r);
    if (this.attempts.length > 200) this.attempts.shift();
    this.log(status === 'blocked' ? 'info' : 'execution', `${net.name} ${status}${extra.reason ? ': ' + extra.reason : ''}${extra.hash ? ' ' + extra.hash : ''}`);
    return r;
  }

  // ---------------------------------------------------------------- main path

  async attempt(c, net) {
    if (this.busy) return {status: 'busy'};
    this.busy = true;
    try {
      const pre = this.liveBlockers(net, c);
      if (pre.length) return this.record(c, net, 'blocked', {reason: pre.join('; ')});
      this.seen.add(c.id);
      if (this.seen.size > 2000) this.seen = new Set([...this.seen].slice(-1000));
      const s = this.settings();
      const chain = this.chainFor(net);
      const address = this.contracts[net.id];

      const rec = await this.reconcile(net);
      if (rec.pending > 0) return this.record(c, net, 'blocked', {reason: 'previous transaction still pending'});

      const fresh = {now: this.now(), maxQuoteAgeMs: Math.min(s.maxQuoteAgeMs, net.maxQuoteAgeMs || s.maxQuoteAgeMs), maxBlockLag: net.maxBlockLag ?? 64};
      validateFreshCandidate(c, {...fresh, currentBlock: await chain.blockNumber()});

      const codehash = await chain.codehash(address);
      const gate = networkGateBlockers(this.gateReport(), {suite: net.forkSuite, providerKind: c.provider.kind, onchainCodehash: codehash});
      if (gate.length) return this.record(c, net, 'blocked', {reason: gate.join('; ')});

      const tokens = [...new Set(c.legs.flatMap((l) => [l.tokenIn.toLowerCase(), l.tokenOut.toLowerCase()]))];
      const st = await chain.executorState(address, {provider: c.provider.address, routers: c.legs.map((l) => l.router), tokens, asset: c.asset});
      if (st.operator.toLowerCase() !== this.signer.address.toLowerCase()) throw Error('signer is not the contract operator');
      if (st.paused) throw Error('executor contract is paused on-chain');
      if (Number(st.providerKind) !== PROVIDER_KIND[c.provider.kind]) throw Error('provider not allow-listed on-chain');
      if (!st.routersAllowed.every(Boolean)) throw Error('router not allow-listed on-chain');
      if (!st.tokensAllowed.every(Boolean)) throw Error('token not allow-listed on-chain');
      if (BigInt(st.maxLoan) < BigInt(c.amount)) throw Error('on-chain loan cap below amount');

      const fd = await chain.feeData();
      const gasPrice = net.txType === 0 ? fd.gasPrice : (fd.maxFeePerGas ?? fd.gasPrice);
      if (typeof gasPrice !== 'bigint' || gasPrice <= 0n) throw Error('no gas price');
      if (Number(gasPrice) / 1e9 > s.maxGasGwei) throw Error('gas price above ceiling');

      const d = c.decimals;
      const minNet = parseUnits(s.minProfitUSD.toFixed(Math.min(6, d)), d);
      const nativePrice = BigInt(c.nativePriceUnits);
      const maxFee = BigInt(c.provider.fee);
      const deadline = Math.floor(this.now() / 1000) + this.opt.deadlineSeconds;
      const from = this.signer.address;

      // Pass 1: floor from the scanner's gas model; simulate the exact transaction (eth_call).
      let plan = buildPlan(c, {slippageBps: s.slippageBps, minProfitUnits: protectedFloorUnits({minNetUnits: minNet, gasStableUnits: BigInt(c.gasStableUnits)}), maxFeeUnits: maxFee, deadline});
      const sim1 = await chain.simulateStart(address, plan, from);
      checkQuoteConsistency({quotedOut: c.legs.at(-1).quotedOut, amount: c.amount, simProfit: sim1.profit, simFee: sim1.fee, toleranceBps: s.slippageBps});

      // Real gas: estimate + L1 data fee, 20% headroom, priced at the max fee we are willing to pay.
      const gasEst = await chain.estimateStart(address, plan, from);
      const gasLimit = gasEst * 12n / 10n;
      if (gasLimit > BigInt(s.maxGasUnits)) throw Error(`gas limit ${gasLimit} exceeds configured ${s.maxGasUnits}`);
      const data = chain.encodeStart(plan);
      const l1 = net.l1Fee === 'op-stack' ? BigInt(await chain.l1FeeWei((data.length - 2) / 2 + 120)) * 3n / 2n : 0n;
      const worstWei = gasLimit * gasPrice + l1;
      const gasStable = weiToStable(worstWei, nativePrice);
      const gasUSD = toFloat(gasStable, d);
      if (gasUSD > s.maxGasPerTxUSD) throw Error(`gas cost ${gasUSD.toFixed(4)} above per-transaction cap`);
      if (this.journal.gasSpentToday() + gasUSD > s.maxDailyGasUSD) throw Error('daily gas budget would be exceeded');
      if (sim1.profit - gasStable < minNet) throw Error('simulated net profit after gas below minimum');

      // Pass 2: on-chain floor now covers the real worst-case gas; re-simulate the final calldata.
      plan = buildPlan(c, {slippageBps: s.slippageBps, minProfitUnits: protectedFloorUnits({minNetUnits: minNet, gasStableUnits: gasStable}), maxFeeUnits: maxFee, deadline});
      const sim2 = await chain.simulateStart(address, plan, from);
      const finalData = chain.encodeStart(plan);
      validateFreshCandidate(c, {...fresh, now: this.now(), currentBlock: await chain.blockNumber()});
      if ((await chain.getBalance(from)) < worstWei) throw Error('insufficient native balance for gas');

      const nonce = await chain.getNonce(from, 'pending');
      const tx = this.txRequest(net, {to: address, data: finalData, nonce, gasLimit, fd});
      const {raw, hash} = await this.signer.signTransaction(tx);
      this.journal.append({kind: 'tx', status: 'submitted', purpose: 'arbitrage', chainId: net.id, nonce, hash, raw, gasReserveUSD: gasUSD,
        maxFeePerGas: String(tx.maxFeePerGas ?? tx.gasPrice), candidateId: c.id, provider: c.provider.kind, route: `${c.buy} -> ${c.sell}`,
        loan: c.size, expectedProfitUnits: sim2.profit.toString(), decimals: d, nativePriceUnits: c.nativePriceUnits, asset: c.assetSymbol, network: net.name});

      try {
        await chain.broadcast(raw);
      } catch (e) {
        const reason = msg(e);
        this.journal.append({kind: 'broadcast_error', chainId: net.id, nonce, hash, reason});
        // A broadcast error does NOT prove the raw transaction was never seen
        // by the network (e.g. nonce-too-low, timeout, replacement-underpriced).
        // Keep the journal entry pending until receipt/nonce reconciliation
        // conclusively resolves it. Never release a possibly consumed nonce.
        this.checkBreaker();
        return this.record(c, net, 'broadcast_error', {reason, hash});
      }
      this.record(c, net, 'submitted', {hash});

      const receipt = await this.waitReceipt(chain, hash);
      if (!receipt) return this.record(c, net, 'pending', {hash, reason: 'no receipt yet; recovery will continue'});
      return this.record(c, net, this.settle(net, chain, address, {nonce, hash, purpose: 'arbitrage', nativePrice, decimals: d}, receipt), {hash});
    } catch (e) {
      return this.record(c, net, 'blocked', {reason: msg(e)});
    } finally {
      this.busy = false;
    }
  }

  txRequest(net, {to, data, nonce, gasLimit, fd, value = 0n, bump = null}) {
    const base = {chainId: net.id, to, data, nonce, gasLimit, value};
    if (net.txType === 0) {
      let gasPrice = fd.gasPrice;
      if (bump) gasPrice = (gasPrice > bump ? gasPrice : bump) * 13n / 10n;
      return {...base, type: 0, gasPrice};
    }
    let maxFeePerGas = fd.maxFeePerGas ?? fd.gasPrice;
    let maxPriorityFeePerGas = fd.maxPriorityFeePerGas ?? 0n;
    if (bump) {
      maxFeePerGas = (maxFeePerGas > bump ? maxFeePerGas : bump) * 13n / 10n;
      maxPriorityFeePerGas = maxPriorityFeePerGas * 13n / 10n + 1n;
    }
    if (maxPriorityFeePerGas > maxFeePerGas) maxPriorityFeePerGas = maxFeePerGas;
    return {...base, type: 2, maxFeePerGas, maxPriorityFeePerGas};
  }

  async waitReceipt(chain, hash, timeoutMs = this.opt.receiptTimeoutMs) {
    const end = this.now() + timeoutMs;
    for (;;) {
      try { const r = await chain.getReceipt(hash); if (r) return r; } catch { /* transient RPC error: keep polling */ }
      if (this.now() >= end) return null;
      await this.sleep(this.opt.pollMs);
    }
  }

  settle(net, chain, address, {nonce, hash, purpose, nativePrice, decimals}, receipt) {
    const gasWei = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice ?? receipt.gasPrice ?? 0n) + BigInt(receipt.l1Fee ?? 0n);
    const actualGasUSD = nativePrice ? toFloat(weiToStable(gasWei, nativePrice), decimals) : null;
    if (receipt.status === 1) {
      const ev = purpose === 'arbitrage' ? chain.decodeExecuted(receipt, address) : null;
      this.journal.append({kind: 'tx', status: purpose === 'cancel' ? 'cancelled' : 'confirmed', purpose, chainId: net.id, nonce, hash, block: receipt.blockNumber, gasUsed: String(receipt.gasUsed), actualGasUSD,
        profitUnits: ev ? ev.profit.toString() : null, feeUnits: ev ? ev.fee.toString() : null,
        profit: ev ? toFloat(ev.profit, decimals) : null, netAfterGas: ev && actualGasUSD != null ? toFloat(ev.profit, decimals) - actualGasUSD : null});
      return purpose === 'cancel' ? 'cancelled' : 'confirmed';
    }
    this.journal.append({kind: 'tx', status: 'failed', purpose, chainId: net.id, nonce, hash, block: receipt.blockNumber, gasUsed: String(receipt.gasUsed), actualGasUSD});
    this.checkBreaker();
    return 'failed';
  }

  checkBreaker() {
    const s = this.settings();
    const n = this.journal.consecutiveFailures();
    if (n >= s.maxConsecutiveFailures && !s.paused) {
      this.journal.append({kind: 'auto_pause', reason: `circuit breaker after ${n} consecutive failures`});
      this.onAutoPause(`circuit breaker after ${n} consecutive failures`);
    }
  }

  // ---------------------------------------------------------------- recovery

  /** Resolve journaled transactions after restarts/RPC failures; rebroadcast or cancel stuck ones. */
  async reconcile(net) {
    const pend = this.journal.pending(net.id);
    if (!pend.length) return {pending: 0};
    if (!this.signer) return {pending: pend.length};
    const chain = this.chainFor(net);
    for (const g of pend) {
      let phase = 'receipt';
      try {
      let done = false;
      // Check newest replacement first: an old dropped hash may error on fork RPCs
      // while the cancellation receipt already exists and should settle the nonce.
      for (const h of [...g.hashes].reverse()) {
        let r;
        try {
          r = await chain.getReceipt(h);
        } catch (receiptError) {
          // Some fork RPCs error instead of returning null for a pending receipt.
          // Only treat it as pending if a separate transaction lookup confirms
          // the original hash is still in the mempool and not mined.
          const tx = await chain.getTx(h);
          if (!tx || tx.blockNumber != null || tx.blockHash != null) throw receiptError;
          r = null;
        }
        if (r) {
          const isCancel = h !== g.hashes[0];
          this.settle(net, chain, this.contracts[net.id], {nonce: g.nonce, hash: h, purpose: isCancel ? 'cancel' : g.purpose || 'arbitrage', nativePrice: g.meta?.nativePriceUnits ? BigInt(g.meta.nativePriceUnits) : null, decimals: g.meta?.decimals ?? net.stable.decimals}, r);
          if (isCancel) this.journal.append({kind: 'tx', status: 'replaced', purpose: g.purpose, chainId: net.id, nonce: g.nonce, hash: g.hashes[0]});
          done = true;
          break;
        }
      }
      if (done) continue;
      phase = 'latest nonce';
      const latest = await chain.getNonce(this.signer.address, 'latest');
      if (latest > g.nonce) { this.journal.append({kind: 'tx', status: 'replaced', purpose: g.purpose, chainId: net.id, nonce: g.nonce, hash: g.hashes[0], reason: 'nonce consumed by another transaction'}); continue; }
      phase = 'replacement';
      const age = this.now() - Date.parse(g.submittedAt || 0);
      if (!g.cancelSent && age > this.opt.cancelAfterMs) {
        await this.replaceNonce(net, chain, g, 'cancel');
      } else if (age > this.opt.rebroadcastAfterMs) {
        const key = `${net.id}:${g.nonce}`;
        if (this.now() - (this.lastRebroadcast.get(key) || 0) > this.opt.rebroadcastAfterMs) {
          this.lastRebroadcast.set(key, this.now());
          for (const h of g.hashes) {
            if (g.raw[h] && !(await chain.getTx(h))) {
              try { await chain.broadcast(g.raw[h]); this.journal.append({kind: 'tx', status: 'rebroadcast', purpose: g.purpose, chainId: net.id, nonce: g.nonce, hash: h}); }
              catch (e) { this.journal.append({kind: 'rebroadcast_error', chainId: net.id, nonce: g.nonce, hash: h, reason: msg(e)}); }
            }
          }
        }
      }
      } catch (e) {
        // Fail closed: an RPC error must never clear journaled pending nonce
        // or permit another broadcast with an uncertain transaction state.
        this.log('warning', `reconcile ${phase} error on chain ${net.id}, nonce ${g.nonce}: ${msg(e)} (code ${e?.code || 'unknown'}, rpcCode ${e?.info?.error?.code ?? 'unknown'})`);
        return {pending: this.journal.pending(net.id).length};
      }
    }
    return {pending: this.journal.pending(net.id).length};
  }

  /** Same-nonce replacement: a zero-value self transfer (cancel) or an executor pause() (emergency). */
  async replaceNonce(net, chain, g, mode) {
    const fd = await chain.feeData();
    const bump = g.maxFeePerGas ? BigInt(g.maxFeePerGas) : null;
    const to = mode === 'pause' ? this.contracts[net.id] : this.signer.address;
    const data = mode === 'pause' ? chain.encodePause() : '0x';
    const gasLimit = mode === 'pause' ? 120000n : await chain.estimateGas({from: this.signer.address, to, data, value: 0n});
    const tx = this.txRequest(net, {to, data, nonce: g.nonce, gasLimit, fd, bump: bump ?? (fd.maxFeePerGas ?? fd.gasPrice)});
    const {raw, hash} = await this.signer.signTransaction(tx);
    this.journal.append({kind: 'tx', status: 'cancel_submitted', purpose: mode, chainId: net.id, nonce: g.nonce, hash, raw, maxFeePerGas: String(tx.maxFeePerGas ?? tx.gasPrice)});
    try { await chain.broadcast(raw); } catch (e) { this.journal.append({kind: 'broadcast_error', chainId: net.id, nonce: g.nonce, hash, reason: msg(e), purpose: mode}); }
    this.log('warning', `${net.name}: ${mode} replacement sent for nonce ${g.nonce} (${hash})`);
    return hash;
  }

  // ---------------------------------------------------------------- emergency stop

  /** Local pause immediately; then best-effort on-chain pause() on every configured network. */
  async emergencyStop(nets, reason = 'operator emergency stop') {
    this.journal.append({kind: 'emergency_stop', reason});
    this.onAutoPause(reason);
    const results = [];
    if (!this.signer) return [{status: 'local-only', reason: 'no signer loaded; on-chain pause must be sent by the owner wallet'}];
    for (const net of nets) {
      const address = this.contracts[net.id];
      if (!address) continue;
      try {
        const chain = this.chainFor(net);
        const st = await chain.executorState(address, {provider: address, routers: [], tokens: [], asset: address});
        if (st.paused) { results.push({chainId: net.id, status: 'already-paused'}); continue; }
        const pend = this.journal.pending(net.id);
        let hash;
        if (pend.length) hash = await this.replaceNonce(net, chain, pend[0], 'pause'); // also cancels the stuck trade
        else {
          const fd = await chain.feeData();
          const nonce = await chain.getNonce(this.signer.address, 'pending');
          const tx = this.txRequest(net, {to: address, data: chain.encodePause(), nonce, gasLimit: 120000n, fd, bump: fd.maxFeePerGas ?? fd.gasPrice});
          const signed = await this.signer.signTransaction(tx);
          hash = signed.hash;
          this.journal.append({kind: 'tx', status: 'submitted', purpose: 'pause', chainId: net.id, nonce, hash, raw: signed.raw, gasReserveUSD: 0, maxFeePerGas: String(tx.maxFeePerGas ?? tx.gasPrice)});
          await chain.broadcast(signed.raw);
        }
        results.push({chainId: net.id, status: 'pause-sent', hash});
      } catch (e) {
        results.push({chainId: net.id, status: 'error', reason: msg(e)});
      }
    }
    return results;
  }
}

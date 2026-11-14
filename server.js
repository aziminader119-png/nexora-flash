// NEXORA v1.2 service: automatic multi-network scanning, gated unattended execution, single-page dashboard.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {NETWORKS, withEnvProviders, PROVIDER_FORK_TEST, MULTIHOP_FORK_GATE_TEST} from './lib/networks.mjs';
import {loadSettings, applySettingsUpdate, loanCeiling} from './lib/settings.mjs';
import {scanNetwork} from './lib/scanner.mjs';
import {discoverMultiHopCycles} from './lib/multihop.mjs';
import {loadMultiHopCatalog, catalogHasTrustedVenues} from './lib/multihop-catalog.mjs';
import {RouteObservations} from './lib/route-observations.mjs';
import {traceAmounts, probeRouteImpact, compareRouteSizes} from './lib/route-diagnostics.mjs';
import {reviewObservedRoutes, rankObservedRoutes} from './lib/route-quality.mjs';
import {rankRouteFamilies, chooseImpactProbes} from './lib/route-intelligence.mjs';
import {refineLoanSizes} from './lib/route-refinement.mjs';
import {routeDepthBudgets} from './lib/route-budget.mjs';
import {projectCurrentScan} from './lib/scan-reliability.mjs';
import {discoverPublishedSpreads, fetchPublishedPairsDetailed} from './lib/market-discovery.mjs';
import {Journal} from './lib/journal.mjs';
import {Executor} from './lib/engine.mjs';
import {loadGateReport, globalGateBlockers, forkTestPassed} from './lib/gates.mjs';
import {createLogger} from './lib/logger.mjs';
import {makeChain} from './lib/chain-ethers.mjs';
import {hostAllowed} from './lib/http-guard.mjs';
import {loadSigner} from './lib/keys.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const PORT = Number(env.PORT || 3080);
const BIND_HOST = env.BIND_HOST || '127.0.0.1';
const INTERVAL_MS = Math.max(5000, Number(env.SCAN_INTERVAL_MS || 30000));
const ADMIN_TOKEN = env.ADMIN_TOKEN || '';
const DATA_DIR = env.DATA_DIR || path.join(root, 'data');
const CONFIG_PATH = env.CONFIG_PATH || path.join(DATA_DIR, 'settings.json');
const GATE_REPORT = env.GATE_REPORT || path.join(root, 'validation', 'gate-report.json');
const LIVE = env.LIVE_EXECUTION === 'true';
// Separate opt-in. Five-to-ten leg routes remain disabled if this is unset.
const LONG_ROUTES = env.MULTIHOP_EXECUTION_ENABLED === 'true';
const LONG_ROUTE_CHAIN_IDS = new Set(String(env.MULTIHOP_EXECUTION_CHAINS || '').split(',').map((v) => Number(v.trim())).filter(Number.isInteger));

fs.mkdirSync(DATA_DIR, {recursive: true, mode: 0o700});
const log = createLogger({file: env.LOG_PATH || path.join(DATA_DIR, 'nexora.log.jsonl')});
const journal = new Journal(env.JOURNAL_PATH || path.join(DATA_DIR, 'execution-journal.jsonl'));
// Separate read-only scanner data from funded execution history.
const routeObservations = new RouteObservations(path.join(DATA_DIR, 'route-scan-history.jsonl'));

let settings;
try { settings = loadSettings(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))); } catch { settings = loadSettings(null); }
function persistSettings(next) {
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), {mode: 0o600});
  fs.renameSync(tmp, CONFIG_PATH);
  settings = next;
}

const nets = NETWORKS.map((n) => withEnvProviders(n, env));
const contracts = Object.fromEntries(nets.map((n) => [n.id, env[`EXECUTOR_${n.id}`] || '']).filter(([, a]) => a));
const chains = new Map();
const chainFor = (net) => {
  if (!chains.has(net.id)) chains.set(net.id, makeChain(net, env[`RPC_${net.id}`] || net.rpcDefault, {timeoutMs: Number(env.RPC_TIMEOUT_MS || 9000)}));
  return chains.get(net.id);
};

let gateReport = loadGateReport(GATE_REPORT);
let signer = null;
try { signer = await loadSigner(env); } catch (e) { log('error', `Signer not loaded: ${e.message}`); }
if (signer) log('info', `Operator signer loaded: ${signer.address}`);

const executor = new Executor({
  journal, settings: () => settings, chainFor, signer, contracts, liveEnabled: LIVE,
  longRouteEnabled: LONG_ROUTES,
  gateReport: () => gateReport,
  onAutoPause: (reason) => { if (!settings.paused) { persistSettings({...settings, paused: true}); log('error', `AUTO-PAUSED: ${reason}`); } },
  log: (level, m) => log(level, m),
});

const states = new Map();
const marketDiscoveryCache = new Map(); // Read-only, 60s TTL. Never feeds executor.
const marketDiscoveryInflight = new Map(); // Throttle upstream traffic on concurrent requests.
const multiHopTurn = new Map(); // Rotate first-hop selection between scans (AUDIT M-A)
let opportunities = [];
let busy = false, lastScan = null, scans = 0;

async function cycle() {
  if (busy) return;
  busy = true;
  // Previous outcomes may weight read-only future scan budgets, but may
  // NEVER be displayed or executed as fresh opportunities.
  const previousScanCandidates=opportunities;
  opportunities = [];
  scans++;
  try {
    gateReport = loadGateReport(GATE_REPORT);
    // Recovery runs even while paused, so pending transactions always get resolved after restarts.
    if (signer) await Promise.all(nets.filter((n) => contracts[n.id]).map((n) => executor.reconcile(n).catch((e) => log('warning', `${n.name} recovery: ${e.message}`))));
    if (settings.paused) {
      // Do not keep displaying old candidates while a paused scanner has
      // stopped refreshing quotes. No transactions are permitted here.
      opportunities = [];
      log('info', 'Paused: scanning and execution suspended');
      return;
    }
    const enabled = nets.filter((n) => settings.enabledChains.includes(n.id));
    // Prefer lenders whose fork round-trip passed for this network, so candidates are executable under the gate.
    // No passing or fresh gate report => no validated lender, even for quoted routes.
    const eligible = (net) => (globalGateBlockers(gateReport).length ? [] : net.providers.map((p) => p.kind).filter((k) => forkTestPassed(gateReport, net.forkSuite, PROVIDER_FORK_TEST[k])));
    const routeCatalog = loadMultiHopCatalog(env.MULTIHOP_CATALOG_FILE, nets, log);
    const results = await Promise.all(enabled.map(async (net) => {
      // In scan-only mode, quote real lender availability/fees for analytics, but never
      // infer authorization from quote availability. LIVE keeps strict fork gating.
      const r = await scanNetwork({chain: chainFor(net), net, settings, preferKinds: LIVE ? eligible(net) : null});
      r.state.multiHopQuotes = 0;
      r.state.multiHopCycles = 0;
      r.state.multiHopTruncated = false;
      if (r.state.status !== 'quotes-live' || !routeCatalog.has(net.id)) return r;
      try {
        // A zero-result legacy USDC/WETH quote does not imply the catalog
        // contains no profitable 2-10 hop cycle. Scanner state has its own
        // block-pinned gas/native prices independent of legacy candidates.
        const edges = routeCatalog.get(net.id);
        // Explicit network consent + independently passing on-chain fork suite
        // + canonical venue identity; JSON claims alone are never authority.
        const allowExecution = LIVE && LONG_ROUTES && LONG_ROUTE_CHAIN_IDS.has(net.id)
          && globalGateBlockers(gateReport).length === 0
          && forkTestPassed(gateReport, net.forkSuite, MULTIHOP_FORK_GATE_TEST)
          && catalogHasTrustedVenues(net, edges);
        // Keep short 3-4 hop catalog routes separate from the existing long
        // execution gate: new short routes are ALWAYS observation-only.
        const quoteContext = {
          chain: chainFor(net), net: {...net, routeEdges: edges}, settings,
          block: r.state.block, gasPrice: BigInt(r.state.gasPriceWei),
          nativePrice: BigInt(r.state.nativePriceUnits),
          infos: await Promise.all(net.providers.map(async (p) => {
            try { return {...await chainFor(net).providerInfo(p, net.stable.address, r.state.block), kind: p.kind, address: p.address}; }
            catch { return {kind: p.kind, address: p.address, ok: false, error: 'provider quote unavailable'}; }
          })), preferKinds: LIVE ? eligible(net) : null,
          l1FeeWei: net.l1Fee === 'op-stack' ? (await chainFor(net).l1FeeWei(1100)) * 3n / 2n : 0n,
          at: r.state.quotedAt, rotation: (multiHopTurn.get(net.id) ?? 0),
        };
        // Independent depth budgets guarantee that a 4-hop candidate can
        // finish even when the 3-hop roots are numerous. Both are quote-only.
        const priorDepthObservations = [
          ...previousScanCandidates.filter(c=>c.chainId===net.id),
          ...(routeObservations.latest.get(net.id)?.cycles||[]),
        ];
        const budgetPlan = routeDepthBudgets(priorDepthObservations);
        r.state.depthQuoteBudgets = budgetPlan.budgets;
        const sharedQuoteCache = new Map(); // One exact-network/block cycle only
        // Expand 2-hop discovery beyond the legacy stable/wrapped pair,
        // but only along explicitly cataloged on-chain pools. It is NEVER
        // promoted to a funded 2-hop opportunity.
        const duo = await discoverMultiHopCycles({
          ...quoteContext, minDepth:2, maxDepth:2, maxQuotes:budgetPlan.budgets.two,
          allowExecution:false, quoteCache:sharedQuoteCache,
        });
        const tri = await discoverMultiHopCycles({
          ...quoteContext, minDepth:3, maxDepth:3, maxQuotes:budgetPlan.budgets.three,
          allowExecution:false, quoteCache:sharedQuoteCache,
        });
        const quad = await discoverMultiHopCycles({
          ...quoteContext, minDepth:4, maxDepth:4, maxQuotes:budgetPlan.budgets.four,
          allowExecution:false, quoteCache:sharedQuoteCache,
        });
        const long = await discoverMultiHopCycles({...quoteContext, minDepth:5,
          maxDepth:10, maxQuotes:budgetPlan.budgets.long, allowExecution,
          quoteCache:allowExecution ? null : sharedQuoteCache});
        const extra = {
          candidates:[...duo.candidates,...tri.candidates,...quad.candidates,...long.candidates]
            .sort((a,b)=>b.netEstimate-a.netEstimate),
          scannedQuotes:duo.scannedQuotes+tri.scannedQuotes+quad.scannedQuotes+long.scannedQuotes,
          truncated:duo.truncated||tri.truncated||quad.truncated||long.truncated,
          rootsExplored:duo.rootsExplored+tri.rootsExplored+quad.rootsExplored+long.rootsExplored,
          rootsEligible:Math.max(duo.rootsEligible,tri.rootsEligible,quad.rootsEligible,long.rootsEligible),
        };
        r.state.catalogTwoHopQuotes = duo.scannedQuotes;
        r.state.catalogTwoHopCycles = duo.candidates.length;
        r.state.shortCycleQuotes = duo.scannedQuotes+tri.scannedQuotes+quad.scannedQuotes;
        r.state.shortCycleCount = tri.candidates.length+quad.candidates.length;
        r.state.threeHopCycles = tri.candidates.length;
        r.state.fourHopCycles = quad.candidates.length;
        r.state.longCycleQuotes = long.scannedQuotes;
        r.state.longCycleCount = long.candidates.length;
        r.state.quoteCacheHits = duo.cacheHits+tri.cacheHits+quad.cacheHits+long.cacheHits;
        // Only re-quote near-profitable observed paths at an intermediate
        // loan amount. No public price, trade simulation, or authorization.
        if (!LIVE) {
          try {
            const refined = await refineLoanSizes({
              ...quoteContext,candidates:extra.candidates,
              maxQuotes:24,maxRoutes:2,nearMissUSD:1,
            });
            extra.candidates.push(...refined.candidates);
            extra.candidates.sort((a,b)=>b.netEstimate-a.netEstimate);
            extra.scannedQuotes+=refined.quotes;
            r.state.refinementQuotes=refined.quotes;
            r.state.refinementCycles=refined.refined;
          } catch(e) {
            // A bonus size refinement must NEVER discard previously valid
            // catalog quotes from other paths.
            r.state.refinementError=String(e.message||e).slice(0,160);
            log('warning', net.name+' size refinement: '+r.state.refinementError);
          }
        }
        multiHopTurn.set(net.id, ((multiHopTurn.get(net.id) ?? 0) + 1) % 1_000_000);
        r.state.multiHopQuotes = extra.scannedQuotes;
        r.state.multiHopCycles = extra.candidates.length;
        r.state.multiHopTruncated = extra.truncated;
        r.state.multiHopRootsExplored = extra.rootsExplored ?? 0;
        r.state.multiHopRootsEligible = extra.rootsEligible ?? 0;
        // Diagnostics never authorize trades. All per-hop traces preserve token raw units.
        if (!LIVE) {
          for (const c of extra.candidates) c.diagnostics = {
            method:'AMOUNT_TRACE_ONLY',trace:traceAmounts(c, edges),liquidityRisk:'UNKNOWN',
            probesIncomplete:true,caveat:'Raw token amounts are not comparable USD values.'};
          try {
            const samples = await probeRouteImpact({chain:chainFor(net),
              candidates:chooseImpactProbes(extra.candidates,{minProfitUSD:settings.minProfitUSD,maxRoutes:2}),routeEdges:edges,block:r.state.block,
              maxRoutes:2,maxProbes:10});
            for (const c of extra.candidates) {
              const d = samples.diagnostics.get(c.id);
              if (d) c.diagnostics = d;
            }
            r.state.multiHopImpactProbes = samples.probesUsed;
          } catch (e) {
            r.state.multiHopImpactError = String(e.message || e).slice(0,160);
            log('warning', net.name + ' read-only impact probe: ' + r.state.multiHopImpactError);
          }
        }
        r.candidates = [...r.candidates, ...extra.candidates].sort((a, b) => b.netEstimate - a.netEstimate);
      } catch (e) {
        r.state.multiHopError = String(e.message || e).slice(0,180);
        log('warning', net.name + ' multi-hop read-only scan: ' + r.state.multiHopError);
      }
      return r;
    }));
    for (const [i, r] of results.entries()) {
      // A partially failed scan is never allowed to carry stale paths.
      states.set(enabled[i].id, r.state);
      if (!LIVE) for (const c of r.candidates) {
        c.executable = false;
        if (!c.blockers.includes('scan-only: funded execution disabled')) c.blockers.push('scan-only: funded execution disabled');
        c.profitQualification = c.provider ? 'INDICATIVE_WITH_QUOTED_LENDER_FEE' : 'INCOMPLETE_MISSING_LENDER_FEE';
      }
      // Failed network scans also supersede old read-only route history:
      // no stale quote can leak through /api/multihop/* or intelligence.
      try {
        routeObservations.record(enabled[i],r.state,
          r.state.status==='quotes-live'?r.candidates:[],
          {minimumProfit:settings.minProfitUSD});
      } catch(err) { log('warning',`${enabled[i].name} route observations: ${err.message}`); }
      const pos = r.candidates.filter(c=>c.netEstimate >= settings.minProfitUSD);
      if(r.state.status !== 'quotes-live')
        log('warning',`${enabled[i].name}: ${r.state.error||'scan unavailable'}`);
      else log(pos.length?'candidate':'info',
        `${enabled[i].name}: ${r.candidates.length} quoted routes, ${pos.length} above $${settings.minProfitUSD} (block ${r.state.block})`);
    }
    for(const id of states.keys()) if(!settings.enabledChains.includes(id))states.delete(id);
    const projection=projectCurrentScan(enabled,results);
    for(const networkState of projection.networks)states.set(networkState.chainId,networkState);
    opportunities=projection.candidates;
    if(projection.failures.length)
      log('warning',`Partial scan: ${projection.healthyNetworks}/${projection.totalNetworks} networks healthy; failed-network candidates excluded`);
    if (LIVE && settings.autoExecute) {
      for (const net of enabled.filter((n) => settings.liveChains.includes(n.id))) {
        const best = opportunities.find((c) => c.chainId === net.id && c.executable && c.netEstimate >= settings.minProfitUSD);
        if (best) await executor.attempt(best, net);
      }
    }
  } catch (e) {
    // An exception in any scan phase invalidates the entire current quote
    // snapshot. Never display stale per-network health as if it succeeded.
    opportunities=[];
    for(const net of nets.filter(n=>settings.enabledChains.includes(n.id))) {
      const failed={chainId:net.id,name:net.name,status:'unavailable',
        block:null,error:'scan cycle failed; current quotes not available'};
      states.set(net.id,failed);
      try {routeObservations.record(net,failed,[],{minimumProfit:settings.minProfitUSD});}
      catch {/* never let error reporting prevent fail-closed invalidation */ }
    }
    log('error', `Cycle failed: ${e.message}`);
  } finally {
    lastScan = new Date().toISOString();
    busy = false;
  }
}

function authorized(req) {
  const got = Buffer.from(String(req.headers['x-admin-token'] || ''));
  const want = Buffer.from(ADMIN_TOKEN);
  return ADMIN_TOKEN.length >= 24 && got.length === want.length && crypto.timingSafeEqual(got, want);
}

async function body(req) {
  const chunks = [];
  let bytes = 0;
  for await (const ch of req) { bytes += ch.length; if (bytes > 16384) throw Error('payload too large'); chunks.push(ch); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

const json = (res, code, obj) => { res.writeHead(code, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(obj, (k, v) => (typeof v === 'bigint' ? v.toString() : v))); };

function status() {
  const globalBlockers = globalGateBlockers(gateReport);
  return {
    version: '1.2.0',
    mode: !LIVE ? 'SCAN_ONLY' : settings.paused ? 'PAUSED' : settings.autoExecute ? 'AUTO_EXECUTION' : 'LIVE_MANUAL',
    liveExecutionEnabled: LIVE, longRouteExecutionOptIn: LONG_ROUTES,
    longRouteChainIds: [...LONG_ROUTE_CHAIN_IDS], signer: signer?.address || null, contracts, loanCeiling: loanCeiling(),
    gate: {passed: globalBlockers.length === 0, blockers: globalBlockers, generatedAt: gateReport?.generatedAt || null, codehash: gateReport?.executor?.runtimeCodehash || null},
    networks: nets.filter((n) => settings.enabledChains.includes(n.id)).map((n) => ({...(states.get(n.id) || {chainId: n.id, name: n.name, status: 'pending'}), liveBlockers: executor.liveBlockers(n), forkSuite: n.forkSuite})),
    registry: nets.map((n) => ({id: n.id, name: n.name, providers: n.providers.map((p) => p.kind), venues: n.venues.map((v) => ({name: v.name, forkValidated: v.forkValidated}))})),
    scans, busy, lastScan, intervalMs: INTERVAL_MS, settings,
    opportunities: opportunities.slice(0, 100),
    trades: journal.trades().slice(-100).reverse(),
    pending: journal.pending(),
    attempts: executor.attempts.slice(-50).reverse(),
    gasSpentTodayUSD: journal.gasSpentToday(),
    consecutiveFailures: journal.consecutiveFailures(),
    logs: log.recent(150),
    configWritable: ADMIN_TOKEN.length >= 24,
  };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!hostAllowed(req.headers.host)) return json(res, 421, {error: 'host not allowed'});
  const u = new URL(req.url, 'http://localhost');
  try {
    if (u.pathname === '/api/health') return json(res, 200, {alive: true, lastScan, paused: settings.paused, pending: journal.pending().length});
    if (u.pathname === '/api/status' && req.method === 'GET') return json(res, 200, status());
    // Read-only dedicated endpoints: the dashboard keeps its legacy response and 100-item limit.
    if (req.method === 'GET' && u.pathname === '/api/multihop/cycles')
      return json(res, 200, routeObservations.cycles(Object.fromEntries(u.searchParams)));
    if (req.method === 'GET' && u.pathname === '/api/multihop/stats')
      return json(res, 200, routeObservations.stats());
    if (req.method === 'GET' && u.pathname === '/api/multihop/history')
      return json(res, 200, routeObservations.scans(Object.fromEntries(u.searchParams)));
    if (req.method === 'GET' && u.pathname === '/api/discovery/spreads') {
      const chain = u.searchParams.get('chain') || 'base';
      if (!['base','arbitrum'].includes(chain)) return json(res,400,{error:'unsupported discovery chain'});
      const previous = marketDiscoveryCache.get(chain);
      if (previous && Date.now() - previous.at < 60_000)
        return json(res,200,{...previous.data,cacheAgeMs:Date.now()-previous.at});
      // A single in-flight refresh per chain avoids upstream request floods.
      // No discovery result is ever promoted to a trusted venue or executor.
      if (!marketDiscoveryInflight.has(chain)) {
        const job = (async () => {
          const controller = new AbortController();
          const timeout = setTimeout(()=>controller.abort(),7000);
          try {
            const discovery = await fetchPublishedPairsDetailed(chain,{signal:controller.signal});
            const data = {...discoverPublishedSpreads(discovery.pairs,chain),
              sourceCoverage:{requestedSeeds:discovery.requestedSeeds,
                successfulSeeds:discovery.successfulSeeds,
                failedSeeds:discovery.failedSeeds,
                complete:discovery.coverageComplete},
              incomplete:!discovery.coverageComplete};
            marketDiscoveryCache.set(chain,{at:Date.now(),data});
            return data;
          } finally {clearTimeout(timeout);}
        })();
        marketDiscoveryInflight.set(chain,job);
        job.finally(() => {
          if (marketDiscoveryInflight.get(chain) === job) marketDiscoveryInflight.delete(chain);
        }).catch(()=>{}); // settle cleanup without an unhandled rejection
      }
      try {
        const data = await marketDiscoveryInflight.get(chain);
        return json(res,200,{...data,cacheAgeMs:0});
      } catch {
        return json(res,503,{mode:'DISCOVERY_ONLY',chain,
          error:'published market data unavailable',actionable:false});
      }
    }
    if (req.method === 'GET' && u.pathname === '/api/routes/intelligence') {
      const all = [...routeObservations.latest.values()].flatMap(x=>x.cycles);
      // Match the current per-network 2-hop dashboard slice, and the full
      // catalog 3-10-hop observations. All candidates stay non-executable.
      const twoHop = opportunities.filter(c=>!c.hopCount || c.hopCount===2);
      return json(res,200,rankRouteFamilies([...twoHop,...all],{
        minProfitUSD:settings.minProfitUSD,maxImpactBps:300,maxFamilies:30,
      }));
    }
    if (req.method === 'GET' && u.pathname === '/api/routes/ranked') {
      // Read-only ranking of the SAME latest opportunities as the dashboard.
      // It cannot add execution permissions or assert a profitable trade.
      return json(res,200,rankObservedRoutes(opportunities,{
        minProfitUSD:settings.minProfitUSD,maxImpactBps:300,limit:20}));
    }
    if (req.method === 'GET' && u.pathname === '/api/multihop/review') {
      // The newest observations are ranked independently of the legacy top-100
      // dashboard. Never turn a quote into a funded execution recommendation.
      const query=Object.fromEntries(u.searchParams);
      const source=routeObservations.cycles({...query,limit:'200',offset:'0'});
      const cutoff=query.minimumProfitUSD==null?settings.minProfitUSD:Number(query.minimumProfitUSD);
      const impact=query.maxImpactBps==null?300:Number(query.maxImpactBps);
      const reviewed=reviewObservedRoutes(source.cycles,{minProfitUSD:cutoff,maxImpactBps:impact});
      return json(res,200,{...reviewed,sourceTotal:source.total,considered:source.cycles.length,
        sourceTruncated:source.total>source.cycles.length});
    }
    if (req.method === 'GET' && u.pathname === '/api/multihop/sizes') {
      const result=routeObservations.cycles(Object.fromEntries(u.searchParams));
      return json(res, 200, {...result,cycles:undefined,sizeComparisons:compareRouteSizes(result.cycles)});
    }
    if (req.method === 'POST' && u.pathname.startsWith('/api/')) {
      if (!authorized(req)) return json(res, 403, {error: 'admin token required'});
      if (u.pathname === '/api/settings') {
        const next = applySettingsUpdate(settings, await body(req));
        if (next.liveChains.length && !LIVE) throw Error('LIVE_EXECUTION=false on the server: live networks cannot be enabled');
        persistSettings(next);
        log('settings', `Updated: maxLoan=$${next.maxLoanUSD} loan=$${next.loanSize} live=[${next.liveChains}] auto=${next.autoExecute} paused=${next.paused}`);
        return json(res, 200, {ok: true, settings});
      }
      if (u.pathname === '/api/scan') { if (busy) return json(res, 409, {error: 'scan running'}); cycle(); return json(res, 202, {started: true}); }
      if (u.pathname === '/api/emergency-stop') {
        const results = await executor.emergencyStop(nets.filter((n) => contracts[n.id]), 'dashboard emergency stop');
        log('error', `EMERGENCY STOP: ${JSON.stringify(results)}`);
        return json(res, 200, {ok: true, results});
      }
      if (u.pathname === '/api/resume') {
        journal.append({kind: 'reset_failures', reason: 'operator resume'});
        executor.resume();
        persistSettings({...settings, paused: false});
        log('settings', 'Resumed by operator (on-chain unpause, if needed, requires the owner wallet)');
        return json(res, 200, {ok: true});
      }
      if (u.pathname === '/api/execute') {
        const {candidateId} = await body(req);
        const c = opportunities.find((x) => x.id === candidateId);
        if (!c) return json(res, 404, {error: 'candidate not found or expired'});
        return json(res, 200, await executor.attempt(c, nets.find((n) => n.id === c.chainId)));
      }
    }
    if (u.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"});
      return res.end(fs.readFileSync(path.join(root, 'public', 'index.html')));
    }
    return json(res, 404, {error: 'not found'});
  } catch (e) {
    return json(res, 400, {error: String(e.message || e).slice(0, 500)});
  }
});

let timer;
server.listen(PORT, BIND_HOST, () => {
  log('info', `NEXORA v1.2 on ${BIND_HOST}:${PORT} | live=${LIVE} | gate=${globalGateBlockers(gateReport).length ? 'LOCKED' : 'passed'} | journal pending=${journal.pending().length}`);
  cycle();
  timer = setInterval(cycle, INTERVAL_MS);
});

async function shutdown(sig) {
  log('info', `${sig}: shutting down (pending transactions are recovered from the journal on restart)`);
  clearInterval(timer);
  server.close();
  const until = Date.now() + 30000;
  while ((executor.busy || busy) && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
  for (const c of chains.values()) c.destroy?.();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

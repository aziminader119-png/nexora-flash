// Minimal DOM shim: run the dashboard script against a realistic /api/status payload and check rendered output.
import test from 'node:test';
import fs from 'node:fs';
const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const src = html.match(/<script>([\s\S]*)<\/script>/)[1];
test('dashboard renders status safely (DOM shim)', async () => {
const els = {};
const el = (id) => (els[id] ||= {id, value: '', checked: false, innerHTML: '', textContent: '', className: '', dataset: {}, classList: {toggle() {}}, addEventListener() {}, querySelectorAll: () => [], set onclick(f) {}, max: 0});
const status = {version: '1.0.0', mode: 'SCAN_ONLY', liveExecutionEnabled: false, signer: null, contracts: {}, loanCeiling: 10000,
  gate: {passed: false, blockers: ['no validation report (run: npm run validate)'], generatedAt: null, codehash: null},
  networks: [{chainId: 8453, name: 'Base', status: 'quotes-live', block: 123, gasGwei: 0.005, providers: [{kind: 'AAVE_V3', ok: true}], liveBlockers: ['LIVE_EXECUTION is not enabled']}],
  registry: [{id: 8453, name: 'Base'}], scans: 1, busy: false, lastScan: new Date().toISOString(), settings: {maxLoanUSD: 1000, loanSize: 1000, sizeSteps: [0.5, 1], minProfitUSD: 3, slippageBps: 30, maxGasGwei: 5, maxGasUnits: 1200000, maxGasPerTxUSD: 1, maxDailyGasUSD: 5, maxQuoteAgeMs: 6000, maxConsecutiveFailures: 3, enabledChains: [8453], liveChains: [], autoExecute: false, paused: false},
  opportunities: [{id: 'x<script>', network: 'Base', block: 123, buy: 'Uniswap V2', sell: 'Uniswap V3 0.05%', provider: {kind: 'MORPHO_BLUE'}, size: 1000, gross: 5, flashFee: 0, gasCost: 0.01, netEstimate: 4.99, executable: true, blockers: []}],
  trades: [], pending: [], attempts: [], gasSpentTodayUSD: 0, consecutiveFailures: 0, logs: [{at: new Date().toISOString(), level: 'info', message: '<b>hi</b>'}], configWritable: true};
globalThis.document = {getElementById: el, querySelectorAll: () => []};
globalThis.fetch = async () => ({ok: true, json: async () => status, text: async () => ''});
globalThis.setInterval = () => 0;
globalThis.confirm = () => false;
new Function(src)();
await new Promise((r) => setTimeout(r, 50));
const must = [['opps', 'Uniswap V2 → Uniswap V3 0.05%'], ['opps', 'data-exec="x&lt;script&gt;"'], ['logs', '&lt;b&gt;hi&lt;/b&gt;'], ['gate', 'Live execution locked'], ['networks', 'quote-only']];
for (const [id, s] of must) { const v = els[id].innerHTML || els[id].textContent; if (!v.includes(s)) throw Error(`dashboard ${id} missing ${s}: ${v.slice(0, 200)}`); }
if (els.maxLoanUSD.value !== 1000) throw Error('max loan field not populated from settings');
});

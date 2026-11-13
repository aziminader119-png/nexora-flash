// Operator settings: validation and defaults. Amounts are in stablecoin units (USDC/USDT ~ USD).
import {NETWORK_IDS} from './networks.mjs';

export const INITIAL_MAX_LOAN = 1000;
const ABS_CEILING = 1_000_000;

/** Server-side ceiling the dashboard can never exceed (set in /etc/nexora/nexora.env). */
export function loanCeiling(env = process.env) {
  const v = Number(env.NEXORA_LOAN_CEILING || 10000);
  return Number.isFinite(v) && v > 0 ? Math.min(v, ABS_CEILING) : 10000;
}

export const DEFAULT_SETTINGS = Object.freeze({
  maxLoanUSD: INITIAL_MAX_LOAN,
  loanSize: INITIAL_MAX_LOAN,
  sizeSteps: [0.5, 1],
  minProfitUSD: 3,
  slippageBps: 30,
  maxGasGwei: 5,
  maxGasUnits: 1_200_000,
  maxGasPerTxUSD: 1,
  maxDailyGasUSD: 5,
  maxQuoteAgeMs: 6000,
  maxConsecutiveFailures: 3,
  enabledChains: [...NETWORK_IDS],
  liveChains: [],
  autoExecute: false,
  paused: false,
});

const KEYS = Object.keys(DEFAULT_SETTINGS);
const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const chainList = (v) => Array.isArray(v) && new Set(v).size === v.length && v.every((id) => NETWORK_IDS.includes(id));

export function settingsErrors(s, env = process.env) {
  const e = [];
  if (!s || typeof s !== 'object' || Array.isArray(s)) return ['settings must be an object'];
  const ceiling = loanCeiling(env);
  if (!num(s.maxLoanUSD, 10, ceiling)) e.push(`maxLoanUSD must be 10..${ceiling}`);
  if (!num(s.loanSize, 10, ceiling) || s.loanSize > s.maxLoanUSD) e.push('loanSize must be >= 10 and <= maxLoanUSD');
  if (!Array.isArray(s.sizeSteps) || s.sizeSteps.length < 1 || s.sizeSteps.length > 4 || !s.sizeSteps.every((x) => num(x, 0.05, 1))) e.push('sizeSteps must be 1-4 fractions in 0.05..1');
  if (!num(s.minProfitUSD, 0.01, 100000)) e.push('minProfitUSD must be > 0');
  if (!int(s.slippageBps, 0, 200)) e.push('slippageBps must be an integer 0..200');
  if (!num(s.maxGasGwei, 0.0001, 500)) e.push('maxGasGwei must be 0.0001..500');
  if (!int(s.maxGasUnits, 200_000, 5_000_000)) e.push('maxGasUnits must be 200000..5000000');
  if (!num(s.maxGasPerTxUSD, 0.001, 100)) e.push('maxGasPerTxUSD must be 0.001..100');
  if (!num(s.maxDailyGasUSD, 0, 1000)) e.push('maxDailyGasUSD must be 0..1000');
  if (!int(s.maxQuoteAgeMs, 500, 60000)) e.push('maxQuoteAgeMs must be 500..60000');
  if (!int(s.maxConsecutiveFailures, 1, 20)) e.push('maxConsecutiveFailures must be 1..20');
  if (!chainList(s.enabledChains) || s.enabledChains.length === 0) e.push('enabledChains must be a non-empty list of supported chain ids');
  if (!chainList(s.liveChains) || !s.liveChains.every((id) => s.enabledChains?.includes(id))) e.push('liveChains must be a subset of enabledChains');
  if (typeof s.autoExecute !== 'boolean') e.push('autoExecute must be boolean');
  if (typeof s.paused !== 'boolean') e.push('paused must be boolean');
  return e;
}

export const validateSettings = (s, env) => settingsErrors(s, env).length === 0;

/** Accept a partial update from the dashboard; unknown keys (e.g. a pasted private key) are rejected. */
export function applySettingsUpdate(current, raw, env = process.env) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Invalid settings payload');
  const unknown = Object.keys(raw).filter((k) => !KEYS.includes(k));
  if (unknown.length) throw Error(`Unknown setting: ${unknown.join(', ')}`);
  const next = structuredClone({...current, ...raw});
  const errors = settingsErrors(next, env);
  if (errors.length) throw Error(errors.join('; '));
  return next;
}

/** Load persisted settings, dropping unknown/legacy keys and falling back to defaults when invalid. */
export function loadSettings(raw, env = process.env) {
  const merged = {...structuredClone(DEFAULT_SETTINGS)};
  if (raw && typeof raw === 'object') for (const k of KEYS) if (k in raw) merged[k] = raw[k];
  // v0.9 migration: enabledChains could include monitor-only ids
  if (Array.isArray(merged.enabledChains)) merged.enabledChains = merged.enabledChains.filter((id) => NETWORK_IDS.includes(id));
  if (Array.isArray(merged.liveChains)) merged.liveChains = merged.liveChains.filter((id) => merged.enabledChains.includes(id));
  if (merged.loanSize > merged.maxLoanUSD) merged.loanSize = merged.maxLoanUSD;
  return validateSettings(merged, env) ? merged : structuredClone(DEFAULT_SETTINGS);
}

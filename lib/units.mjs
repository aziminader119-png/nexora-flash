// Exact decimal <-> integer conversion without floating point (no ethers dependency, unit-testable offline).
export function parseUnits(value, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) throw Error('Invalid decimals');
  const s = typeof value === 'number' ? numberToPlain(value) : String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw Error(`Invalid decimal amount: ${s}`);
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals && /[1-9]/.test(frac.slice(decimals))) throw Error('Too many decimal places');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

function numberToPlain(n) {
  if (!Number.isFinite(n) || n < 0) throw Error('Invalid amount');
  const s = n.toString();
  if (!/e/i.test(s)) return s;
  return n.toFixed(20).replace(/\.?0+$/, '');
}

export function formatUnits(value, decimals) {
  const v = BigInt(value);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = a / base;
  const frac = (a % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

/** Display-only conversion. Never use the result for on-chain amounts. */
export function toFloat(value, decimals) {
  return Number(formatUnits(value, decimals));
}

export const mulDivUp = (a, b, d) => (a * b + d - 1n) / d;
export const bpsOf = (amount, bps) => amount * BigInt(bps) / 10000n;

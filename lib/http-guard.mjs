// Guard localhost dashboard against DNS rebinding.
export function allowedHosts(env = process.env) {
  const extra = String(env.DASHBOARD_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  return new Set(['localhost', '127.0.0.1', '[::1]', ...extra]);
}
export function hostName(hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase();
  if (!h) return null;
  const m = h.match(/^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/);
  return m ? m[1] : null;
}
export function hostAllowed(hostHeader, env = process.env) {
  const h = hostName(hostHeader);
  return h != null && allowedHosts(env).has(h);
}

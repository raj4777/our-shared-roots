// Shared Firebase authDomain override for *.web.app hosts.
export function applyHostingAuthDomain(config, hostname) {
  if (!config || typeof config !== 'object') return config;
  const host = String(hostname || (typeof location !== 'undefined' && location.hostname) || '');
  if (host.endsWith('.web.app')) {
    return Object.assign({}, config, { authDomain: host });
  }
  return config;
}

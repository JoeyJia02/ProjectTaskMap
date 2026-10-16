export function parsePublicRuntime(value) {
  if (!value || value.provider !== 'tailscale' || typeof value.origin !== 'string' || value.port !== 3002) {
    throw new Error('Invalid fixed-entry configuration.');
  }
  const url = new URL(value.origin);
  if (url.origin !== value.origin || url.protocol !== 'https:' || url.port || url.pathname !== '/' || url.search || url.hash
    || url.username || url.password || !/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(url.hostname)) {
    throw new Error('Fixed entry must be an exact Tailscale HTTPS origin.');
  }
  return { provider: 'tailscale', origin: value.origin, port: 3002 };
}

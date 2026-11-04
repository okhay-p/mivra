const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

const isLoopbackAddress = (address: string | undefined) => {
  if (!address) return false;
  const v4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  return address === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
};

/**
 * Dev only. The Vite proxy connects to the server from loopback and, with changeOrigin, rewrites Host to
 * loopback too, which would make every proxied request look local to the server. So it says where a request
 * really came from: a non-loopback peer (Vite bound beyond loopback with MIVRA_DEV_HOST) or a non-loopback
 * Host (a proxy such as `tailscale serve`) is forwarded, and the server won't let it change API keys (ADR-013).
 */
export function forwardingHeaders(host: string | undefined, remoteAddress: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!isLoopbackAddress(remoteAddress)) headers["x-forwarded-for"] = remoteAddress ?? "unknown";
  const hostname = (host ?? "").replace(/:\d+$/, "").toLowerCase();
  if (!LOOPBACK_HOSTS.includes(hostname)) headers["x-forwarded-host"] = host ?? "unknown";
  return headers;
}

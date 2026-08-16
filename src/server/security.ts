import dns from "node:dns/promises";
import net from "node:net";

const resolvedHostCache = new Map<string, Promise<void>>();

export class UnsafeUrlError extends Error {
  readonly code = "UNSAFE_URL";
}

export async function assertSafePublicUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError("网址格式无效");
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new UnsafeUrlError("只允许 http 或 https 网址");
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError("网址不能包含用户名或密码");
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname) throw new UnsafeUrlError("网址缺少域名");

  if (process.env.ALLOW_PRIVATE_URLS === "1") return url;

  const cached = resolvedHostCache.get(hostname);
  if (cached) {
    await cached;
    return url;
  }

  const validation = validateHost(hostname);
  resolvedHostCache.set(hostname, validation);
  try {
    await validation;
  } catch (error) {
    resolvedHostCache.delete(hostname);
    throw error;
  }
  return url;
}

async function validateHost(hostname: string): Promise<void> {
  if (hostname === "localhost" || hostname.endsWith(".localhost") || isPrivateAddress(hostname)) {
    throw new UnsafeUrlError("不允许访问本机、私网或保留地址");
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new UnsafeUrlError("域名无法解析");
  }
  if (addresses.length === 0) throw new UnsafeUrlError("域名没有可用地址");
  if (addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new UnsafeUrlError("域名解析到了本机、私网或保留地址");
  }
}

export function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0] ?? address.toLowerCase();
  const family = net.isIP(normalized);

  if (family === 4) {
    const parts = normalized.split(".").map(Number);
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    const c = parts[2] ?? 0;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    if (a >= 224) return true;
    return false;
  }

  if (family === 6) {
    if (normalized === "::" || normalized === "::1") return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
    if (/^fe[89ab]/.test(normalized)) return true;
    if (normalized.startsWith("ff")) return true;
    const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateAddress(mapped[1] ?? "") : false;
  }

  return false;
}

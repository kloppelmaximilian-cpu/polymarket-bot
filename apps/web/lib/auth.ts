/**
 * Optional HTTP basic auth for the dashboard (WEB_BASIC_AUTH_USER / _PASSWORD).
 * Checked in proxy.ts for every request and again inside every Server Action.
 */
export function basicAuthEnabled(): boolean {
  return !!process.env.WEB_BASIC_AUTH_USER && !!process.env.WEB_BASIC_AUTH_PASSWORD;
}

function safeEqual(a: string, b: string): boolean {
  // Constant-time for equal lengths; the length itself is not secret enough to matter here.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function basicAuthOk(header: string | null | undefined): boolean {
  if (!basicAuthEnabled()) return true;
  if (!header?.startsWith('Basic ')) return false;
  let decoded: string;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return false;
  }
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  return safeEqual(decoded.slice(0, i), process.env.WEB_BASIC_AUTH_USER!) && safeEqual(decoded.slice(i + 1), process.env.WEB_BASIC_AUTH_PASSWORD!);
}

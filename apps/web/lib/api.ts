import 'server-only';
import { connection } from 'next/server';

/** Where the dashboard's server reaches the API. The token never leaves the server. */
const API_URL = (process.env.API_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 4000}`).replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function headers(json: boolean): HeadersInit {
  const h: Record<string, string> = { accept: 'application/json' };
  if (json) h['content-type'] = 'application/json';
  if (process.env.API_TOKEN) h.authorization = `Bearer ${process.env.API_TOKEN}`;
  return h;
}

async function parse<T>(res: Response, path: string): Promise<T> {
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'HTTP', err?.message ?? `${path} failed with HTTP ${res.status}`);
  }
  return body as T;
}

/** GET from the API at request time (never cached: this is an operational dashboard). */
export async function apiGet<T>(path: string, query?: Record<string, string | number | boolean | undefined | null>): Promise<T> {
  await connection();
  const qs = query
    ? Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&')
    : '';
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}${qs ? `?${qs}` : ''}`, { headers: headers(false), cache: 'no-store' });
  } catch {
    throw new ApiError(503, 'API_UNREACHABLE', `The API at ${API_URL} is not reachable. Start it with "pnpm dev" (or "pnpm dev:embedded").`);
  }
  return parse<T>(res, path);
}

export async function apiSend<T>(method: 'POST' | 'PUT', path: string, body: unknown = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { method, headers: headers(true), body: JSON.stringify(body), cache: 'no-store' });
  } catch {
    throw new ApiError(503, 'API_UNREACHABLE', `The API at ${API_URL} is not reachable.`);
  }
  return parse<T>(res, path);
}

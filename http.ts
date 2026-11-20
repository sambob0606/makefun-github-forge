// The small HTTP plumbing shared by every surface: request shape, JSON replies,
// the X-GitHub-Request-Id header every REST reply carries, and pagination links.

export interface Req {
  readonly method: string;
  readonly url: URL;
  readonly pathname: string;
  /** Path segments, percent-decoded, without empty parts. */
  readonly segments: string[];
  readonly headers: Headers;
  readonly body: Buffer;
  /** The login the bearer token names (the scenario viewer, or the token itself when login-shaped). */
  readonly viewer: string;
  /** The body parsed as JSON (null when empty). Set by the app layer; throws on malformed JSON. */
  readonly json: () => unknown;
}

export interface Res {
  readonly status: number;
  readonly body: string | Buffer;
  readonly contentType: string;
  readonly headers: Record<string, string>;
}

let requestCounter = 0;

export function requestId(): string {
  requestCounter += 1;
  return `${Date.now().toString(36)}-${requestCounter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function jsonRes(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Res {
  return {
    status,
    body: JSON.stringify(body),
    contentType: 'application/json',
    headers: { 'X-GitHub-Request-Id': requestId(), ...extraHeaders },
  };
}

export function jsonError(status: number, message: string): Res {
  return jsonRes(status, { message });
}

export function textRes(status: number, body: string, contentType = 'text/plain'): Res {
  return { status, body, contentType, headers: {} };
}

export function binaryRes(status: number, body: Buffer, contentType: string): Res {
  return { status, body, contentType, headers: {} };
}

/** A paginated slice plus the Link header for the next page, if there is one. */
export function paginate<T>(items: readonly T[], url: URL): { page: T[]; linkHeader: string | null } {
  const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let linkHeader: string | null = null;
  const links: string[] = [];
  const origin = url.origin;
  const path = url.pathname;
  const build = (targetPage: number): string => {
    const params = new URLSearchParams(url.searchParams);
    params.set('page', String(targetPage));
    params.set('per_page', String(perPage));
    return `${origin}${path}?${params.toString()}`;
  };
  if (start + perPage < items.length) links.push(`<${build(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${build(page - 1)}>; rel="prev"`);
  if (items.length > perPage) links.push(`<${build(Math.ceil(items.length / perPage))}>; rel="last"`);
  if (links.length > 0) linkHeader = links.join(', ');
  return { page: slice, linkHeader };
}

/** The JSON body of a request, or null for an empty body. Throws on malformed JSON. */
export function parseJsonBody(body: Buffer): unknown {
  if (body.length === 0) return null;
  const text = body.toString('utf8').trim();
  if (text === '') return null;
  return JSON.parse(text);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stringField(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  return typeof value === 'string' ? value : undefined;
}

export function boolField(body: Record<string, unknown>, name: string): boolean | undefined {
  const value = body[name];
  return typeof value === 'boolean' ? value : undefined;
}

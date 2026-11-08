interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
  socket?: { encrypted?: boolean };
  [key: string]: unknown;
}

interface HttpResponse {
  setHeader(name: string, value: string): unknown;
}

type Next = (error?: unknown) => void;

/**
 * The headers every API response carries (docs/runbooks/infra/tls-headers.md). The API answers JSON and problem documents only, so the content policy forbids everything:
 * a response that is opened as a page cannot load or run anything, be framed or post a form. A route that needs another value for one of them (a file download sets its own
 * `Cache-Control`) writes it later and wins, because this middleware runs first.
 */
export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-site',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

/** One year, subdomains included: the API is only offered over TLS. */
export const HSTS_VALUE = 'max-age=31536000; includeSubDomains';

const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/** Whether the request arrived over TLS: on the socket, or as the edge proxy says (the proxy always terminates TLS in the on-prem deployment). */
function overTls(request: HttpRequest): boolean {
  if (request.socket?.encrypted === true) return true;
  return first(request.headers['x-forwarded-proto'])?.split(',')[0]?.trim().toLowerCase() === 'https';
}

/** Express middleware, early in the chain: sets the security headers on every response, and HSTS when the request came over TLS. */
export function securityHeaders() {
  return (request: HttpRequest, response: HttpResponse, next: Next): void => {
    for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) response.setHeader(name, value);
    if (overTls(request)) response.setHeader('strict-transport-security', HSTS_VALUE);
    next();
  };
}

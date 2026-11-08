import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { API_SECURITY_HEADERS, HSTS_VALUE, securityHeaders } from './security-headers';

describe('the security headers of the API (docs/runbooks/infra/tls-headers.md)', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const middleware = securityHeaders();
    server = createServer((request, response) => {
      middleware(request as never, response, () => {
        // A route that sets its own Cache-Control later (a download) wins over the default.
        if (request.url === '/download') response.setHeader('cache-control', 'private, max-age=60');
        response.setHeader('content-type', 'application/json');
        response.end('{}');
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  it('sends every header on a real response, and no HSTS over plain HTTP', async () => {
    const reply = await fetch(`${base}/`);
    for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) expect(reply.headers.get(name)).toBe(value);
    expect(reply.headers.get('strict-transport-security')).toBeNull();
  });

  it('sends HSTS when the edge proxy says the request came over HTTPS', async () => {
    const reply = await fetch(`${base}/`, { headers: { 'x-forwarded-proto': 'https' } });
    expect(reply.headers.get('strict-transport-security')).toBe(HSTS_VALUE);
    const plain = await fetch(`${base}/`, { headers: { 'x-forwarded-proto': 'http' } });
    expect(plain.headers.get('strict-transport-security')).toBeNull();
  });

  it('lets a route replace the default cache policy', async () => {
    const reply = await fetch(`${base}/download`);
    expect(reply.headers.get('cache-control')).toBe('private, max-age=60');
    expect(reply.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('forbids framing, forms and any content in the policy of a JSON response', () => {
    const policy = API_SECURITY_HEADERS['content-security-policy'] ?? '';
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain('unsafe-inline');
    expect(HSTS_VALUE).toMatch(/max-age=(\d+)/);
    expect(Number(/max-age=(\d+)/.exec(HSTS_VALUE)?.[1])).toBeGreaterThanOrEqual(31_536_000);
  });
});

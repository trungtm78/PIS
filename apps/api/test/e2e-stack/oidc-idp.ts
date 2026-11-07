import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { newKey, signJwt } from '../auth/oidc-test-provider';
import type { ProviderKey } from '../auth/oidc-test-provider';

/** A person the test identity provider can sign in: `key` is what a `login_hint` names. */
export interface IdpUser {
  key: string;
  subject: string;
  name: string;
}

export interface IdpOptions {
  users: readonly IdpUser[];
  clientId: string;
  /** Listening port; 0 picks a free one. */
  port?: number;
  /** The key of the person who signs in when the request names nobody (a native client sends no `login_hint`); the first user when it says nothing. */
  nextUser?: () => string | undefined;
}

interface IssuedCode {
  user: IdpUser;
  nonce: string;
  challenge: string;
  redirectUri: string;
  clientId: string;
  acr: 'aal1' | 'aal2';
}

/** What a refresh token stands for: the person, the client and the level of the sign-in, and the session id the identity tokens of it carry. */
interface IdpSession {
  user: IdpUser;
  clientId: string;
  acr: 'aal1' | 'aal2';
  sid: string;
}

const REALM = '/realms/machvon';
const OIDC = `${REALM}/protocol/openid-connect`;
const ID_TOKEN_SECONDS = 600;
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

/**
 * An identity provider for the browser end-to-end tests: realm discovery, a JWKS, the authorization endpoint (it
 * signs in the user named by `login_hint` at once: there is no login form) and the token endpoint, with the checks a
 * real provider makes that matter here: code flow with PKCE S256, one use of a code, the client and the redirect
 * address of the request. It answers cross-origin requests, because the web application lives on another origin.
 */
export class E2eIdentityProvider {
  readonly issuer: string;
  private readonly key: ProviderKey = newKey('RS256');
  private readonly codes = new Map<string, IssuedCode>();
  private readonly sessions = new Map<string, IdpSession>();

  private constructor(
    private readonly server: Server,
    private readonly options: IdpOptions,
    origin: string,
  ) {
    this.issuer = `${origin}${REALM}`;
  }

  static async start(options: IdpOptions): Promise<E2eIdentityProvider> {
    const holder: { idp?: E2eIdentityProvider } = {};
    const server = createServer((request, response) => {
      if (holder.idp === undefined) response.writeHead(503).end();
      else holder.idp.handle(request, response);
    });
    await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    holder.idp = new E2eIdentityProvider(server, options, `http://127.0.0.1:${port}`);
    return holder.idp;
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
      this.server.closeAllConnections();
    });
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? '/', this.issuer);
    if (request.method === 'OPTIONS') return void response.writeHead(204, CORS_HEADERS).end();
    if (request.method === 'GET' && url.pathname === `${REALM}/.well-known/openid-configuration`) {
      return this.json(response, 200, {
        issuer: this.issuer,
        jwks_uri: `${this.issuer}/protocol/openid-connect/certs`,
        authorization_endpoint: `${this.issuer}/protocol/openid-connect/auth`,
        token_endpoint: `${this.issuer}/protocol/openid-connect/token`,
      });
    }
    if (request.method === 'GET' && url.pathname === `${OIDC}/certs`) return this.json(response, 200, { keys: [this.key.publicJwk] });
    if (request.method === 'GET' && url.pathname === `${OIDC}/auth`) return this.authorize(url, response);
    if (request.method === 'POST' && url.pathname === `${OIDC}/token`) return void this.token(request, response);
    response.writeHead(404, CORS_HEADERS).end();
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { ...CORS_HEADERS, 'content-type': 'application/json' }).end(JSON.stringify(body));
  }

  private refuse(response: ServerResponse, error: string): void {
    this.json(response, 400, { error });
  }

  private authorize(url: URL, response: ServerResponse): void {
    const param = (name: string): string | null => url.searchParams.get(name);
    const challenge = param('code_challenge');
    const redirectUri = param('redirect_uri');
    const state = param('state');
    if (param('response_type') !== 'code' || param('client_id') !== this.options.clientId || param('code_challenge_method') !== 'S256' || challenge === null || redirectUri === null || state === null) {
      return this.refuse(response, 'invalid_request');
    }
    const user = this.options.users.find((candidate) => candidate.key === (param('login_hint') ?? this.options.nextUser?.() ?? this.options.users[0]?.key));
    if (user === undefined) return this.refuse(response, 'unknown_user');
    const code = randomUUID();
    this.codes.set(code, {
      user,
      nonce: param('nonce') ?? '',
      challenge,
      redirectUri,
      clientId: this.options.clientId,
      acr: (param('acr_values') ?? '').split(' ').includes('aal2') ? 'aal2' : 'aal1',
    });
    const back = new URL(redirectUri);
    back.searchParams.set('code', code);
    back.searchParams.set('state', state);
    response.writeHead(302, { location: back.toString(), ...CORS_HEADERS }).end();
  }

  private async token(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    const grant = form.get('grant_type');
    if (grant === 'refresh_token') return this.refresh(form, response);
    if (grant !== 'authorization_code') return this.refuse(response, 'unsupported_grant_type');
    // A code is burnt by its first use, whatever the outcome: a guessed verifier gets one try.
    const issued = this.codes.get(form.get('code') ?? '');
    this.codes.delete(form.get('code') ?? '');
    const verifier = form.get('code_verifier') ?? '';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    if (issued === undefined || form.get('client_id') !== issued.clientId || form.get('redirect_uri') !== issued.redirectUri || challenge !== issued.challenge) {
      return this.refuse(response, 'invalid_grant');
    }
    this.issue(response, { user: issued.user, clientId: issued.clientId, acr: issued.acr, sid: randomUUID() }, issued.nonce);
  }

  /** The refresh grant of a native client: the token is rotated, so the one that was used is dead and a second use of it is refused. */
  private refresh(form: URLSearchParams, response: ServerResponse): void {
    const token = form.get('refresh_token') ?? '';
    const session = this.sessions.get(token);
    this.sessions.delete(token);
    if (session === undefined || form.get('client_id') !== session.clientId) return this.refuse(response, 'invalid_grant');
    this.issue(response, session, null);
  }

  private issue(response: ServerResponse, session: IdpSession, nonce: string | null): void {
    const now = Math.floor(Date.now() / 1000);
    const idToken = signJwt(this.key, {
      iss: this.issuer,
      aud: session.clientId,
      sub: session.user.subject,
      sid: session.sid,
      name: session.user.name,
      email: `${session.user.key}@example.test`,
      ...(nonce === null ? {} : { nonce }),
      iat: now,
      auth_time: now,
      exp: now + ID_TOKEN_SECONDS,
      acr: session.acr,
      amr: session.acr === 'aal2' ? ['pwd', 'otp'] : ['pwd'],
    });
    const refreshToken = randomUUID();
    this.sessions.set(refreshToken, session);
    this.json(response, 200, { id_token: idToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: ID_TOKEN_SECONDS });
  }
}

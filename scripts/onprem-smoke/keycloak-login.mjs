// The sign-in of a test person at the login pages of Keycloak, without a browser: the forms are read from the pages and posted back, cookies kept, the one-time password
// enrolled at the first sign-in (the realm makes it a required action) and entered at the later ones. Used by the on-prem smoke run only (scripts/onprem-smoke/verify.mjs):
// it proves that the realm that was imported signs a person in through the edge and sends the browser back with an authorization code.
import { createHmac } from 'node:crypto';

const MAX_STEPS = 12;
const TOTP_STEP_SECONDS = 30;

/** RFC 6238 with the settings of the realm: HMAC-SHA1, six digits, thirty seconds. */
export function totp(secret, timeMs = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 1000 / TOTP_STEP_SECONDS)));
  const digest = createHmac('sha1', secret).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const number = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(number % 1_000_000).padStart(6, '0');
}

const decode = (text) => text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const attribute = (tag, name) => {
  const found = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return found === null ? undefined : decode(found[2] ?? found[3] ?? '');
};

/** The forms of a page: the address each posts to and the name and value of its inputs. */
export function formsOf(html) {
  return [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].map(([, attributes, body]) => ({
    id: attribute(attributes, 'id') ?? '',
    action: attribute(attributes, 'action') ?? '',
    inputs: Object.fromEntries([...body.matchAll(/<input\b[^>]*>/gi)].map(([tag]) => [attribute(tag, 'name') ?? '', attribute(tag, 'value') ?? '']).filter(([name]) => name !== '')),
  }));
}

/** What a page says to the person, for the message of a failure: the title and any feedback text, tags removed. */
export function pageSummary(html) {
  const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
  const feedback = [...html.matchAll(/(?:kc-feedback-text|input-error|pf-m-error|alert-error|instruction)[^>]*>([\s\S]{0,400}?)<\//gi)].map((match) => match[1]);
  return decode([title, ...feedback].join(' | ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 400);
}

/**
 * Signs `username` in, starting at the authorization request `authUrl`, and returns the address the identity provider sends the browser back to (it starts with
 * `redirectUri` and carries the code). `secrets` keeps the one-time password secret of each person between sign-ins (and the last counter used: a code is accepted once).
 */
export async function signIn({ authUrl, redirectUri, username, password, secrets, fetch = globalThis.fetch, log = () => {}, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) }) {
  const jar = new Map();
  const request = async (url, form) => {
    const headers = { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '), accept: 'text/html' };
    if (form !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
    const response = await fetch(url, { method: form === undefined ? 'GET' : 'POST', redirect: 'manual', headers, ...(form === undefined ? {} : { body: new URLSearchParams(form).toString() }) });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const at = pair.indexOf('=');
      if (/max-age=0\b|expires=Thu, 01[ -]Jan[ -]1970/i.test(cookie)) jar.delete(pair.slice(0, at).trim());
      else jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
    return response;
  };
  const code = async () => {
    const entry = secrets[username];
    for (;;) {
      const counter = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
      if (entry.lastCounter !== counter) {
        entry.lastCounter = counter;
        return totp(entry.secret);
      }
      await sleep(1000);
    }
  };

  let response = await request(authUrl);
  let current = authUrl;
  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (response.status >= 300 && response.status < 400) {
      const location = new URL(response.headers.get('location') ?? '', current).toString();
      if (location.startsWith(redirectUri)) return location;
      log(`redirect to ${location.split('?')[0]}`);
      current = location;
      response = await request(location);
      continue;
    }
    const html = await response.text();
    if (response.status !== 200) throw new Error(`the identity provider answered ${response.status} at ${current.split('?')[0]}: ${pageSummary(html)}`);
    const forms = formsOf(html);
    const credentials = forms.find((form) => 'username' in form.inputs && 'password' in form.inputs);
    const enrolment = forms.find((form) => 'totpSecret' in form.inputs);
    const oneTime = forms.find((form) => 'otp' in form.inputs);
    if (credentials !== undefined) {
      if (step > 1) throw new Error(`the sign-in form came back: ${pageSummary(html)}`);
      log(`page: user name and password (${credentials.id}; fields ${Object.keys(credentials.inputs).join(',')}; cookies ${[...jar.keys()].join(',')})`);
      current = credentials.action;
      response = await request(credentials.action, { ...credentials.inputs, username, password });
    } else if (enrolment !== undefined) {
      log(`page: enrolment of the one-time password (${enrolment.id})`);
      secrets[username] = { secret: enrolment.inputs.totpSecret, lastCounter: undefined };
      current = enrolment.action;
      response = await request(enrolment.action, { ...enrolment.inputs, totp: await code(), userLabel: 'smoke' });
    } else if (oneTime !== undefined) {
      if (secrets[username] === undefined) throw new Error('the one-time password is asked for but this run never enrolled one');
      log(`page: one-time password (${oneTime.id})`);
      current = oneTime.action;
      response = await request(oneTime.action, { ...oneTime.inputs, otp: await code() });
    } else {
      throw new Error(`a page this run does not know (forms: ${forms.map((form) => `${form.id}[${Object.keys(form.inputs).join(',')}]`).join(' ') || 'none'}): ${pageSummary(html)}`);
    }
  }
  throw new Error(`the sign-in did not end after ${MAX_STEPS} pages`);
}

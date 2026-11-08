/**
 * The client of the push endpoint of the platform (`POST /finance-feed/push`, channel API_PUSH) with a machine account: it asks for a token with the client credentials, keeps it until it is about to expire,
 * and sends a batch with the hash of the batch as the idempotency key. It uses the `fetch` of the runtime (given as `fetchImpl` so that a test sends nothing anywhere) and nothing else.
 *
 * What an answer means:
 *   2xx                       taken: the batch leaves the spool;
 *   401                       the token is asked for again once; still 401 is a refusal to try again later;
 *   409 FEED_*, 422, 400, 403 refused for good (the platform will not change its mind about this batch): the batch is set aside as rejected;
 *   503 FEED_API_UNAVAILABLE  the platform has no machine account or specification yet: try again later;
 *   429, other 5xx, a failure of the network or a timeout: try again later.
 */
export function createClient({ baseUrl, tokenUrl, clientId, clientSecret, fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = 30_000 }) {
  let cached = null;

  const send = async (url, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  const token = async (force = false) => {
    if (!force && cached !== null && cached.expiresAt - 30_000 > now()) return cached.value;
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
    const response = await send(tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    if (!response.ok) throw Object.assign(new Error(`token endpoint answered ${response.status}`), { retry: true, status: response.status });
    const json = await response.json();
    cached = { value: json.access_token, expiresAt: now() + (typeof json.expires_in === 'number' ? json.expires_in : 300) * 1000 };
    return cached.value;
  };

  const classify = async (response) => {
    let json = {};
    try {
      json = await response.json();
    } catch {
      json = {};
    }
    const code = typeof json.code === 'string' ? json.code : null;
    if (response.ok) return { ok: true, status: response.status, body: json };
    if (response.status === 503 || response.status === 429 || response.status >= 500) return { ok: false, retry: true, status: response.status, code };
    if (response.status === 401) return { ok: false, retry: true, status: 401, code, unauthorized: true };
    return { ok: false, retry: false, status: response.status, code };
  };

  return {
    /** Sends one batch. Never throws: the outcome says whether to try again. */
    async push(batch) {
      const attempt = async (force) => {
        const bearer = await token(force);
        const response = await send(`${baseUrl}/finance-feed/push`, {
          method: 'POST',
          headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', 'idempotency-key': `batch-${batch.hash}` },
          body: JSON.stringify({ kind: batch.kind, rows: batch.rows, mapping_version: batch.mapping_version }),
        });
        return classify(response);
      };
      try {
        let outcome = await attempt(false);
        if (outcome.unauthorized === true) outcome = await attempt(true);
        return outcome;
      } catch (error) {
        return { ok: false, retry: true, status: error.status ?? 0, code: error.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK', message: String(error.message ?? error) };
      }
    },

    /** Tells the platform the collector is alive; a failure is reported and never stops the collection. */
    async heartbeat(url, payload) {
      try {
        const bearer = await token(false);
        const response = await send(url, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
        return { ok: response.ok, status: response.status };
      } catch (error) {
        return { ok: false, status: 0, message: String(error.message ?? error) };
      }
    },
  };
}

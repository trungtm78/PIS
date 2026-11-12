/** A recorded request of the scripted fetch. */
export interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
  /** The body as it was handed to fetch (a FormData for an upload). */
  rawBody: unknown;
}

export type Scripted = Response | Error | ((call: RecordedCall) => Response | Error);

/** A fetch that answers from a script, one entry per request, and records every request it receives. */
export function scriptedFetch(script: Scripted[]): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const queue = [...script];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
      rawBody: init?.body,
    };
    calls.push(call);
    const next = queue.shift();
    if (next === undefined) throw new Error('the script ran out of responses');
    const answer = typeof next === 'function' ? next(call) : next;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { fetch: impl as typeof fetch, calls };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export function problem(status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): Response {
  const body = {
    type: `urn:machvon:error:${code}`,
    title: `error.${code}.title`,
    status,
    code,
    correlation_id: '00000000-0000-4000-8000-0000000000c0',
    ...extra,
  };
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/problem+json; charset=utf-8', ...headers } });
}

export const COMMAND_RESULT = { operation_id: '00000000-0000-4000-8000-0000000000a1', status: 'MOVED', resource_version: 8 };

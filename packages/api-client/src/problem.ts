/** The standard members of an RFC 9457 problem the server sends; everything else is an extension. */
const STANDARD_MEMBERS: ReadonlySet<string> = new Set(['type', 'title', 'status', 'code', 'detail', 'correlation_id']);

export const NETWORK_ERROR_CODE = 'NETWORK_ERROR';
const INTERNAL_ERROR_CODE = 'INTERNAL_ERROR';
const VALIDATION_FAILED_CODE = 'VALIDATION_FAILED';

// Nearest registered code per HTTP status when the answer carries no problem body (same table as the server filter).
const CODE_BY_STATUS: Readonly<Record<number, string>> = {
  401: 'SESSION_EXPIRED',
  403: 'SCOPE_DENIED',
  404: 'RESOURCE_NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMIT',
};

export interface ApiErrorInit {
  status: number;
  code: string;
  detail?: string;
  correlationId: string;
  extensions?: Record<string, unknown>;
  retryAfterSeconds?: number;
}

/**
 * A failed call. It carries the stable error code and the safe members of the problem answer; its message is the
 * code, never text from the server body, so nothing a gateway or an exception put in a response can reach the screen.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string | undefined;
  readonly correlationId: string;
  readonly extensions: Record<string, unknown>;
  readonly retryAfterSeconds: number | undefined;

  constructor(init: ApiErrorInit) {
    super(init.code);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.detail = init.detail;
    this.correlationId = init.correlationId;
    this.extensions = init.extensions ?? {};
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

function retryAfterOf(response: Response): number | undefined {
  const value = Number(response.headers.get('retry-after'));
  return response.headers.has('retry-after') && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function codeForStatus(status: number): string {
  if (status >= 500) return INTERNAL_ERROR_CODE;
  return CODE_BY_STATUS[status] ?? VALIDATION_FAILED_CODE;
}

async function problemBodyOf(response: Response): Promise<Record<string, unknown> | undefined> {
  if (!(response.headers.get('content-type') ?? '').includes('json')) return undefined;
  try {
    const body: unknown = await response.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body) && typeof (body as { code?: unknown }).code === 'string'
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Builds the ApiError of a non-success response; `fallbackCorrelationId` is the id the client sent. */
export async function errorFromResponse(response: Response, fallbackCorrelationId: string): Promise<ApiError> {
  const body = await problemBodyOf(response);
  const retryAfterSeconds = retryAfterOf(response);
  if (body === undefined) {
    return new ApiError({ status: response.status, code: codeForStatus(response.status), correlationId: response.headers.get('x-correlation-id') ?? fallbackCorrelationId, retryAfterSeconds });
  }
  const extensions = Object.fromEntries(Object.entries(body).filter(([name]) => !STANDARD_MEMBERS.has(name)));
  return new ApiError({
    status: response.status,
    code: body.code as string,
    detail: typeof body.detail === 'string' ? body.detail : undefined,
    correlationId: typeof body.correlation_id === 'string' ? body.correlation_id : (response.headers.get('x-correlation-id') ?? fallbackCorrelationId),
    extensions,
    retryAfterSeconds,
  });
}

/** The error of a request that never got an answer (offline, DNS, refused, aborted). */
export function networkError(correlationId: string): ApiError {
  return new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId });
}

/** The error of a success status whose body cannot be used (a gateway page, a truncated answer). */
export function unusableAnswer(status: number, correlationId: string): ApiError {
  return new ApiError({ status, code: INTERNAL_ERROR_CODE, correlationId });
}

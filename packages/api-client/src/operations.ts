import type { OPERATIONS, OperationName, operations } from '@machvon/contracts';
import type { CommandAttempt } from './idempotency.ts';

type Descriptor<K extends OperationName> = (typeof OPERATIONS)[K];

/** Operations that only read (GET). */
export type ReadOperation = { [K in OperationName]: Descriptor<K>['method'] extends 'get' ? K : never }[OperationName];

type Shape<K extends OperationName> = K extends keyof operations ? operations[K] : never;

// What the contract offers as the request body: undefined when the operation has none (requestBody?: never), otherwise its media types.
type RequestContent<K extends OperationName> = Shape<K> extends { requestBody?: infer R }
  ? [NonNullable<R>] extends [never]
    ? undefined
    : NonNullable<R> extends { content: infer C }
      ? C
      : undefined
  : undefined;
// The client sends JSON only: an operation whose body is offered but not as JSON (the multipart theme asset upload)
// is not a command: it is sent with `upload` (see `uploadFile`). An operation with no body is a command.
type NonJsonOnly<K extends OperationName> = [RequestContent<K>] extends [undefined] ? never : 'application/json' extends keyof RequestContent<K> ? never : K;
type NonJsonOperation = { [K in OperationName]: NonJsonOnly<K> }[OperationName];

/** Operations whose body is a `multipart/form-data` file (the theme logo): sent with `upload`, never with `command`. */
export type UploadOperation = { [K in OperationName]: 'multipart/form-data' extends keyof RequestContent<K> ? K : never }[OperationName];

/** Operations that change state with a JSON body: every other verb, each carrying the idempotency protocol. */
export type CommandOperation = Exclude<OperationName, ReadOperation | NonJsonOperation>;

type PathParams<K extends OperationName> = Shape<K> extends { parameters: { path: infer P } } ? P : never;
type QueryParams<K extends OperationName> = Shape<K> extends { parameters: { query?: infer Q } } ? NonNullable<Q> : never;
type BodyOf<K extends OperationName> = Shape<K> extends { requestBody: { content: { 'application/json': infer B } } } ? B : never;
type Responses<K extends OperationName> = Shape<K> extends { responses: infer R } ? R : never;
type SuccessStatus = 200 | 201 | 202 | 204;

/** The JSON body of the success answer of an operation (undefined when the answer has none). */
export type SuccessBody<K extends OperationName> = [SuccessStatus & keyof Responses<K>] extends [never]
  ? unknown
  : {
      [S in SuccessStatus & keyof Responses<K>]: Responses<K>[S] extends { content: { 'application/json': infer B } } ? B : undefined;
    }[SuccessStatus & keyof Responses<K>];

/** The items of a list answer. */
export type ItemsOf<B> = B extends { items?: Array<infer I> } ? I[] : never;

type PathPart<K extends OperationName> = [PathParams<K>] extends [never] ? { path?: undefined } : { path: PathParams<K> };
// A query the contract declares as a required member of `parameters` (some parameter has no default) is required here too.
type QueryRequired<K extends OperationName> = Shape<K> extends { parameters: { query: unknown } } ? true : false;
type QueryPart<K extends OperationName> = [QueryParams<K>] extends [never]
  ? { query?: undefined }
  : QueryRequired<K> extends true
    ? { query: QueryParams<K> }
    : { query?: QueryParams<K> };
type BodyPart<K extends OperationName> = [BodyOf<K>] extends [never] ? { body?: undefined } : { body: BodyOf<K> };
type VersionPart<K extends OperationName> = Descriptor<K>['versioned'] extends true ? { ifMatchVersion: number } : { ifMatchVersion?: undefined };

/** What a read takes: the path parameters the route has and the query (required when the contract requires a parameter). */
export type ReadInput<K extends ReadOperation> = PathPart<K> & QueryPart<K>;

/**
 * What a command takes. `ifMatchVersion` is required exactly for operations that declare an If-Match header,
 * `body` and `path` exactly when the route has them; `attempt` lets a retry of the same intention reuse its key.
 */
export type CommandInput<K extends CommandOperation> = PathPart<K> & BodyPart<K> & VersionPart<K> & { attempt?: CommandAttempt };

/** What an upload takes: the path parameters of the route, the prepared form and, for a retry of the same intention, its attempt. */
export type UploadInput<K extends UploadOperation> = PathPart<K> & { query?: [QueryParams<K>] extends [never] ? undefined : QueryParams<K>; form: FormData; attempt?: CommandAttempt };

/** Arguments of `read`: the input is optional when nothing in it is required. */
export type ReadArguments<K extends ReadOperation> = object extends ReadInput<K> ? [input?: ReadInput<K>] : [input: ReadInput<K>];

const PATH_PARAMETER = /\{([^{}/]+)\}/g;

/** Fills the `{name}` parameters of a route template; every value is encoded so it stays one path segment. */
export function fillPath(template: string, values: Record<string, unknown> | undefined): string {
  return template.replace(PATH_PARAMETER, (_match, name: string) => {
    const value = values?.[name];
    if (value === undefined || value === null) throw new Error(`missing path parameter ${name}`);
    return encodeURIComponent(String(value));
  });
}

/** The query string (with the leading `?`) of the defined values; arrays repeat the name. */
export function queryString(values: Record<string, unknown> | undefined): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(values ?? {})) {
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) search.append(name, String(item));
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}

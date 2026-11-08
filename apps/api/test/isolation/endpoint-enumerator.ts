import { listOperations } from '@machvon/contracts';
import type { OpenApiDocument } from '@machvon/contracts';
import type { OperationEntry } from '@machvon/contracts';

const PATH_PARAMETER = /\{[^{}/]+\}/;
const PATH_PARAMETERS = /\{[^{}/]+\}/g;

interface DeclaredParameter {
  name?: string;
  in?: string;
  schema?: { type?: string };
}

/**
 * Path parameters that name an entry of a registry of the platform, the same for every tenant, and not an object of a tenant: the code of a connector of the Integration Hub (HUB-1) is a descriptor that every tenant
 * has; a tenant reads and writes its own state, runs, rejects and mappings behind the code, through row-level security, so there is no object of another tenant to name in the path (the objects behind it have ids of
 * their own, and those operations have foreign-id cases). The code of a collector agent is not here: an agent belongs to the tenant that registered it.
 */
const PLATFORM_REGISTRY_PARAMETERS: ReadonlyArray<{ pathStart: string; name: string }> = [{ pathStart: '/integration-hub/connectors/', name: 'code' }];

/**
 * Whether a path parameter of the operation names an object that could belong to another tenant. A parameter the document declares as an integer is a calendar value, such as the
 * fiscal year of `/fiscal-years/{year}/close`, and not the id of an object; one that is not declared is taken for an id.
 */
function namesAnObject(entry: OperationEntry): boolean {
  const declared = (entry.operation.parameters ?? []) as DeclaredParameter[];
  return (entry.path.match(PATH_PARAMETERS) ?? []).some((placeholder) => {
    const name = placeholder.slice(1, -1);
    if (PLATFORM_REGISTRY_PARAMETERS.some((registry) => entry.path.startsWith(registry.pathStart) && registry.name === name)) return false;
    return declared.find((parameter) => parameter.in === 'path' && parameter.name === name)?.schema?.type !== 'integer';
  });
}

/**
 * Returns the sorted operationIds of the implemented operations whose path has a path parameter that names an object.
 * Each of them needs a foreign-id case in the isolation suite. An implemented operation that the
 * document does not define is a defect and throws.
 */
export function enumerateIdBearingOperations(doc: OpenApiDocument, implemented: ReadonlySet<string>): string[] {
  const entries = listOperations(doc);
  const known = new Set(entries.map((entry) => entry.id));
  for (const id of implemented) {
    if (!known.has(id)) throw new Error(`Implemented operation ${id} is not defined in the OpenAPI document`);
  }
  return entries
    .filter((entry) => implemented.has(entry.id) && PATH_PARAMETER.test(entry.path) && namesAnObject(entry))
    .map((entry) => entry.id)
    .sort();
}

/** The path template of an operation, for example `/resources/organization_unit/{id}`. */
export function operationPath(doc: OpenApiDocument, operationId: string): string {
  const entry = listOperations(doc).find((candidate) => candidate.id === operationId);
  if (entry === undefined) throw new Error(`Operation ${operationId} is not defined in the OpenAPI document`);
  return entry.path;
}

/**
 * Fills the path parameters of a template with an id. A template with more than one parameter names the others in `named` (by their name in the braces);
 * every parameter that is not named there takes the id.
 */
export function fillPath(template: string, id: string, named: Readonly<Record<string, string>> = {}): string {
  return template.replace(PATH_PARAMETERS, (placeholder) => encodeURIComponent(named[placeholder.slice(1, -1)] ?? id));
}

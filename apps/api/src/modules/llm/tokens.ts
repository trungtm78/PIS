/** Injection token of the admin port of LiteLLM (ST-LLM-002); the adapter that talks to the real service replaces the stand-in where the service is deployed. */
export const LLM_ADMIN = Symbol('LLM_ADMIN');
/** Injection token of the vault the secrets of the virtual keys are written to. */
export const LLM_VAULT = Symbol('LLM_VAULT');

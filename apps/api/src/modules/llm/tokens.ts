/** Injection token of the admin port of LiteLLM (ST-LLM-002); the adapter that talks to the real service replaces the stand-in where the service is deployed. */
export const LLM_ADMIN = Symbol('LLM_ADMIN');
/** Injection token of the vault the secrets of the virtual keys are written to. */
export const LLM_VAULT = Symbol('LLM_VAULT');
/** Injection token of the runner of evaluations (ST-LLM-004): the adapter that runs the cases through the model a route reaches replaces the stand-in when the gateway exists. */
export const LLM_EVAL_RUNNER = Symbol('LLM_EVAL_RUNNER');
/** Injection token of the port to the models (ST-LLM-005): the adapter that goes through LiteLLM with the virtual key of the tenant replaces the stand-in where the service is deployed. */
export const LLM_GATEWAY = Symbol('LLM_GATEWAY');
/** Injection token of the metrics sink of the gateway; the no-op sink is used when none is bound. */
export const LLM_METRICS = Symbol('LLM_METRICS');

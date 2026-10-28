# Providers, models and the classification policy (ST-LLM-001)

Module document: `Design/MACHVON_Design/01_Documents/05_modules/LLM.md` (F2, BR-LLM-01). Tables `ai_provider`, `ai_model`, `ai_classification_policy_version` (baseline, V002) with the guards of `V1140`. Operations: `registerAiProvider`, `activateAiProvider`, `registerAiModel`, `createAiClassificationPolicy`, `publishAiClassificationPolicy`, and the reads `listAiProviders`, `listAiModels`, `listAiClassificationPolicies` (added to the contract; permissions `llm.provider.read` and `llm.policy.read`). Screens LLM-02 (providers), LLM-03 (models) and LLM-19 (the matrix). Pure rules: `packages/kernel/src/llm-registry.ts`; store: `packages/db/src/llm-registry-store.ts`; controller: `apps/api/src/modules/llm/registry.controller.ts`.

## What the registry protects

Data of a tenant goes to an AI model only along a route its class of data may take (BR-LLM-01). The registry is where that is decided, and it is decided so that a mistake of one person cannot open a route:

| Class | Domestic service | Self-hosted | International |
|---|---|---|---|
| Public | yes | yes | only with D07 and the tenant's policy |
| Internal | yes | yes | never |
| Confidential | yes (the provider needs its data agreement) | yes | never |
| Personal | yes | yes | never |
| Important / core | never | yes | never |

- **Providers.** A provider has a route (`DOMESTIC_HOSTED`, `SELF_HOSTED`, `INTERNATIONAL`), the country of its servers and the highest class of data it may be sent. An international provider takes `PUBLIC` only (`422 INTERNATIONAL_CLASSIFICATION_NOT_ALLOWED`); every other route is in Viet Nam (`ai_provider_vn_chk`). It is registered `PROPOSED`, and a provider that is not `ACTIVE` receives nothing.
- **Activation** (`activateAiProvider`, with `If-Match`): an international provider needs the approval reference of D07 (`422 D07_APPROVAL_REQUIRED`, the provider stays `PROPOSED`); one that takes more than public data needs its data agreement (`422 DATA_AGREEMENT_REQUIRED`); and the person who registered it cannot activate it (`403 SELF_APPROVAL_DENIED`). The conditions on the request are judged before the person, so that the missing paper is told first. `ai_provider_intl_chk` says the same to a write that skips the service.
- **Models.** A model is `PROPOSED` and takes no more than its provider (`422 CLASSIFICATION_ABOVE_PROVIDER`); the same model and version of a provider is registered once (`409 MODEL_DUPLICATE`, also when it has no version: `ai_model_unversioned_uq`). Making it `APPROVED` belongs to the evaluation of ST-LLM-004.
- **The matrix.** A policy is drafted (`createAiClassificationPolicy`) by one person and published (`publishAiClassificationPolicy`, with `If-Match`) by another. The draft is kept if it is a matrix (known classes, known routes, each once: `422 POLICY_MATRIX_INVALID`) and, when it turns the international route on, carries the D07 reference (`422 D07_APPROVAL_REQUIRED`); a matrix that names the international route while it is off is invalid. **Publishing** refuses a policy that is wider than the baseline, or that leaves out a line the baseline fixes: a class with no line, the international route for anything above public data, or the line of important data, which is only the self-hosted route (`422 POLICY_WEAKENS_BASELINE`, naming the classes). Stricter than the baseline is allowed. Then the author is refused (`403 SELF_APPROVAL_DENIED`), and a policy whose date has not come is not published (`422 VALIDATION_FAILED` on `effective_from`). The policy that was `PUBLISHED` becomes `SUPERSEDED` in the same transaction, so exactly one stays (`ai_classification_policy_version_one_published_uq`), and two publications at once are taken in turn.
- **In the database too.** `ai_classification_policy_version_baseline_chk` (V1140) refuses a `PUBLISHED` row that is wider than the baseline, whatever wrote it; `ai_classification_policy_version_sod_chk` refuses a policy approved by its author.
- **Without a published policy** the baseline applies with the international route off (`routesFor(level, undefined)`); the list of policies tells the baseline and the id of the policy in force.

Every command writes an audit row (`llm.provider_registered`, `llm.provider_activated`, `llm.model_registered`, `llm.policy_drafted`, `llm.policy_published`) and an outbox event (`llm.provider.registered.v1`, `llm.provider.activated.v1`, `llm.model.registered.v1`, `llm.policy.drafted.v1`, `llm.policy.published.v1`).

## The screens

- **LLM-02 providers**: a card for each provider (route, highest class, data agreement, D07, status) with the note that international is public only; the activation form of a `PROPOSED` provider for who holds `llm.provider.approve` (it asks the D07 reference of an international one), and the registration form for who holds `llm.provider.manage`.
- **LLM-03 models**: the table with the provider, window, output, highest class, capabilities and status, a filter by provider, the note that a model that is not `APPROVED` cannot be used yet, and the registration form.
- **LLM-19 the matrix**: the matrix in force (or the baseline, said as such), the revisions with their status and the publish button for a draft (who holds `llm.policy.approve`), and the draft form that starts from the matrix in force: a route the baseline never gives to a class is not offered, the line of important data is fixed, the international route is offered for public data only once the tenant turns it on with the D07 reference.
- Refusals of the server are put in words (including the classes of a weakened baseline); the three screens have the standard states, and an empty registry still offers to register the first provider or model.

## Assumptions and limits

- The reads of the registry are the tenant's (`SCOPE_DENIED` for who holds the right over a unit only). The permissions `llm.provider.read` and `llm.policy.read` are new in the contract; they are not in any role of the design yet and must be granted with the permission matrix of the roles.
- A provider that takes more than public data needs its data agreement to be activated (an assumption of the design's "has a data agreement"); a public-only provider does not.
- The date of a policy is a day in Viet Nam (it begins at midnight there, UTC+7), and the form begins on that day.
- A policy is in force when it is published; a draft dated in the future waits and cannot be published before its date.
- A tenant with no published policy has no `ai_request.policy_version_id` to point at: the baseline policy row that the gateway (ST-LLM-005) records on a request is made there, not here.
- Making a model `APPROVED`, the virtual keys, the budgets, the pricing and the gateway itself are the next stories of the module (ST-LLM-002..006).

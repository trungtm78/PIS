export const KERNEL_PACKAGE = '@machvon/kernel';
export { DomainError } from './errors.ts';
export type { DomainErrorOptions } from './errors.ts';
export { canonicalJson, sha256Hex } from './canonical-json.ts';
export {
  IDEMPOTENCY_LOCK_SECONDS,
  IDEMPOTENCY_TTL_HOURS,
  keyHashOf,
  parseIdempotencyKey,
  requestHashOf,
} from './idempotency.ts';
export type { IdempotencyTtl, RequestParts } from './idempotency.ts';
export { formatEtag, parseIfMatch, versionConflict } from './if-match.ts';
export { auditLeafHash, merkleRoot, sealHashOf } from './audit-seal.ts';
export { OUTBOX_BATCH_SIZE, OUTBOX_LAG_ALERT_SECONDS, OUTBOX_MAX_ATTEMPTS, outboxDelaySeconds } from './outbox-policy.ts';
export { safeDiff } from './redact.ts';
export { NOOP_ALERTS, NOOP_METRICS } from './ports.ts';
export type { AlertSink, MetricsSink } from './ports.ts';
export { assertAllowedFields } from './allowlist.ts';
export { loadErrorRegistry } from './error-registry.ts';
export type { RegisteredError } from './error-registry.ts';
export { asUuid, parseTenantContext } from './tenant-context.ts';
export type { TenantContext } from './tenant-context.ts';
export { InvalidKeyError, TenantCache, tenantKey } from './tenant-keys.ts';
export type { KeyValueStore } from './tenant-keys.ts';
export { signTenantContext, verifyTenantContext } from './signed-context.ts';
export { permissionMatches } from './permission.ts';
export { scopeContains, scopeCovers } from './scope.ts';
export type { ResourceRef, Scope } from './scope.ts';
export { activeGrants, effectivePermissions, holdsPermission, maxRank } from './effective-access.ts';
export type { EffectiveAccess, GrantView } from './effective-access.ts';
export { STEP_UP_WINDOW_MINUTES, decide } from './decision.ts';
export type { DecideInput, Decision, Plane } from './decision.ts';
export { checkGrant, checkRoleDefinition, permissionCovered } from './anti-escalation.ts';
export type { AntiEscalationCode, AntiEscalationResult, GrantCheckInput, RoleDefinitionCheckInput } from './anti-escalation.ts';
export { CONTROL_ROLES, controlAccessOf } from './control-access.ts';
export type { ControlRole } from './control-access.ts';
export { STANDARD_FEATURES, activeOverride, allowedFeature, entitlementsHash } from './entitlement.ts';
export type { AllowedFeatureInput, EntitlementDenial, FeatureEntry, LicenseMode, OperationKind, Override, TenantAccessPolicy } from './entitlement.ts';
export { licenseModeAt, licenseStatusAt, signLicenseClaims, verifyLicenseToken } from './license.ts';
export type { LicenseClaims, LicenseRejection, LicenseRevisionState, LicenseSigner, LicenseTimeStatus, LicenseVerification } from './license.ts';
export { FEATURE_BY_PERMISSION, RISKY_FEATURES, featureOf, isRiskyFeature } from './features.ts';
export { TenantRateLimiter } from './tenant-rate-limit.ts';
export type { RateLimitVerdict, TenantRateLimiterOptions } from './tenant-rate-limit.ts';
export { buildSymbol, formatRegisterNumber, validateSymbolPattern, vietnamDateOf, vietnamYearOf } from './doc-numbering.ts';
export type { SymbolParts } from './doc-numbering.ts';
export { ND30_A4_STANDARD, assertLayoutWithinLegalRange, layoutProfileOf } from './pdf-layout.ts';
export type {
  Box,
  ElementName,
  ElementStyle,
  LayoutProfile,
  LayoutProfileRow,
  NumberFieldLayout,
  SignatureLayout,
  WatermarkPolicy,
} from './pdf-layout.ts';
export { documentIdOf, normalisePayload, payloadSha256, renderInputHash } from './pdf-render.ts';
export type { PdfRenderer, RenderBlock, RenderContent, RenderInput, RenderRequest, RenderedPdf } from './pdf-render.ts';
export { IntervalScheduler, SYSTEM_TIMERS } from './scheduler.ts';
export type { IntervalSchedulerOptions, JobDefinition, JobOutcome, JobRunRecord, Scheduler, TimerPort } from './scheduler.ts';
export {
  InvalidObjectKeyError,
  MAX_PRESIGN_TTL_SECONDS,
  OBJECT_KEY_ROOT,
  UPLOAD_PURPOSES,
  assertLinkable,
  objectKey,
  ownsObjectKey,
  parseObjectKey,
  signUrl,
  transitionScan,
  validateUpload,
  verifyUrl,
} from './object-storage.ts';
export type {
  ObjectKeyParts,
  ObjectStoragePort,
  PresignInput,
  PresignMethod,
  PresignVerdict,
  PresignedGrant,
  ScanPort,
  ScanStatus,
  ScanVerdict,
  StoredObject,
  UploadPurpose,
  UploadVerdict,
} from './object-storage.ts';
export { runScheduledExport } from './scheduled-export.ts';
export type { ScheduledExportDeps, ScheduledExportJob, ScheduledExportOutcome } from './scheduled-export.ts';
export { parseSigningCertificate } from './signing-certificate.ts';
export type { ParsedCertificate } from './signing-certificate.ts';
export { validateSecurityPolicy } from './security-policy.ts';
export type { SecurityPolicyContent } from './security-policy.ts';
export { defineWorkflow, nextState, transitionOf } from './orchestrator.ts';
export type { OrchestratorPort, SignalRequest, Transition, WorkflowDefinition, WorkflowSnapshot } from './orchestrator.ts';
export { INDETERMINATE_FINDINGS, INVALID_FINDINGS, TRUST_REGIMES, allowedDigestName, isAllowedAlgorithm, overallOf, statusOfFindings } from './pades.ts';
export type {
  AlgorithmChoice,
  ByteRange,
  ChainStatus,
  IndeterminateFinding,
  InvalidFinding,
  PadesProfile,
  RevocationStatus,
  SignatureFinding,
  SignatureReport,
  SignatureResult,
  SignatureRole,
  SignatureStatus,
  TrustRegime,
  VerificationPolicy,
} from './pades.ts';
export { correlationOfTraceId, traceIdOfCorrelation, ConsoleSpanExporter, InMemorySpanExporter, NoopSpanExporter, OtlpHttpSpanExporter, SPAN_ATTRIBUTE_ALLOWLIST, Tracer, formatTraceparent, looksSensitive, parseTraceparent, sanitizeSpanAttributes } from './telemetry.ts';
export type { FinishedSpan, Span, SpanAttributeValue, SpanExporter, TraceContext, TracerOptions } from './telemetry.ts';
export { AlertEvaluator, CollectingTelemetry, LICENSE_EXPIRING_ALERT, MANDATORY_ALERT_RULES, raiseExpiringLicenses } from './alerts.ts';
export type { AlertAdapter, AlertChannel, AlertRule, AlertSeverity, AlertSource, Evaluation, FiredAlert, MetricSample, MetricsSnapshot } from './alerts.ts';
export { ACCESS_REVOCATION_LAG_METRIC, percentile95, reportAccessRevocationLag } from './alerts.ts';
export { CHANGE_REQUEST_STATES, assertFourEyes, canTransition, changeRequestNext } from './four-eyes.ts';
export type { ChangeRequestAction, ChangeRequestState } from './four-eyes.ts';
export { ROUNDING_MODES, convertDecimal, roundDecimal } from './decimal.ts';
export type { RoundingMode } from './decimal.ts';
export { CALENDAR_TIMEZONES, WEEKDAYS, assertCalendar, isLate, periodOf, reportingPeriods } from './reporting-calendar.ts';
export type { CalendarDefinition, ReportingPeriod, Weekday } from './reporting-calendar.ts';
export { DEFAULT_TABULAR_LIMITS, readTabularFile } from './tabular-file.ts';
export type { TabularFile, TabularFormat, TabularLimits } from './tabular-file.ts';

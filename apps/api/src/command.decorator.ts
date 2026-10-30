import 'reflect-metadata';
import { SetMetadata, createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { IdempotencyTtl } from '@machvon/kernel';
import type { CommandScope } from './command-scope';

export const COMMAND_METADATA_KEY = 'machvon:command';
/** Request property that the command interceptor fills with the CommandScope of the running command. */
export const COMMAND_SCOPE_KEY = 'commandScope';

export interface CommandOptions {
  /** Stable operation name; part of the idempotency key scope. */
  operation: string;
  /** `extended` (7 days) for money and offline-mobile commands; default `standard` (72 hours). */
  ttl?: IdempotencyTtl;
  /** The command changes a record that has a version: `If-Match` is required. */
  versioned?: boolean;
  /**
   * The field of the answer that carries the version of the record, when it is not `version` or `resource_version` (a draft
   * answers `revision`). The ETag of the answer is built from it, also when a retry replays the stored answer.
   */
  versionField?: string;
  /**
   * `control` runs the business transaction through the ControlDatabase (role machvon_control) under the platform
   * tenant instead of the tenant plane; the idempotency record and the audit rows still belong to the platform tenant.
   */
  plane?: 'control';
  /**
   * Fields of the answer that are a secret shown once (a token the platform keeps the hash of). The caller gets them in the answer of the request; the answer kept for the replay of the idempotency key has them
   * emptied (a string becomes '', anything else null), so the secret is never stored and a replay tells the caller to start again.
   */
  withheld?: readonly string[];
}

/** Marks a write handler as a command: it then runs idempotently, audited, in one tenant transaction. */
export const Command = (options: CommandOptions): MethodDecorator => SetMetadata(COMMAND_METADATA_KEY, options);

/** The CommandScope of the running command (only available on @Command handlers). */
export const Scope = createParamDecorator(
  (_data: unknown, context: ExecutionContext): CommandScope =>
    context.switchToHttp().getRequest<{ [COMMAND_SCOPE_KEY]: CommandScope }>()[COMMAND_SCOPE_KEY],
);

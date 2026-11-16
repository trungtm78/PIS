import { useCallback } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { useCreateDraft, useRuleMove } from '../../adm/governance/hooks';
import { resourceIdOf, toVersion } from '../../adm/governance/model';
import type { Params, RuleVersion } from '../../adm/governance/model';
import { TEMPLATE_RULE_TYPE } from '../model';
import { ASSIGNMENT_RULE_CODE, ASSIGNMENT_RULE_TYPE, applyChange, hasApplyChange } from './assignment-model';
import type { ApplyChange } from './assignment-model';
import { paramsOfTemplate } from './template-model';
import type { Template } from './template-model';

/**
 * The writes of the editor, in the order that keeps the two-person rule whole (R60): the template is written as a draft; when the person submits, the draft of the mapping rule ("Áp cho") that goes with it is written
 * too, then both are submitted. A different person approves each. Nothing here approves, and nothing writes the mapping rule in force: every line a person adds or takes off travels in a draft of its own.
 */

export interface CommitInput {
  /** The template with every code settled; it is written as it is. */
  template: Template;
  /** The code of the rule the template is written under (made once from the name for a new template). */
  code: string;
  reason: string;
  /** The first day the version applies. */
  effectiveFrom: string;
  /** Submit for approval after writing; false: write the draft only. */
  submit: boolean;
  /** The lines of the mapping rule the person added or took off. They are written only when submitting. */
  apply: ApplyChange;
  /** The params of the mapping rule in force (the shipped rule when none is); the draft is that plus the change. */
  assignmentParams: unknown;
  /** The draft this one replaces, when it was written by the person themselves: it is retired so that a day of saving does not leave a day of drafts. */
  supersede: RuleVersion | undefined;
  /** What an earlier try of the same submit already wrote (the draft stands; only what failed is done again). */
  reuse?: { id: string; mappingId: string | undefined } | undefined;
}

export interface CommitResult {
  /** The id of the version of the template that was written. */
  id: string;
  /** The version of the draft of the mapping rule, when one was written. */
  mappingId: string | undefined;
  /** What was done: written only, or written and submitted. */
  submitted: boolean;
}

/** A write that stopped half way: what was written before it stopped, so that the person does not write it twice. */
export class CommitFailure extends Error {
  constructor(
    override readonly cause: unknown,
    readonly done: { id: string | undefined; mappingId: string | undefined },
  ) {
    super('COMMIT_FAILED');
  }
}

export function useTemplateCommit(): (input: CommitInput) => Promise<CommitResult> {
  const client = useApiClient();
  const { mutateAsync: create } = useCreateDraft();
  const { mutateAsync: move } = useRuleMove();
  return useCallback(
    async (input) => {
      const done: { id: string | undefined; mappingId: string | undefined } = { id: input.reuse?.id, mappingId: input.reuse?.mappingId };
      try {
        if (done.id === undefined) {
          done.id = resourceIdOf(await create({ ruleType: TEMPLATE_RULE_TYPE, code: input.code, unitId: undefined, params: paramsOfTemplate(input.template) as Params, effectiveFrom: input.effectiveFrom, effectiveTo: undefined, reason: input.reason }));
          if (done.id === undefined) throw new Error('DRAFT_WITHOUT_ID');
          if (input.supersede !== undefined && input.supersede.status === 'DRAFT') {
            // A draft that is replaced is put away; failing to do so leaves one draft more, never a lost change.
            await move({ move: 'retire', id: input.supersede.id, version: input.supersede.resourceVersion, reason: input.reason }).catch(() => undefined);
          }
        }
        if (!input.submit) return { id: done.id, mappingId: undefined, submitted: false };
        if (done.mappingId === undefined && hasApplyChange(input.apply)) {
          done.mappingId = resourceIdOf(
            await create({ ruleType: ASSIGNMENT_RULE_TYPE, code: ASSIGNMENT_RULE_CODE, unitId: undefined, params: applyChange(input.assignmentParams, input.code, input.apply), effectiveFrom: input.effectiveFrom, effectiveTo: undefined, reason: input.reason }),
          );
        }
        for (const id of [done.id, ...(done.mappingId === undefined ? [] : [done.mappingId])]) {
          const version = toVersion(await client.read('getGovernanceRule' as never, { path: { ruleId: id } } as never));
          if (version === undefined) throw new Error('VERSION_UNREADABLE');
          // A version submitted by an earlier try is not submitted twice.
          if (version.status === 'DRAFT') await move({ move: 'submit', id, version: version.resourceVersion, reason: input.reason });
        }
        return { id: done.id, mappingId: done.mappingId, submitted: true };
      } catch (error) {
        throw new CommitFailure(error, done);
      }
    },
    [client, create, move],
  );
}

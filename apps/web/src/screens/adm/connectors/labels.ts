import type { Translator } from '../../../i18n';
import type { Tone } from '../../../ui';
import type { AdapterStatus } from '../../mdm/model';
import type { ConnectorMode, ConnectorProblem, ConnectorStatus, ProblemView } from './model';

type T = Translator['t'];

/**
 * The pill of the verdict on an adapter: MOCK is red (a fake must never be mistaken for a live link), PROPOSED yellow (a format waiting for a
 * contract), VERIFIED the plain pill, MISSING grey. The words are those of the integration cursors (`adapterLabel` of the master data screens).
 */
export function adapterPill(status: AdapterStatus): string {
  switch (status) {
    case 'VERIFIED':
      return 'pill';
    case 'MOCK':
      return 'pill red';
    case 'PROPOSED':
      return 'pill warn';
    case 'MISSING':
      return 'pill gray';
  }
}

// Every key is written out so the i18n check can see it is in use.
export function modeLabel(t: T, mode: ConnectorMode): string {
  switch (mode) {
    case 'FILE_IMPORT':
      return t('adm.connectors.mode.fileImport');
    case 'FILE_EXPORT':
      return t('adm.connectors.mode.fileExport');
    case 'API':
      return t('adm.connectors.mode.api');
    case 'LGSP':
      return t('adm.connectors.mode.lgsp');
  }
}

export function connectorStatusLabel(t: T, status: ConnectorStatus): string {
  switch (status) {
    case 'Draft':
      return t('adm.connectors.status.draft');
    case 'Active':
      return t('adm.connectors.status.active');
    case 'Disabled':
      return t('adm.connectors.status.disabled');
  }
}

export function connectorStatusPill(status: ConnectorStatus): string {
  switch (status) {
    case 'Draft':
      return 'pill warn';
    case 'Active':
      return 'pill';
    case 'Disabled':
      return 'pill gray';
  }
}

export function fieldMessage(t: T, problem: ConnectorProblem): string {
  switch (problem) {
    case 'required':
      return t('adm.connectors.field.required');
    case 'code':
      return t('adm.connectors.field.code');
    case 'configJson':
      return t('adm.connectors.field.configJson');
    case 'configSecret':
      return t('adm.connectors.field.configSecret');
    case 'configSize':
      return t('adm.connectors.field.configSize');
    case 'credential':
      return t('adm.connectors.field.credential');
    case 'mapping':
      return t('adm.connectors.field.mapping');
  }
}

export function problemMessage(t: T, problem: ProblemView): string {
  switch (problem.reason) {
    case 'adapterNotVerified':
      return t('adm.connectors.problem.adapterNotVerified');
    case 'mockInProduction':
      return t('adm.connectors.problem.mockInProduction');
    case 'codeTaken':
      return t('adm.connectors.problem.codeTaken');
    case 'invalid':
      return t('adm.connectors.problem.invalid');
    case 'conflict':
      return t('adm.connectors.problem.conflict');
    case 'notFound':
      return t('adm.connectors.problem.notFound');
    case 'denied':
      return t('adm.connectors.problem.denied');
    case 'session':
      return t('adm.connectors.problem.session');
    case 'general':
      return t('adm.connectors.problem.general');
  }
}

/** The tone of the status pill of an adapter: the verdict is honest, a mock adapter is red and a proposed one amber. */
export function adapterTone(status: AdapterStatus): Tone {
  switch (status) {
    case 'VERIFIED':
      return 'success';
    case 'MOCK':
      return 'danger';
    case 'PROPOSED':
      return 'warning';
    case 'MISSING':
      return 'neutral';
  }
}

/** The tone of the status pill of a connector. */
export function connectorStatusTone(status: ConnectorStatus): Tone {
  switch (status) {
    case 'Draft':
      return 'warning';
    case 'Active':
      return 'success';
    case 'Disabled':
      return 'neutral';
  }
}

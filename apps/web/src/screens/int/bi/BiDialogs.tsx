import { useState } from 'react';
import { useTranslation } from '../../../i18n';
import { CommandDialog } from '../int-common';
import { useCreateReader, useDecideReader, useRotateReader, useSetDataset } from '../int-hooks';
import type { BiReader, ExportDataset, ExportDatasetList } from '../int-model';
import { datasetLabel } from './bi-labels';

export type BiDialog =
  | { kind: 'create' }
  | { kind: 'rotate'; reader: BiReader }
  | { kind: 'decide'; reader: BiReader; decision: 'SUSPEND' | 'REACTIVATE' | 'RETIRE' }
  | { kind: 'dataset'; dataset: ExportDataset; enable: boolean };

/** What a command of this screen gives back: a receipt in words, or the password the server showed once. */
export type BiOutcome = { kind: 'receipt'; text: string } | { kind: 'secret'; title: 'created' | 'rotated'; readerName: string; loginName: string; password: string; schemaName: string };

export interface BiDialogsProps {
  dialog: BiDialog | undefined;
  datasets: ExportDatasetList | undefined;
  onClose: () => void;
  onDone: (outcome: BiOutcome) => void;
}

export function BiDialogs({ dialog, datasets, onClose, onDone }: BiDialogsProps) {
  if (dialog === undefined) return null;
  switch (dialog.kind) {
    case 'create':
      return <CreateDialog onClose={onClose} onDone={onDone} />;
    case 'rotate':
      return <RotateDialog key={dialog.reader.id} reader={dialog.reader} onClose={onClose} onDone={onDone} />;
    case 'dataset':
      return <DatasetDialog key={`${dialog.dataset.dataset_code}:${String(dialog.enable)}`} dataset={dialog.dataset} enable={dialog.enable} datasets={datasets} onClose={onClose} onDone={onDone} />;
    default:
      return <DecideDialog key={`${dialog.reader.id}:${dialog.decision}`} reader={dialog.reader} decision={dialog.decision} onClose={onClose} onDone={onDone} />;
  }
}

function CreateDialog({ onClose, onDone }: { onClose: () => void; onDone: (outcome: BiOutcome) => void }) {
  const { t } = useTranslation();
  const create = useCreateReader();
  const [form, setForm] = useState({ name: '', tool: '', limit: '5' });
  const [errors, setErrors] = useState<Partial<Record<'name' | 'limit', true>>>({});
  return (
    <CommandDialog
      title={t('int.bi.create.title')}
      context={[]}
      confirmLabel={t('int.bi.create.confirm.action')}
      effect={t('int.bi.create.effect')}
      reason={false}
      valid={() => {
        const found: typeof errors = {};
        if (form.name.trim() === '' || form.name.trim().length > 120) found.name = true;
        if (!/^\d+$/.test(form.limit.trim()) || Number(form.limit) < 1 || Number(form.limit) > 20) found.limit = true;
        setErrors(found);
        return Object.keys(found).length === 0;
      }}
      run={() => create.mutateAsync({ name: form.name.trim(), ...(form.tool.trim() === '' ? {} : { tool: form.tool.trim() }), connection_limit: Number(form.limit) })}
      onDone={(answer) => onDone({ kind: 'secret', title: 'created', readerName: form.name.trim(), loginName: answer.login_name, password: answer.password, schemaName: answer.schema_name })}
      onClose={onClose}
    >
      <div className="int-form">
        <div className="field">
          <label htmlFor="int-bi-name">{t('int.bi.field.name.label')}</label>
          <input id="int-bi-name" value={form.name} maxLength={120} aria-invalid={errors.name === true} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          {errors.name === true && (
            <span className="int-error" role="alert">
              {t('int.bi.error.name')}
            </span>
          )}
        </div>
        <div className="field">
          <label htmlFor="int-bi-tool">{t('int.bi.field.tool.label')}</label>
          <input id="int-bi-tool" value={form.tool} maxLength={60} onChange={(event) => setForm({ ...form, tool: event.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="int-bi-limit">{t('int.bi.field.limit.label')}</label>
          <input id="int-bi-limit" inputMode="numeric" value={form.limit} aria-invalid={errors.limit === true} onChange={(event) => setForm({ ...form, limit: event.target.value })} />
          {errors.limit === true && (
            <span className="int-error" role="alert">
              {t('int.bi.error.limit')}
            </span>
          )}
        </div>
      </div>
    </CommandDialog>
  );
}

function RotateDialog({ reader, onClose, onDone }: { reader: BiReader; onClose: () => void; onDone: (outcome: BiOutcome) => void }) {
  const { t } = useTranslation();
  const rotate = useRotateReader();
  return (
    <CommandDialog
      title={t('int.bi.rotate.title')}
      context={[
        { label: t('int.bi.column.name'), value: reader.name },
        { label: t('int.bi.column.login'), value: reader.login_name },
      ]}
      confirmLabel={t('int.bi.rotate.confirm.action')}
      effect={t('int.bi.rotate.effect')}
      run={(reason) => rotate.mutateAsync({ id: reader.id, version: reader.version, reason })}
      onDone={(answer) => onDone({ kind: 'secret', title: 'rotated', readerName: reader.name, loginName: answer.login_name, password: answer.password, schemaName: answer.schema_name })}
      onClose={onClose}
    />
  );
}

function DecideDialog({ reader, decision, onClose, onDone }: { reader: BiReader; decision: 'SUSPEND' | 'REACTIVATE' | 'RETIRE'; onClose: () => void; onDone: (outcome: BiOutcome) => void }) {
  const { t } = useTranslation();
  const decide = useDecideReader();
  const text = {
    SUSPEND: { title: t('int.bi.suspend.title'), confirm: t('int.bi.suspend.confirm.action'), effect: t('int.bi.suspend.effect'), done: t('int.bi.success.suspended', { name: reader.name }) },
    REACTIVATE: { title: t('int.bi.reactivate.title'), confirm: t('int.bi.reactivate.confirm.action'), effect: t('int.bi.reactivate.effect'), done: t('int.bi.success.reactivated', { name: reader.name }) },
    RETIRE: { title: t('int.bi.retire.title'), confirm: t('int.bi.retire.confirm.action'), effect: t('int.bi.retire.effect'), done: t('int.bi.success.retired', { name: reader.name }) },
  }[decision];
  return (
    <CommandDialog
      title={text.title}
      context={[
        { label: t('int.bi.column.name'), value: reader.name },
        { label: t('int.bi.column.login'), value: reader.login_name },
        { label: t('int.bi.column.status'), value: reader.status },
      ]}
      confirmLabel={text.confirm}
      effect={text.effect}
      run={(reason) => decide.mutateAsync({ id: reader.id, version: reader.version, decision, reason })}
      onDone={() => onDone({ kind: 'receipt', text: text.done })}
      onClose={onClose}
    />
  );
}

function DatasetDialog({ dataset, enable, datasets, onClose, onDone }: { dataset: ExportDataset; enable: boolean; datasets: ExportDatasetList | undefined; onClose: () => void; onDone: (outcome: BiOutcome) => void }) {
  const { t } = useTranslation();
  const set = useSetDataset();
  const products = datasets?.products ?? [];
  const [productId, setProductId] = useState(dataset.product_id ?? products.find((product) => product.certification === 'CERTIFIED')?.id ?? '');
  const name = datasetLabel(t, dataset.dataset_code);
  return (
    <CommandDialog
      title={enable ? t('int.bi.dataset.enable.title') : t('int.bi.dataset.disable.title')}
      context={[
        { label: t('int.bi.dataset.column.dataset'), value: name },
        { label: t('int.bi.dataset.column.view'), value: dataset.view_name },
      ]}
      confirmLabel={enable ? t('int.bi.datasetEnableConfirm.action') : t('int.bi.datasetDisableConfirm.action')}
      effect={enable ? t('int.bi.dataset.enable.effect') : t('int.bi.dataset.disable.effect')}
      valid={() => !enable || productId !== ''}
      run={(reason) => set.mutateAsync({ version: dataset.version, datasetCode: dataset.dataset_code as 'DS-DISB' | 'DS-CTR', enabled: enable, productId: productId === '' ? undefined : productId, reason })}
      onDone={() => onDone({ kind: 'receipt', text: enable ? t('int.bi.success.datasetOn', { name }) : t('int.bi.success.datasetOff', { name }) })}
      onClose={onClose}
    >
      {enable && (
        <div className="field">
          <label htmlFor="int-bi-product">{t('int.bi.datasetFieldProduct.label')}</label>
          <select id="int-bi-product" value={productId} onChange={(event) => setProductId(event.target.value)}>
            <option value="">{t('int.bi.datasetFieldProduct.none')}</option>
            {products.map((product) => (
              <option key={product.id} value={product.id}>
                {t('int.bi.datasetFieldProduct.option', { code: product.code, certification: product.certification })}
              </option>
            ))}
          </select>
          <span className="sub">{t('int.bi.datasetFieldProduct.hint')}</span>
        </div>
      )}
    </CommandDialog>
  );
}

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyResult } from '../../qms/inspection/model';
import type { ChecklistRow, ResultForm } from '../../qms/inspection/model';
import { ChecklistPanel } from './ChecklistPanel';
import { word } from './test-support';

afterEach(cleanup);

const ITEMS: ChecklistRow[] = [{ code: 'DOC', label: 'Hồ sơ', outcome: null, note: null }];

describe('ChecklistPanel', () => {
  it('answers an item that the form has no answer for yet, and does not show problems before they are asked for', () => {
    const changes: ResultForm[] = [];
    render(<ChecklistPanel items={ITEMS} form={{ ...emptyResult(ITEMS), answers: {} }} onChange={(next) => changes.push(next)} problems={undefined} />);
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Hồ sơ'), { target: { value: 'PASS' } });
    fireEvent.change(screen.getByLabelText(word('iss.field.itemNote.label').replace('{item}', 'Hồ sơ')), { target: { value: 'Tốt' } });
    expect(changes[0]?.answers.DOC).toEqual({ outcome: 'PASS', note: '' });
    expect(changes[1]?.answers.DOC).toEqual({ outcome: '', note: 'Tốt' });
  });

  it('takes an answer or a result that is not one of the choices as no answer', () => {
    const onChange = vi.fn();
    render(<ChecklistPanel items={ITEMS} form={emptyResult(ITEMS)} onChange={onChange} problems={undefined} />);
    fireEvent.change(screen.getByLabelText(word('iss.field.result.label')), { target: { value: 'FAIL' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ result: 'FAIL' }));
    fireEvent.change(screen.getByLabelText(word('iss.field.resultNote.label')), { target: { value: 'Ghi chú' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ resultNote: 'Ghi chú' }));
  });

  it('shows the problems it is given', () => {
    render(
      <ChecklistPanel
        items={ITEMS}
        form={emptyResult(ITEMS)}
        onChange={() => undefined}
        problems={{ answers: { DOC: 'unanswered' }, result: 'required', resultNote: 'required', whole: 'noFailed' }}
      />,
    );
    expect(screen.getAllByRole('alert').length).toBeGreaterThanOrEqual(4);
  });
});

import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { harness, mount } from '../../sas/test-support';
import { PassageSearchPanel } from './PassageSearchPanel';
import { describePassageRefusal, distanceText, passageProblems, toPassages } from './passage-model';

const PACKAGE = '00000000-0000-4000-8000-0000000000a1';
const MODEL = '00000000-0000-4000-8000-0000000000b1';
const VERSION = '00000000-0000-4000-8000-0000000000c1';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const problem = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });
const model = (id: string, status: string) => ({ id, provider_id: '00000000-0000-4000-8000-0000000000d1', model_id: 'embed-small', model_version: '2', capabilities: {}, context_window: 8000, max_output: 1000, max_classification: 'INTERNAL', status, version: 1 });
const LISTER = ['bid.evaluate', 'llm.provider.read'];
const EVALUATOR_ONLY = ['bid.evaluate'];

function client(answer: (operation: string, input: unknown) => unknown, models: unknown[] | Error = [model(MODEL, 'APPROVED'), model('00000000-0000-4000-8000-0000000000d9', 'SUSPENDED')]) {
  const h = harness(answer);
  const readAll = vi.fn(() => (models instanceof Error ? Promise.reject(models) : Promise.resolve(models)));
  (h.client as unknown as { readAll: unknown }).readAll = readAll;
  return Object.assign(h, { readAll });
}

describe('the model of the passage search', () => {
  it('wants a model id, a question of at most 4000 characters, and 1 to 20 passages', () => {
    expect(passageProblems({ modelId: MODEL, question: 'Is the bond valid?', limit: 5 })).toEqual({});
    expect(passageProblems({ modelId: 'x', question: ' ', limit: 0 })).toEqual({ model: 'modelRequired', question: 'questionRequired', limit: 'limitRange' });
    expect(passageProblems({ modelId: MODEL, question: 'x'.repeat(4001), limit: 21 })).toEqual({ question: 'questionLong', limit: 'limitRange' });
  });

  it('reads the passages and drops a row that lacks its text or distance', () => {
    const result = toPassages({ items: [{ document_version_id: VERSION, page_index: 2, chunk_no: 0, classification: 'CONFIDENTIAL', distance: 0.12345, text: 'The bond is valid.' }, { document_version_id: VERSION }], as_of: '2026-11-08T03:00:00.000Z' });
    expect(result.items).toHaveLength(1);
    expect(result.asOf).toBe('2026-11-08T03:00:00.000Z');
    expect(distanceText(0.12345)).toBe('0.1235');
    expect(distanceText(Number.NaN)).toBe('–');
  });

  it('names each refusal of the search', () => {
    expect(describePassageRefusal(problem(409, 'CONFLICT_UNDECLARED'))).toBe('undeclared');
    expect(describePassageRefusal(problem(403, 'AI_ROUTE_NOT_ALLOWED'))).toBe('route');
    expect(describePassageRefusal(problem(503, 'AI_KILL_SWITCH_ENGAGED'))).toBe('killSwitch');
    expect(describePassageRefusal(problem(422, 'MODEL_NOT_APPROVED'))).toBe('model');
    expect(describePassageRefusal(new Error('x'))).toBe('general');
  });
});

describe('BID-09 the search of the passages of the proposals (searchProposalPassages)', () => {
  const found = { items: [{ document_version_id: VERSION, page_index: 0, chunk_no: 1, classification: 'CONFIDENTIAL', distance: 0.25, text: 'The bond is valid until March.' }], as_of: '2026-11-08T03:00:00.000Z' };
  const ask = async (): Promise<void> => {
    await waitFor(() => expect((document.getElementById('passages-model') as HTMLSelectElement).options.length).toBe(2));
    fireEvent.change(document.getElementById('passages-model') as HTMLSelectElement, { target: { value: MODEL } });
    fireEvent.change(document.getElementById('passages-question') as HTMLTextAreaElement, { target: { value: '  Is the bond valid?  ' } });
    fireEvent.submit(screen.getByTestId('passage-search'));
  };

  it('offers only the approved models to who may list them, asks with the model, the trimmed question and the limit, and shows the passages with the "i" of the distance', async () => {
    const h = client(() => found);
    mount(<PassageSearchPanel packageId={PACKAGE} />, h, LISTER);
    await ask();
    expect(await screen.findByTestId('passages')).toBeTruthy();
    expect(h.read).toHaveBeenCalledWith('searchProposalPassages', { path: { id: PACKAGE }, query: { embedding_model_id: MODEL, question: 'Is the bond valid?', limit: 5 } });
    expect(screen.getByText('The bond is valid until March.')).toBeTruthy();
    expect(screen.getByTestId('passage-search').querySelectorAll('button.ui-info__button').length).toBe(1);
    expect(screen.queryByTestId('passages-model-typed')).toBeNull();
  });

  it('lets an evaluator without the right to list models name the model, says why, and never reads the list', async () => {
    const h = client(() => found);
    mount(<PassageSearchPanel packageId={PACKAGE} />, h, EVALUATOR_ONLY);
    expect(await screen.findByTestId('passages-model-typed')).toBeTruthy();
    expect(h.readAll).not.toHaveBeenCalled();
    const field = document.getElementById('passages-model') as HTMLInputElement;
    expect(field.tagName).toBe('INPUT');
    fireEvent.change(field, { target: { value: MODEL } });
    fireEvent.change(document.getElementById('passages-question') as HTMLTextAreaElement, { target: { value: 'Is the bond valid?' } });
    fireEvent.submit(screen.getByTestId('passage-search'));
    expect(await screen.findByTestId('passages')).toBeTruthy();
    expect(h.read).toHaveBeenCalledWith('searchProposalPassages', expect.objectContaining({ query: expect.objectContaining({ embedding_model_id: MODEL }) }));
  });

  it('refuses a model that is not an identifier before sending', async () => {
    const h = client(() => found);
    mount(<PassageSearchPanel packageId={PACKAGE} />, h, EVALUATOR_ONLY);
    await screen.findByTestId('passages-model-typed');
    fireEvent.change(document.getElementById('passages-model') as HTMLInputElement, { target: { value: 'nope' } });
    fireEvent.change(document.getElementById('passages-question') as HTMLTextAreaElement, { target: { value: 'Is the bond valid?' } });
    fireEvent.submit(screen.getByTestId('passage-search'));
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
    expect(h.read).not.toHaveBeenCalled();
  });

  it('says there is nothing near the question, as something other than a failure', async () => {
    mount(<PassageSearchPanel packageId={PACKAGE} />, client(() => ({ items: [], as_of: '2026-11-08T03:00:00.000Z' })), LISTER);
    await ask();
    expect(await screen.findByTestId('passages-empty')).toBeTruthy();
    expect(screen.queryByTestId('passages-refusal')).toBeNull();
  });

  it('sends nothing for an empty question, and says which field is wrong', async () => {
    const h = client(() => found);
    mount(<PassageSearchPanel packageId={PACKAGE} />, h, LISTER);
    await waitFor(() => expect((document.getElementById('passages-model') as HTMLSelectElement).options.length).toBe(2));
    fireEvent.submit(screen.getByTestId('passage-search'));
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(1);
    expect(h.read).not.toHaveBeenCalled();
  });

  it('tells a conflict of interest not declared, with a way to try again', async () => {
    const h = client(() => problem(409, 'CONFLICT_UNDECLARED'));
    mount(<PassageSearchPanel packageId={PACKAGE} />, h, LISTER);
    await ask();
    expect(await screen.findByTestId('passages-refusal')).toBeTruthy();
  });

  it('says when no approved model is listed, and falls back to naming the model when the list cannot be read', async () => {
    mount(<PassageSearchPanel packageId={PACKAGE} />, client(() => ({}), [model(MODEL, 'SUSPENDED')]), LISTER);
    expect(await screen.findByTestId('passages-no-models')).toBeTruthy();
    cleanup();
    mount(<PassageSearchPanel packageId={PACKAGE} />, client(() => ({}), new Error('down')), LISTER);
    expect(await screen.findByTestId('passages-model-typed')).toBeTruthy();
    expect((document.getElementById('passages-model') as HTMLInputElement).tagName).toBe('INPUT');
  });
});

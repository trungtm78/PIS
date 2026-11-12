import { runWithNetworkWatch } from '@machvon/kernel';

/**
 * The contract of a page-reading port of the enterprise edition (CN.02, TH.03): what an adapter of the eProcurement system or of the registry of documents must do, whoever wrote it. The fake adapters pass it today; a real
 * adapter is accepted only when it passes it too, so the readers can rely on the port and not on the adapter. Run inside a `describe` of a test file.
 */
export interface PagePort<Rec, Query> {
  readonly adapterStatus: string;
  readonly layoutVersion: string;
  read(query: Query): Promise<{ records: Rec[]; next: string | null; layout: string; acceptance: string; workingAssumption: boolean }>;
}

export interface PageContractCase<Rec, Query> {
  /** A port holding at least five records. */
  make(): PagePort<Rec, Query>;
  keyOf(record: Rec): string;
  /** A query for each rule the port must refuse, with the field it must name. */
  refused: ReadonlyArray<{ query: Query; field: string }>;
  /** The size of the whole list, for the walk of the pages. */
  total: number;
  withPage(after: string | undefined, limit: number | undefined): Query;
}

export function pageContract<Rec, Query>(name: string, contract: PageContractCase<Rec, Query>): void {
  describe(`${name}: the contract of a port`, () => {
    it('is a substitute that nobody has accepted: PROPOSED adapter, a layout that is a working assumption, acceptance PENDING_EXTERNAL', async () => {
      const port = contract.make();
      expect(port.adapterStatus).toBe('PROPOSED');
      expect(port.layoutVersion).toContain('WORKING-ASSUMPTION');
      const page = await port.read(contract.withPage(undefined, undefined));
      expect(page.layout).toBe(port.layoutVersion);
      expect(page.acceptance).toBe('PENDING_EXTERNAL');
      expect(page.workingAssumption).toBe(true);
    });

    it('opens no connection to anything', async () => {
      const port = contract.make();
      const seen = await runWithNetworkWatch(async () => {
        await port.read(contract.withPage(undefined, undefined));
      });
      expect(seen).toEqual([]);
    });

    it('walks the whole list in pages in the order of the keys, each record once, and ends with a null cursor', async () => {
      const port = contract.make();
      const keys: string[] = [];
      let after: string | undefined;
      let pages = 0;
      do {
        const page = await port.read(contract.withPage(after, 2));
        expect(page.records.length).toBeLessThanOrEqual(2);
        keys.push(...page.records.map(contract.keyOf));
        after = page.next ?? undefined;
        pages += 1;
      } while (after !== undefined && pages < 100);
      expect(keys).toHaveLength(contract.total);
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys).toEqual([...keys].sort());
    });

    it('answers the same query with the same page twice', async () => {
      const port = contract.make();
      const first = await port.read(contract.withPage(undefined, 3));
      expect(await port.read(contract.withPage(undefined, 3))).toEqual(first);
    });

    it('answers an empty page and no cursor after the last key', async () => {
      const port = contract.make();
      const page = await port.read(contract.withPage('zzzzzzzz', undefined));
      expect(page).toMatchObject({ records: [], next: null });
    });

    it('refuses a malformed query with 422 naming the field, and never answers it', async () => {
      const port = contract.make();
      for (const refused of contract.refused) {
        await expect(Promise.resolve().then(() => port.read(refused.query))).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: refused.field });
      }
    });
  });
}

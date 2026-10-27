import { compareWork, orderWork, workBucket } from '../src/home-work.ts';
import type { WorkItem } from '../src/home-work.ts';

const TODAY = '2027-10-15';
const item = (id: string, kind: WorkItem['kind'], due: string | null, overrides: Partial<WorkItem> = {}): WorkItem => ({ id, kind, dueOn: due, originalDueOn: due, title: id, subtitle: null, status: 'OPEN', ...overrides });

describe('the work of a person, in the order it is looked at (ST-HOME-004, HOME 3 F5)', () => {
  it('puts what is late first, then what is near its day, then the rest', () => {
    expect(workBucket(item('a', 'EXPLANATION', '2027-10-14'), TODAY)).toBe('OVERDUE');
    expect(workBucket(item('b', 'EXPLANATION', '2027-10-15'), TODAY)).toBe('NEAR');
    expect(workBucket(item('c', 'EXPLANATION', '2027-10-22'), TODAY)).toBe('NEAR');
    expect(workBucket(item('d', 'EXPLANATION', '2027-10-23'), TODAY)).toBe('LATER');
    // A task with no day is not late and not near: it waits at the end.
    expect(workBucket(item('e', 'APPROVAL', null), TODAY)).toBe('LATER');
  });

  it('orders by bucket, then by the day (the earliest first), then by the priority of the kind, then by the id, whatever order it came in', () => {
    const items = [
      item('z-later', 'APPROVAL', '2027-12-01'),
      item('near-b', 'MNE_OBLIGATION', '2027-10-18'),
      item('late-old', 'EXPLANATION', '2027-10-01'),
      item('near-a', 'EXPLANATION', '2027-10-18'),
      item('late-new', 'EXPLANATION', '2027-10-14'),
      item('no-day', 'APPROVAL', null),
    ];
    expect(orderWork(items, TODAY).map((entry) => entry.id)).toEqual(['late-old', 'late-new', 'near-a', 'near-b', 'z-later', 'no-day']);
    expect(orderWork([...items].reverse(), TODAY).map((entry) => entry.id)).toEqual(orderWork(items, TODAY).map((entry) => entry.id));
  });

  it('puts a task of a kind that comes first before another of the same day, and an id decides the rest', () => {
    const same = [item('b', 'MNE_OBLIGATION', '2027-10-18'), item('a2', 'EXPLANATION', '2027-10-18'), item('a1', 'EXPLANATION', '2027-10-18'), item('c', 'APPROVAL', '2027-10-18')];
    expect(orderWork(same, TODAY).map((entry) => entry.id)).toEqual(['c', 'a1', 'a2', 'b']);
  });

  it('tells the position of a task against another, so that a page can go on from a task that is no longer in the list', () => {
    const items = orderWork([item('a', 'EXPLANATION', '2027-10-01'), item('b', 'EXPLANATION', '2027-10-18'), item('c', 'APPROVAL', '2027-10-18'), item('d', 'EXPLANATION', '2027-12-01')], TODAY);
    const gone = item('b2', 'EXPLANATION', '2027-10-18');
    // The task that a cursor was made of is gone: what comes after its place is what follows it in the order.
    expect(items.filter((entry) => compareWork(entry, gone, TODAY) > 0).map((entry) => entry.id)).toEqual(['d']);
    expect(compareWork(items[0] as WorkItem, items[1] as WorkItem, TODAY)).toBeLessThan(0);
    expect(compareWork(items[1] as WorkItem, items[1] as WorkItem, TODAY)).toBe(0);
  });

  it('does not change what it is given', () => {
    const items = [item('b', 'EXPLANATION', '2027-10-18'), item('a', 'EXPLANATION', '2027-10-01')];
    orderWork(items, TODAY);
    expect(items.map((entry) => entry.id)).toEqual(['b', 'a']);
  });
});

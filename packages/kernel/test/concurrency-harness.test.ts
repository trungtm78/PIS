import { assertOneWinner, outcomeLabel, outcomeOfError, runConcurrently, runLoops, succeeded, tallyOutcomes } from '../src/concurrency-harness';
import { DomainError } from '../src/errors';

describe('concurrency harness outcomes', () => {
  it('reads a DomainError as its status and code and anything else as a 500', () => {
    expect(outcomeOfError(new DomainError('BALANCE_INSUFFICIENT', 409))).toEqual({ status: 409, code: 'BALANCE_INSUFFICIENT' });
    expect(outcomeOfError(new TypeError('boom'))).toEqual({ status: 500, code: 'TypeError' });
    expect(outcomeOfError('text')).toEqual({ status: 500, code: 'UNKNOWN' });
    expect(outcomeOfError(undefined)).toEqual({ status: 500, code: 'UNKNOWN' });
  });

  it('labels and tallies the outcomes', () => {
    expect(outcomeLabel(succeeded())).toBe('200');
    expect(outcomeLabel({ status: 409, code: 'VERSION_CONFLICT' })).toBe('409 VERSION_CONFLICT');
    expect(tallyOutcomes([succeeded(), succeeded(201), { status: 409, code: 'X' }, { status: 409, code: 'X' }])).toEqual({ '200': 1, '201': 1, '409 X': 2 });
  });
});

describe('runConcurrently', () => {
  it('holds every command at the gate until all are created, then runs them together', async () => {
    const started: number[] = [];
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const commands = [0, 1, 2].map((index) => async () => {
      started.push(index);
      if (started.length === 3) release();
      await blocker;
    });
    const outcomes = await runConcurrently(commands);
    expect(started.sort()).toEqual([0, 1, 2]);
    expect(outcomes).toEqual([succeeded(), succeeded(), succeeded()]);
  });

  it('turns a throwing command into an outcome and keeps the status a command returns', async () => {
    const outcomes = await runConcurrently([
      async () => succeeded(201),
      async () => {
        throw new DomainError('ACCEPTANCE_ALREADY_CLAIMED', 409);
      },
      async () => {
        throw new Error('db down');
      },
    ]);
    expect(outcomes.map(outcomeLabel)).toEqual(['201', '409 ACCEPTANCE_ALREADY_CLAIMED', '500 Error']);
  });
});

describe('assertOneWinner', () => {
  const refusals = ['409 BALANCE_INSUFFICIENT', '409 VERSION_CONFLICT'];

  it('accepts one success and refusals from the allowed list', () => {
    expect(() => assertOneWinner([succeeded(), { status: 409, code: 'VERSION_CONFLICT' }], refusals)).not.toThrow();
  });

  it('rejects zero or two successes and any other refusal, a 500 above all', () => {
    expect(() => assertOneWinner([{ status: 409, code: 'VERSION_CONFLICT' }, { status: 409, code: 'VERSION_CONFLICT' }], refusals)).toThrow('exactly one success, got 0');
    expect(() => assertOneWinner([succeeded(), succeeded()], refusals)).toThrow('exactly one success, got 2');
    expect(() => assertOneWinner([succeeded(), { status: 500, code: 'Error' }], refusals)).toThrow('unexpected outcome 500 Error');
  });
});

describe('runLoops', () => {
  it('resets, runs and verifies each loop in order and returns every round', async () => {
    const log: string[] = [];
    const rounds = await runLoops({
      loops: 3,
      reset: async (loop) => {
        log.push(`reset ${loop}`);
      },
      commands: (loop) => [
        async () => {
          log.push(`run ${loop}`);
        },
      ],
      verify: async ({ loop, outcomes }) => {
        log.push(`verify ${loop} ${outcomes.length}`);
      },
    });
    expect(rounds.map((round) => round.loop)).toEqual([1, 2, 3]);
    expect(log).toEqual(['reset 1', 'run 1', 'verify 1 1', 'reset 2', 'run 2', 'verify 2 1', 'reset 3', 'run 3', 'verify 3 1']);
  });

  it('stops at the first loop that breaks an invariant and names it with the outcomes', async () => {
    let verified = 0;
    await expect(
      runLoops({
        loops: 5,
        reset: async () => undefined,
        commands: () => [async () => succeeded(), async () => succeeded()],
        verify: async ({ outcomes }) => {
          verified += 1;
          if (verified === 2) assertOneWinner(outcomes, []);
        },
      }),
    ).rejects.toThrow('loop 2 of 5 broke an invariant: expected exactly one success, got 2 (outcomes: {"200":2})');
    expect(verified).toBe(2);
  });

  it('names a loop whose verification throws something that is not an Error', async () => {
    await expect(
      runLoops({
        loops: 1,
        reset: async () => undefined,
        commands: () => [],
        verify: async () => {
          throw 'plain text';
        },
      }),
    ).rejects.toThrow('loop 1 of 1 broke an invariant: plain text');
  });
});

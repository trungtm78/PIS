/** What one concurrent command came to: a success (status 200 unless the command says otherwise) or a refusal with its stable code. */
export interface CommandOutcome {
  status: number;
  code?: string;
}

/** The outcome of a command that returned: the status it reports, 200 by default. */
export function succeeded(status = 200): CommandOutcome {
  return { status };
}

/** The outcome of a command that threw: a DomainError keeps its status and code, anything else is a 500 that no invariant accepts. */
export function outcomeOfError(error: unknown): CommandOutcome {
  const { status, code } = (error ?? {}) as { status?: unknown; code?: unknown };
  if (typeof status === 'number' && typeof code === 'string') return { status, code };
  return { status: 500, code: error instanceof Error ? error.name : 'UNKNOWN' };
}

/** `200` for a success, `409 BALANCE_INSUFFICIENT` for a refusal: the label the tally and the assertions speak. */
export function outcomeLabel(outcome: CommandOutcome): string {
  return outcome.code === undefined ? String(outcome.status) : `${outcome.status} ${outcome.code}`;
}

/**
 * Starts every command at the same moment and waits for all of them. A start gate holds the commands back until each one has
 * been created, so none of them gets a head start; each command then runs on its own connection. A command that throws is an
 * outcome, not a failure of the harness.
 */
export async function runConcurrently(commands: ReadonlyArray<() => Promise<CommandOutcome | void>>): Promise<CommandOutcome[]> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const running = commands.map(async (command) => {
    await gate;
    try {
      return (await command()) ?? succeeded();
    } catch (error) {
      return outcomeOfError(error);
    }
  });
  open();
  return Promise.all(running);
}

/** How many times each outcome label occurred. */
export function tallyOutcomes(outcomes: readonly CommandOutcome[]): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const outcome of outcomes) {
    const label = outcomeLabel(outcome);
    tally[label] = (tally[label] ?? 0) + 1;
  }
  return tally;
}

export interface LoopRound {
  loop: number;
  outcomes: CommandOutcome[];
}

export interface LoopOptions {
  /** How many times the scenario is repeated, each from a fresh state. */
  loops: number;
  /** Puts the state back to its starting point (the balance, the unclaimed acceptance) before each loop. */
  reset: (loop: number) => Promise<void>;
  /** The commands of one loop, which run at the same moment. */
  commands: (loop: number) => ReadonlyArray<() => Promise<CommandOutcome | void>>;
  /** Checks the invariants after a loop; a throw names the loop that broke them. */
  verify: (round: LoopRound) => Promise<void>;
}

/** Runs the scenario `loops` times, one loop after another; stops at the first loop that breaks an invariant and says which. */
export async function runLoops(options: LoopOptions): Promise<LoopRound[]> {
  const rounds: LoopRound[] = [];
  for (let loop = 1; loop <= options.loops; loop += 1) {
    await options.reset(loop);
    const round = { loop, outcomes: await runConcurrently(options.commands(loop)) };
    try {
      await options.verify(round);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`loop ${loop} of ${options.loops} broke an invariant: ${reason} (outcomes: ${JSON.stringify(tallyOutcomes(round.outcomes))})`);
    }
    rounds.push(round);
  }
  return rounds;
}

/**
 * The invariant of a race for one resource: exactly one command won (status 200) and every other one was refused with one of
 * the `refusals` (`409 BALANCE_INSUFFICIENT`, `409 VERSION_CONFLICT`...). Any other outcome, a 500 above all, breaks it.
 */
export function assertOneWinner(outcomes: readonly CommandOutcome[], refusals: readonly string[]): void {
  const labels = outcomes.map(outcomeLabel);
  const winners = labels.filter((label) => label === '200').length;
  if (winners !== 1) throw new Error(`expected exactly one success, got ${winners}`);
  const stray = labels.filter((label) => label !== '200' && !refusals.includes(label));
  if (stray.length > 0) throw new Error(`unexpected outcome ${stray.join(', ')}`);
}

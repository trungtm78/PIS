import { randomUUID } from 'node:crypto';
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { OperationId } from '../../src/operation-id.decorator';
import { CommandHarness } from '../command-harness';
import { loadOpenApi } from '../isolation/test-app';
import { commandCasesFor, writeOperationsOf } from './command-cases';
import type { CommandSubject, WriteOperation } from './command-cases';

/** A write endpoint that ignores the command pipeline: the generated cases must catch it. */
@Controller('test/broken')
class BrokenController {
  @Post()
  @HttpCode(200)
  @OperationId('test_broken_command')
  create(@Body() body: { name: string }): { ok: true; name: string } {
    return { ok: true, name: body.name };
  }
}

const SAMPLES: { module: string; operation: WriteOperation; subject: (harness: CommandHarness) => CommandSubject }[] = [
  {
    module: 'ADM',
    operation: { operationId: 'test_create_widget', method: 'post', path: '/test/widgets', versioned: false },
    subject: (harness) => plainSubject(harness, '/test/widgets'),
  },
  {
    module: 'PRJ',
    operation: { operationId: 'test_update_widget', method: 'put', path: '/test/widgets/{id}', versioned: true },
    subject: (harness) => {
      let target = '';
      const memo = bodies();
      return {
        async prepare() {
          memo.reset();
          const created = await harness.send('POST', '/test/widgets', { body: { name: `prep-${randomUUID()}` } });
          target = created.json.id as string;
          return { version: created.json.version as number };
        },
        send: (request) => harness.send('PUT', `/test/widgets/${target}`, request),
        body: (variant) => memo.of(variant),
      };
    },
  },
  {
    module: 'CAP',
    operation: { operationId: 'test_fail_widget', method: 'post', path: '/test/widgets/fail', versioned: false },
    subject: (harness) => plainSubject(harness, '/test/widgets/fail'),
  },
];

/** Bodies that stay the same between calls until the next prepare(), so a replay really repeats the request. */
function bodies(): { reset(): void; of(variant: 'a' | 'b'): unknown } {
  const memo = new Map<string, unknown>();
  return {
    reset: () => memo.clear(),
    of(variant) {
      if (!memo.has(variant)) memo.set(variant, { name: `${variant}-${randomUUID()}` });
      return memo.get(variant);
    },
  };
}

function plainSubject(harness: CommandHarness, path: string): CommandSubject {
  const memo = bodies();
  return {
    prepare: () => {
      memo.reset();
      return Promise.resolve({ version: null });
    },
    send: (request) => harness.send('POST', path, request),
    body: (variant) => memo.of(variant),
  };
}

describe('command conformance generator (ST-KERNEL-028)', () => {
  it('generates three cases per write operation of openapi.json and two more for each versioned one', () => {
    const operations = writeOperationsOf(loadOpenApi());
    const versioned = operations.filter((operation) => operation.versioned).length;
    const cases = operations.flatMap(commandCasesFor);
    expect(operations.length).toBe(973);
    expect(versioned).toBe(594);
    expect(cases.length).toBe(operations.length * 3 + versioned * 2);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    expect(commandCasesFor(operations[0] as WriteOperation).map((c) => c.id.split(':')[1])).toEqual(
      expect.arrayContaining(['missing-key', 'replay', 'conflict']),
    );
  });

  describe('against the running pipeline', () => {
    const harness = new CommandHarness();

    beforeAll(() => harness.start([BrokenController]), 180_000);
    afterAll(() => harness.stop(), 60_000);

    it.each(SAMPLES.map((sample) => [sample.module, sample] as const))('every generated case passes for the %s sample command', async (_module, sample) => {
      const subject = sample.subject(harness);
      const cases = commandCasesFor(sample.operation);
      expect(cases.length).toBe(sample.operation.versioned ? 5 : 3);
      for (const commandCase of cases) {
        await commandCase.run(subject);
      }
    }, 60_000);

    it('fails the generated cases for an endpoint that bypasses the pipeline (negative control)', async () => {
      const operation: WriteOperation = { operationId: 'test_broken_command', method: 'post', path: '/test/broken', versioned: false };
      const subject = plainSubject(harness, '/test/broken');
      const results = await Promise.allSettled(commandCasesFor(operation).map((commandCase) => commandCase.run(subject)));
      expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected', 'rejected']);
    }, 60_000);
  });
});

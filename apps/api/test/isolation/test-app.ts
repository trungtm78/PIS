import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Module } from '@nestjs/common';
import type { DynamicModule, INestApplication, Provider, Type } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { OpenApiDocument } from '@machvon/contracts';
import { startMigratedTestDatabase } from '@machvon/db/src/migrated-test-database';
import type { TestDatabase } from '@machvon/db/src/test-database';
import { implementedOperationIdsOf } from '../../src/operation-id.decorator';
import { TEST_SIGNING_KEY, TestAuthGuard } from './test-auth.guard';

export const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const ENGINEERING_DIR = join(REPO_ROOT, 'Design', 'MACHVON_Design', '03_Engineering');
export const OPENAPI_PATH = join(ENGINEERING_DIR, 'openapi.json');
export const ERROR_CODES_PATH = join(ENGINEERING_DIR, 'error_codes.json');
export const FIXTURES_PATH = join(ENGINEERING_DIR, 'test_fixtures.json');

export function loadOpenApi(): OpenApiDocument {
  return JSON.parse(readFileSync(OPENAPI_PATH, 'utf8')) as OpenApiDocument;
}

/** Starts embedded PostgreSQL with every committed migration applied (test profile). Stop it in afterAll. */
export function startIsolationDatabase(): Promise<TestDatabase> {
  return startMigratedTestDatabase(REPO_ROOT);
}

export interface TestAppOptions {
  signingKey: Buffer;
  imports?: DynamicModule[];
  controllers?: Type[];
  providers?: Provider[];
}

export interface RunningApp {
  baseUrl: string;
  /** operationIds of every controller handler registered in the running application. */
  implementedOperations: Set<string>;
  /** A provider of the running application by its token (for example the mock mailer a test reads). */
  get<T>(token: unknown): T;
  close(): Promise<void>;
}

@Module({})
class IsolationTestModule {}

/** A Nest app whose only authentication is TestAuthGuard; it listens on a free local port. */
export async function startTestApp(options: TestAppOptions): Promise<RunningApp> {
  const providers: Provider[] = [
    { provide: TEST_SIGNING_KEY, useValue: options.signingKey },
    { provide: APP_GUARD, useClass: TestAuthGuard },
    ...(options.providers ?? []),
  ];
  const moduleRef = await Test.createTestingModule({
    imports: [{ module: IsolationTestModule, imports: options.imports ?? [], controllers: options.controllers ?? [], providers }],
  }).compile();
  const app: INestApplication = moduleRef.createNestApplication({ rawBody: true });
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, implementedOperations: implementedOperationIdsOf(app), get: <T>(token: unknown) => app.get<T>(token as never, { strict: false }), close: () => app.close() };
}

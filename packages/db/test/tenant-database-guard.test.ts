import { Pool } from 'pg';
import { TenantDatabase } from '../src/tenant-database';

/** The connection that the server ends while it sits idle in a pool (a restart, a failover, an administrator) must not take the process down with it. */
describe('TenantDatabase and an idle connection ended by the server', () => {
  const ended = (): Error => new Error('terminating connection due to administrator command');

  it('does not let the error of the pool escape as an uncaught exception', () => {
    const pool = new Pool({ connectionString: 'postgres://nobody@127.0.0.1:1/none' });
    expect(pool.listenerCount('error')).toBe(0);
    // Without a listener, emitting an error event throws; this is what Node turns into a dead process.
    expect(() => pool.emit('error', ended())).toThrow('administrator command');
    new TenantDatabase(pool);
    expect(pool.listenerCount('error')).toBe(1);
    expect(() => pool.emit('error', ended())).not.toThrow();
  });

  it('keeps the handler of the owner of the pool and adds none of its own', () => {
    const pool = new Pool({ connectionString: 'postgres://nobody@127.0.0.1:1/none' });
    const seen: Error[] = [];
    pool.on('error', (error) => void seen.push(error));
    new TenantDatabase(pool);
    new TenantDatabase(pool);
    expect(pool.listenerCount('error')).toBe(1);
    pool.emit('error', ended());
    expect(seen).toHaveLength(1);
  });
});

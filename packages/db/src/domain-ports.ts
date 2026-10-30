import type { CertificatePort, DomainPorts, DomainProofPort } from './tenant-domain-store.ts';

/** The MOCK of the DNS lookup: the TXT values a test (or a development environment) has published, by name. */
export class MockDomainProof implements DomainProofPort {
  private readonly records = new Map<string, string[]>();
  lookups = 0;

  publish(name: string, value: string): void {
    this.records.set(name.toLowerCase(), [...(this.records.get(name.toLowerCase()) ?? []), value]);
  }

  unpublish(name: string): void {
    this.records.delete(name.toLowerCase());
  }

  txtRecords(name: string): Promise<string[]> {
    this.lookups += 1;
    return Promise.resolve([...(this.records.get(name.toLowerCase()) ?? [])]);
  }
}

/** The MOCK of the certificate authority: it issues for every hostname unless told to fail. */
export class MockCertificateAuthority implements CertificatePort {
  readonly issued: string[] = [];
  private failing = 0;

  failNext(times: number): void {
    this.failing = times;
  }

  ensureCertificate(hostname: string): Promise<void> {
    if (this.failing > 0) {
      this.failing -= 1;
      return Promise.reject(new Error('the authority is not reachable'));
    }
    this.issued.push(hostname.toLowerCase());
    return Promise.resolve();
  }
}

let shared: (DomainPorts & { proof: MockDomainProof; certificates: MockCertificateAuthority }) | undefined;

/** One pair of MOCK adapters for the process: the commands and the lifecycle job see the same DNS and the same authority until real ones are bound. */
export function sharedMockDomainPorts(): DomainPorts & { proof: MockDomainProof; certificates: MockCertificateAuthority } {
  shared ??= { proof: new MockDomainProof(), certificates: new MockCertificateAuthority() };
  return shared;
}

import { Controller, Get, Header, Inject, Param, Query, Req } from '@nestjs/common';
import { ControlDatabase, PortalPublicReads } from '@machvon/db';
import type { PortalPublicInfo } from '@machvon/db';
import { DomainError, OC4IDS_VERSION, cutToAllowed, oc4idsPackage } from '@machvon/kernel';
import { OperationId } from '../../operation-id.decorator';
import { Public } from '../../public.decorator';
import { ANONYMOUS_RATE_PER_MINUTE, clientKeyOf, consumeRate } from '../public-client';
import { todayOf } from '../gov12-support';

interface RequestLike {
  ip?: string | undefined;
  socket?: { remoteAddress?: string | undefined } | undefined;
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/** A page size that the portal allows: the policy of the portal caps what the caller asks for. */
function pageSize(value: unknown, info: PortalPublicInfo): number {
  if (value === undefined) return Math.min(50, info.pageSizeMax);
  const asked = Number(value);
  if (!Number.isInteger(asked) || asked < 1 || asked > 500) throw new DomainError('VALIDATION_FAILED', 422, 'limit');
  return Math.min(asked, info.pageSizeMax);
}

function afterOf(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > 80) throw new DomainError('VALIDATION_FAILED', 422, 'after');
  return value;
}

/**
 * The public portal (G4-9): read-only, no session, no tenant in the address, no identity. It runs on the control plane and reads through two functions of the database that return only what the publisher cut with the allow-list; it
 * cuts again on the way out with the allow-list the settings hold today, so a field that was taken off the list disappears from the answer without a new publication. Each caller has a rate limit (the portal's own, held in memory
 * under a key that is not the address); an address that is not a portal costs the caller one call of the same limit. Nothing about the caller is written anywhere, and no answer carries an id of a tenant, a person or a record.
 */
@Controller()
export class PortalPublicController {
  private readonly reads = new PortalPublicReads();

  constructor(@Inject(ControlDatabase) private readonly control: ControlDatabase) {}

  /** The portal, after the caller was counted: an unknown or disabled portal is 404 and nothing else. */
  private async portal(slug: string, request: RequestLike): Promise<PortalPublicInfo> {
    if (!SLUG.test(slug)) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const key = clientKeyOf(request, slug);
    consumeRate('portal-any', key, ANONYMOUS_RATE_PER_MINUTE, 60);
    const info = await this.control.withControl((tx) => this.reads.info(tx, slug));
    if (info === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    consumeRate('portal', key, info.ratePerMinute, 60);
    return info;
  }

  @Public()
  @Get('public/portals/:slug')
  @Header('Cache-Control', 'public, max-age=60')
  @OperationId('getPublicPortal')
  async info(@Param('slug') slug: string, @Req() request: RequestLike): Promise<Record<string, unknown>> {
    const info = await this.portal(slug, request);
    return {
      as_of: todayOf(new Date()),
      title: info.title,
      publisher: info.publisherName,
      license_uri: info.licenseUri,
      publication_policy_uri: info.policyUri,
      record_count: info.recordCount,
      last_published_at: info.lastPublishedAt,
      fields: info.allowedFields,
      reports_open: info.whistleEnabled,
      oc4ids_version: OC4IDS_VERSION,
    };
  }

  @Public()
  @Get('public/portals/:slug/projects')
  @Header('Cache-Control', 'public, max-age=60')
  @OperationId('listPublicPortalProjects')
  async projects(@Param('slug') slug: string, @Req() request: RequestLike, @Query('after') after?: unknown, @Query('limit') limit?: unknown): Promise<Record<string, unknown>> {
    const info = await this.portal(slug, request);
    const size = pageSize(limit, info);
    const rows = await this.control.withControl((tx) => this.reads.records(tx, slug, afterOf(after), size + 1));
    const page = rows.slice(0, size);
    return {
      as_of: todayOf(new Date()),
      items: page.map((row) => ({ code: row.publicCode, revision: row.revision, published_at: row.publishedAt, fields: cutToAllowed(row.fields as Record<string, unknown>, info.allowedFields) })),
      next_after: rows.length > size ? (page[page.length - 1]?.publicCode ?? null) : null,
    };
  }

  @Public()
  @Get('public/portals/:slug/oc4ids')
  @Header('Cache-Control', 'public, max-age=60')
  @OperationId('getPublicPortalOc4ids')
  async oc4ids(@Param('slug') slug: string, @Req() request: RequestLike, @Query('after') after?: unknown, @Query('limit') limit?: unknown): Promise<Record<string, unknown>> {
    const info = await this.portal(slug, request);
    const size = pageSize(limit, info);
    const now = new Date();
    const rows = await this.control.withControl((tx) => this.reads.records(tx, slug, afterOf(after), size + 1));
    const page = rows.slice(0, size);
    const built = oc4idsPackage({ records: page.map((row) => cutToAllowed(row.fields as Record<string, unknown>, info.allowedFields)), idPrefix: info.idPrefix, publisher: { name: info.publisherName }, license: info.licenseUri, publicationPolicy: info.policyUri, publishedAt: now });
    return { as_of: todayOf(now), package: built, next_after: rows.length > size ? (page[page.length - 1]?.publicCode ?? null) : null };
  }
}

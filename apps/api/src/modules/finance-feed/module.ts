import { defineModule } from '../module-descriptor';
import { FeedConnectionController, FeedDifferenceController, FeedImportController, FeedMappingController } from './feed.controller';
import { FeedReadsController } from './feed-reads.controller';

/**
 * FEED, the feed of the Finance Department (FEED-1): the connection `fin.sotaichinh` with its three channels (a file, the push of the Finance application, the data generator), the records they bring, the mapping of
 * the project codes, the data-quality indicators, the differences against our own figures and the province-wide facts that the committee reads. docs/finance-feed.md.
 */
export const feedModule = defineModule({
  code: 'FEED',
  controllers: [FeedConnectionController, FeedImportController, FeedMappingController, FeedDifferenceController, FeedReadsController],
});

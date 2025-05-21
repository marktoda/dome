import { getLogger, logError, metrics } from '@dome/common';
import { ValidationError, NotFoundError, UnauthorizedError, toDomeError } from '@dome/common/errors';
import { ulid } from 'ulid';
import { R2Service } from '../services/r2Service';
import { MetadataService } from '../services/metadataService';
import { QueueService } from '../services/queueService';
import { SiloService } from '../services/siloService';
import { R2Event } from '../types';
import {
  SiloContentMetadata,
  SiloSimplePutResponse,
  SiloSimplePutInput,
  ContentCategory,
  SiloContentBatch,
  SiloContentItem,
  EnrichedContentMessage,
} from '@dome/common';

// ---------------------------------------------------------------------------
//  Types / Constants
// ---------------------------------------------------------------------------

const KB = 1024;
const MB = KB * KB;
const SIMPLE_PUT_MAX_SIZE = 1 * MB; // 1 MiB
const UPLOAD_MAX_SIZE = 100 * MB; // 100 MiB
const PRESIGNED_POST_TTL_SECONDS = 15 * 60; // 15 min
const PRESIGNED_URL_TTL_SECONDS = 60 * 60; // 60 min

const logger = getLogger();

// ---------------------------------------------------------------------------
//  Controller
// ---------------------------------------------------------------------------

export class ContentController {
  constructor(
    private readonly env: Env,
    private readonly r2Service: R2Service,
    private readonly metadataService: MetadataService,
    private readonly queueService: QueueService,
    private readonly siloService: SiloService,
  ) {}

  /* ----------------------------------------------------------------------- */
  /*  Public API                                                             */
  /* ----------------------------------------------------------------------- */

  /** Store small (≤1 MiB) content items synchronously. */
  async simplePut(input: SiloSimplePutInput): Promise<SiloSimplePutResponse> {
    const start = performance.now();

    try {
      this.logInput('simplePut input data', input);

      const id = input.id ?? ulid();
      const userId = SiloService.normalizeUserId(input.userId ?? null);
      const size = this.contentSize(input.content);

      if (size > SIMPLE_PUT_MAX_SIZE) {
        throw new ValidationError('Content size exceeds 1 MiB. Use createUpload for larger files.');
      }

      const category = input.category ?? 'note';
      const mimeType = input.mimeType ?? this.deriveMimeType(category, input.content);
      const r2Key = this.buildR2Key('content', id);

      await this.r2Service.putObject(
        r2Key,
        input.content,
        this.buildMetadata({ userId, category, mimeType, custom: input.metadata }),
      );

      metrics.increment('silo.upload.bytes', size);

      const createdAt = Math.floor(Date.now() / 1000);
      logger.info({ id, category, mimeType, size }, 'Content stored successfully');

      return { id, category, mimeType, size, createdAt };
    } catch (error) {
      this.handleError('simplePut', error);
      throw toDomeError(error);
    } finally {
      metrics.timing('silo.rpc.simplePut.latency_ms', performance.now() - start);
    }
  }

  /** Retrieve multiple items by id or list a user's content with pagination. */
  async batchGet(params: {
    ids?: string[];
    userId?: string | null;
    contentType?: string;
    limit?: number;
    offset?: number;
  }): Promise<SiloContentBatch> {
    try {
      logger.info(params, 'batchGet called');

      const { ids = [], userId = null, contentType, limit = 50, offset = 0 } = params;

      const metadataItems =
        ids.length === 0
          ? await this.fetchAllMetadataForUser(userId, contentType, limit, offset)
          : await this.metadataService.getMetadataByIds(ids);

      const results: Record<string, SiloContentItem> = {};

      await Promise.all(
        metadataItems.map(async item => {
          // ACL check: Allow access if the item belongs to the user or is public content
          if (item.userId !== userId && item.userId !== SiloService.PUBLIC_USER_ID) return;

          results[item.id] = item;

          const obj = await this.r2Service.getObject(item.r2Key);
          if (obj) {
            // Extract custom metadata from R2 object
            if (obj.customMetadata) {
              const { metadata: customMetadata } = this.parseCustomMetadata(obj.customMetadata);
              if (customMetadata) {
                results[item.id].customMetadata = customMetadata;
              }
            }

            // Get the content body for small objects
            if (item.size <= SIMPLE_PUT_MAX_SIZE) {
              results[item.id].body = await obj.text();
            } else {
              // For larger objects, provide a presigned URL for download
              results[item.id].url = await this.r2Service.createPresignedUrl(
                item.r2Key,
                PRESIGNED_URL_TTL_SECONDS,
              );
            }
          }
        }),
      );

      const total =
        ids.length === 0 && userId
          ? await this.metadataService.getContentCountForUser(userId, contentType)
          : metadataItems.length;

      const items = Object.values(results);
      logger.info({ itemsCount: items.length, total }, 'Returning batchGet results');

      return { items, total, limit, offset };
    } catch (error) {
      this.handleError('batchGet', error);
      throw toDomeError(error);
    }
  }

  /** Delete a content item (object + metadata) with ACL checks. */
  async delete({ id, userId = null }: { id: string; userId?: string | null }) {
    if (!id) throw new ValidationError('Valid id is required');

    const meta = await this.metadataService.getMetadataById(id);
    if (!meta) throw new NotFoundError('Content not found', { id });

    // ACL check: Allow deletion if the item belongs to the user
    // Public content can only be deleted by admins (not implemented yet)
    if (meta.userId !== userId && meta.userId !== SiloService.PUBLIC_USER_ID) {
      throw new UnauthorizedError('You do not have permission to delete this content', {
        contentId: id,
        requestUserId: userId,
        contentUserId: meta.userId,
      });
    }

    await this.r2Service.deleteObject(meta.r2Key);
    await this.metadataService.deleteMetadata(id);

    // Use the normalized userId when sending the delete message
    const normalizedUserId = SiloService.normalizeUserId(userId);
    await this.queueService.sendNewContentMessage({ id, userId: normalizedUserId, deleted: true });

    metrics.increment('silo.rpc.delete.success');
    logger.info({ id, userId: normalizedUserId }, 'Content deleted successfully');

    return { success: true };
  }

  /** Process enriched content from AI processor */
  async processEnrichedContent(message: EnrichedContentMessage): Promise<void> {
    try {
      const { id, userId, metadata } = message;

      logger.info(
        {
          id,
          userId,
          hasTitle: !!metadata.title,
          hasSummary: !!metadata.summary,
        },
        'Processing enriched content',
      );

      // Update metadata with title and summary
      await this.metadataService.updateEnrichedMetadata(id, {
        title: metadata.title,
        summary: metadata.summary,
      });

      metrics.increment('silo.enriched_content.processed');
      logger.info({ id, userId }, 'Content enriched successfully');
    } catch (error) {
      metrics.increment('silo.enriched_content.errors');
      logError(error, 'Error processing enriched content', { messageId: message.id });
      throw toDomeError(error, 'Failed to process enriched content', { contentId: message.id });
    }
  }

  /** Process messages from the ingest queue */
  async processIngestMessage(message: SiloSimplePutInput): Promise<void> {
    try {
      const { content, metadata } = message;
      const id = message.id ?? ulid();
      const userId = SiloService.normalizeUserId(message.userId || null);
      const category = message.category || 'note';
      const mimeType = message.mimeType || 'text/markdown';

      logger.info(
        {
          id,
          userId,
          category,
          mimeType,
          contentSize: this.contentSize(content),
        },
        'Processing ingest queue message',
      );

      // Store the content in R2
      const r2Key = this.buildR2Key('content', id);
      await this.r2Service.putObject(
        r2Key,
        content,
        this.buildMetadata({ userId, category, mimeType, custom: metadata }),
      );

      // Update metrics
      metrics.increment('silo.ingest_queue.processed');

      // The R2 event will trigger metadata creation via the silo-content-uploaded queue
      logger.info({ id, userId, category, mimeType }, 'Content ingested successfully');
    } catch (error) {
      metrics.increment('silo.ingest_queue.errors');
      logError(error, 'Error processing ingest queue message', { messageId: message.id });
      throw toDomeError(error, 'Failed to process ingest queue message', { contentId: message.id });
    }
  }

  /** Handle R2 PutObject events emitted via queue. */
  async processR2Event(event: R2Event) {
    if (event.action !== 'PutObject') {
      logger.warn({ event }, `Unsupported event action: ${event.action}`);
      return null;
    }

    try {
      const { key } = event.object;
      logger.info({ key }, 'Processing R2 PutObject event');

      const obj = await this.r2Service.headObject(key);
      if (!obj) {
        logger.warn({ key }, 'Object not found in R2');
        return null;
      }

      logger.info({ r2Metadata: obj }, 'R2 object metadata retrieved');
      const { userId, category, mimeType, sha256, metadata } = this.parseCustomMetadata(
        obj.customMetadata,
      );
      const id = this.extractIdFromKey(key);
      const createdAt = Math.floor(Date.now() / 1000);

      logger.info({ userId, category, mimeType, sha256, metadata }, 'storing metadata into d1');
      await this.metadataService.insertMetadata({
        id,
        userId,
        category: category as ContentCategory,
        mimeType,
        size: obj.size,
        r2Key: key,
        sha256,
        createdAt,
      });

      // Normalize the userId before sending the message
      const normalizedUserId = SiloService.normalizeUserId(userId);

      await this.queueService.sendNewContentMessage({
        id,
        userId: normalizedUserId,
        category,
        mimeType,
        size: obj.size,
        createdAt,
        metadata,
      });

      metrics.increment('silo.r2.events.processed');
      logger.info(
        { id, key, category, mimeType, size: obj.size },
        'R2 event processed successfully',
      );

      return { id, category, mimeType, size: obj.size, createdAt };
    } catch (error) {
      metrics.increment('silo.r2.events.errors');
      logError(error, 'Error processing R2 event', { event });
      throw toDomeError(error, 'Failed to process R2 event', { objectKey: event.object.key });
    }
  }

  /* ----------------------------------------------------------------------- */
  /*  Helper utilities (private)                                             */
  /* ----------------------------------------------------------------------- */

  private deriveMimeType(category: string, content: string | ArrayBuffer): string {
    const mapping: Record<string, string> = {
      note: 'text/markdown',
      document: 'application/pdf',
      article: 'text/html',
    };

    if (category === 'code') {
      if (typeof content === 'string') {
        if (/(function|const\s)/.test(content)) return 'application/javascript';
        if (/(def\s|import\s)/.test(content)) return 'application/python';
      }
      return 'application/javascript';
    }

    return mapping[category] ?? 'text/plain';
  }

  private buildMetadata({
    userId,
    category,
    mimeType,
    sha256,
    custom,
    prefix = '',
  }: {
    userId: string | null;
    category: string;
    mimeType: string;
    sha256?: string;
    custom?: Record<string, unknown>;
    prefix?: string;
  }): Record<string, string> {
    const base: Record<string, string> = {
      [`${prefix}user-id`]: userId ?? '',
      [`${prefix}category`]: category,
      [`${prefix}mime-type`]: mimeType,
    };

    if (sha256) base[`${prefix}sha256`] = sha256;
    if (custom) base[`${prefix}metadata`] = JSON.stringify(custom);

    return base;
  }

  private buildR2Key(bucket: 'content' | 'upload', id: string) {
    return `${bucket}/${id}`;
  }

  private extractIdFromKey(key: string) {
    return key.replace(/^(upload|content)\//, '');
  }

  private parseCustomMetadata(meta: Record<string, string>) {
    const pick = (a: string, b: string) => meta[a] ?? meta[b];

    const rawMetadata = pick('x-metadata', 'metadata');
    const rawUserId = pick('x-user-id', 'user-id') ?? null;

    return {
      userId: SiloService.normalizeUserId(rawUserId),
      category: pick('x-category', 'category') ?? 'note',
      mimeType: pick('x-mime-type', 'mime-type') ?? 'text/plain',
      sha256: pick('x-sha256', 'sha256') ?? null,
      metadata: rawMetadata ? this.safeJsonParse(rawMetadata) : null,
    };
  }

  private safeJsonParse(value: string) {
    try {
      return JSON.parse(value);
    } catch {
      logger.warn('Failed to parse metadata JSON');
      return null;
    }
  }

  private contentSize(content: string | ArrayBuffer) {
    return typeof content === 'string'
      ? new TextEncoder().encode(content).length
      : content.byteLength;
  }

  private logInput(message: string, input: SiloSimplePutInput) {
    logger.info(
      {
        category: input.category,
        mimeType: input.mimeType,
        userId: input.userId,
        hasId: !!input.id,
        contentIsString: typeof input.content === 'string',
        contentLength: this.contentSize(input.content),
        hasMetadata: !!input.metadata,
      },
      message,
    );
  }

  private handleError(method: string, error: unknown) {
    const domeError = toDomeError(error, `Error in Silo service during ${method}`);
    logError(domeError, `Error in ${method}`);
    metrics.increment('silo.rpc.errors', 1, { method });
  }

  private async fetchAllMetadataForUser(
    userId: string | null,
    contentType: string | undefined,
    limit: number,
    offset: number,
  ): Promise<SiloContentMetadata[]> {
    if (!userId) {
      logger.warn('User ID is required when not providing specific content IDs');
      throw new ValidationError('User ID is required when not providing specific content IDs');
    }

    logger.info({ userId, contentType }, 'fetching all metadata for user');

    // Use the SiloService to fetch both user-specific and public content
    return this.siloService.fetchContentForUser(userId, contentType, limit, offset);
  }
}

// ---------------------------------------------------------------------------
//  Factory
// ---------------------------------------------------------------------------

export function createContentController(
  env: Env,
  r2Service: R2Service,
  metadataService: MetadataService,
  queueService: QueueService,
): ContentController {
  const siloService = new SiloService(metadataService);
  return new ContentController(env, r2Service, metadataService, queueService, siloService);
}

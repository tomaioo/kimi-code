import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'pathe';
import type { ContentPart, Message } from '@moonshot-ai/kosong';
import type { AgentRecord } from './types';

const DEFAULT_THRESHOLD = 4096;
const BLOBREF_PROTOCOL = 'blobref:';
const DATA_URI_HEADER_RE = /^data:([^;]+);base64,/;
const MISSING_MEDIA_PLACEHOLDER = '[media missing]';

export function isBlobRef(url: string): boolean {
  return url.startsWith(BLOBREF_PROTOCOL);
}

export interface BlobStoreOptions {
  readonly blobsDir: string;
  readonly threshold?: number;
}

export class BlobStore {
  private readonly blobsDir: string;
  private readonly threshold: number;

  constructor(options: BlobStoreOptions) {
    this.blobsDir = options.blobsDir;
    this.threshold = options.threshold ?? DEFAULT_THRESHOLD;
  }

  async offload(record: AgentRecord): Promise<void> {
    switch (record.type) {
      case 'turn.prompt':
      case 'turn.steer':
        for (const part of record.input) {
          await offloadContentPart(part, this.blobsDir, this.threshold);
        }
        break;
      case 'context.append_message':
        for (const part of record.message.content) {
          await offloadContentPart(part, this.blobsDir, this.threshold);
        }
        break;
      case 'context.append_loop_event': {
        const event = record.event;
        if (event.type === 'tool.result' && typeof event.result.output !== 'string') {
          for (const part of event.result.output) {
            await offloadContentPart(part, this.blobsDir, this.threshold);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  async rehydrate(record: AgentRecord): Promise<void> {
    switch (record.type) {
      case 'turn.prompt':
      case 'turn.steer':
        for (const part of record.input) {
          await rehydrateContentPart(part, this.blobsDir);
        }
        break;
      case 'context.append_message':
        for (const part of record.message.content) {
          await rehydrateContentPart(part, this.blobsDir);
        }
        break;
      case 'context.append_loop_event': {
        const event = record.event;
        if (event.type === 'tool.result' && typeof event.result.output !== 'string') {
          for (const part of event.result.output) {
            await rehydrateContentPart(part, this.blobsDir);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  async rehydrateMessages(messages: readonly Message[]): Promise<Message[]> {
    return Promise.all(
      messages.map(async (msg): Promise<Message> => {
        if (msg.content.length === 0) return msg;
        const clone = structuredClone(msg) as Message;
        for (const part of clone.content) {
          await rehydrateContentPart(part, this.blobsDir);
        }
        return {
          role: clone.role,
          name: clone.name,
          content: clone.content.map((part) => downgradeMissingMedia(part)),
          toolCalls: clone.toolCalls,
          toolCallId: clone.toolCallId,
          partial: clone.partial,
        };
      }),
    );
  }
}

async function offloadContentPart(
  part: ContentPart,
  blobsDir: string,
  threshold: number,
): Promise<void> {
  const record = part as unknown as Record<string, unknown>;
  for (const value of Object.values(record)) {
    const mediaObj = asMediaContainer(value);
    if (mediaObj === undefined) continue;

    const url = mediaObj.url;
    if (typeof url !== 'string') continue;

    const newUrl = await maybeOffloadString(url, blobsDir, threshold);
    if (newUrl !== url) {
      mediaObj.url = newUrl;
    }
  }
}

async function rehydrateContentPart(part: ContentPart, blobsDir: string): Promise<void> {
  const record = part as unknown as Record<string, unknown>;
  for (const value of Object.values(record)) {
    const mediaObj = asMediaContainer(value);
    if (mediaObj === undefined) continue;

    const url = mediaObj.url;
    if (typeof url !== 'string' || !isBlobRef(url)) continue;

    const newUrl = await rehydrateBlobRefUrl(url, blobsDir);
    mediaObj.url = newUrl ?? MISSING_MEDIA_PLACEHOLDER;
  }
}

function downgradeMissingMedia(part: ContentPart): ContentPart {
  const record = part as unknown as Record<string, unknown>;
  for (const value of Object.values(record)) {
    const mediaObj = asMediaContainer(value);
    if (mediaObj === undefined) continue;
    if (mediaObj.url === MISSING_MEDIA_PLACEHOLDER) {
      return { type: 'text', text: MISSING_MEDIA_PLACEHOLDER };
    }
  }
  return part;
}

async function maybeOffloadString(
  value: string,
  blobsDir: string,
  threshold: number,
): Promise<string> {
  if (value.startsWith(BLOBREF_PROTOCOL)) {
    return value;
  }
  const match = DATA_URI_HEADER_RE.exec(value);
  if (match === null) {
    return value;
  }
  const mimeType = match[1]!;
  const payload = value.slice(match[0].length);
  if (payload.length < threshold) {
    return value;
  }
  return writeBlob(blobsDir, mimeType, payload);
}

async function rehydrateBlobRefUrl(url: string, blobsDir: string): Promise<string | undefined> {
  const rest = url.slice(BLOBREF_PROTOCOL.length);
  const semiIdx = rest.indexOf(';');
  if (semiIdx === -1) {
    return undefined;
  }
  const mimeType = rest.slice(0, semiIdx);
  const hash = rest.slice(semiIdx + 1);
  if (hash.length === 0) {
    return undefined;
  }
  const payload = await readFile(join(blobsDir, hash), 'utf8').catch(() => undefined);
  if (payload === undefined) {
    return undefined;
  }
  return `data:${mimeType};base64,${payload}`;
}

async function writeBlob(
  blobsDir: string,
  mimeType: string,
  base64Payload: string,
): Promise<string> {
  await mkdir(blobsDir, { recursive: true, mode: 0o700 });
  const hash = createHash('sha256').update(base64Payload, 'utf8').digest('hex');
  const blobPath = join(blobsDir, hash);
  try {
    const fh = await open(blobPath, 'wx');
    try {
      await fh.writeFile(base64Payload, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EEXIST means the identical payload was already written; deduplication.
    if (code !== 'EEXIST') throw error;
  }
  return `${BLOBREF_PROTOCOL}${mimeType};${hash}`;
}

function asMediaContainer(value: unknown): { url: unknown } | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  return 'url' in obj ? (obj as { url: unknown }) : undefined;
}

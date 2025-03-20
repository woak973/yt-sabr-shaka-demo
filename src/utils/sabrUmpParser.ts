import type { Part } from 'googlevideo';
import { GoogleVideo, PART, Protos } from 'googlevideo';
import shaka from 'shaka-player/dist/shaka-player.ui';

import { cacheSegment } from './cacheHelper';
import type { SabrStreamingContext } from './shakaHttpPlugin';
import { HttpFetchPlugin } from './shakaHttpPlugin';
import { fromFormat, fromMediaHeader } from './formatKeyUtils';

export interface Segment {
  headerId?: number;
  mediaHeader: Protos.MediaHeader;
  complete?: boolean;
  data: Uint8Array<ArrayBuffer>;
}

export class SabrUmpParser {
  private partialPart?: Part;
  private mainSegments: Segment[] = [];
  private formatInitMetadata: Protos.FormatInitializationMetadata[] = [];
  private playbackCookie?: Protos.PlaybackCookie;
  private targetHeaderId?: number;

  constructor(
    private response: Response,
    private decodedStreamingContext: SabrStreamingContext,
    private uri: string,
    private requestType: shaka.net.NetworkingEngine.RequestType,
    private abortController: AbortController
  ) { }

  async parse(): Promise<shaka.extern.Response> {
    return new Promise((resolve) => {
      const reader = this.response.clone().body!.getReader();

      new ReadableStream({
        start: (controller) => this.handleStreamStart(controller, reader, resolve)
      });
    });
  }

  private async handleStreamStart(
    controller: ReadableStreamDefaultController,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    resolve: (value: shaka.extern.Response) => void
  ) {
    const push = async () => {
      try {
        const readObj = await reader.read();

        if (!readObj.done) {
          const value = this.handlePartialData(readObj.value);
          this.processUmpData(value, resolve, controller);
        }

        if (readObj.done) {
          controller.close();
        } else {
          controller.enqueue(readObj.value);
          push();
        }
      } catch {
        /** no-op */
      }
    };
    push();
  }

  private handlePartialData(value: Uint8Array): Uint8Array {
    if (this.partialPart && this.partialPart.data.getLength()) {
      const newValue = new Uint8Array(this.partialPart.data.getLength() + value.length);
      newValue.set(this.partialPart.data.chunks[0]);
      newValue.set(value, this.partialPart.data.getLength());
      this.partialPart = undefined;
      return newValue;
    }
    return value;
  }

  private processUmpData(
    value: Uint8Array,
    resolve: (value: shaka.extern.Response) => void,
    controller: ReadableStreamDefaultController
  ) {
    const ump = new GoogleVideo.UMP(new GoogleVideo.ChunkedDataBuffer([ value ]));

    const partialPart = ump.parse((part: Part) => {
      switch (part.type) {
        case PART.FORMAT_INITIALIZATION_METADATA:
          this.handleFormatInitMetadata(part);
          break;
        case PART.NEXT_REQUEST_POLICY:
          this.handleNextRequestPolicy(part);
          break;
        case PART.MEDIA_HEADER:
          this.handleMediaHeader(part);
          break;
        case PART.MEDIA:
          this.handleMedia(part);
          break;
        case PART.MEDIA_END:
          this.handleMediaEnd(part, resolve, controller);
          break;
        case PART.SABR_ERROR:
          this.handleSabrError(part, resolve, controller);
          break;
        case PART.STREAM_PROTECTION_STATUS:
          this.handleStreamProtectionStatus(part, resolve, controller);
          break;
        case PART.SABR_REDIRECT:
          // @TODO: Handle redirects. Quite rare with SABR.
          break;
        default:
      }
    });

    if (partialPart) {
      this.partialPart = partialPart;
    }
  }

  private handleFormatInitMetadata(part: Part) {
    const formatInitMetadata = Protos.FormatInitializationMetadata.decode(part.data.chunks[0]);
    this.formatInitMetadata.push(formatInitMetadata);
  }
  private handleNextRequestPolicy(part: Part) {
    const nextRequestPolicy = Protos.NextRequestPolicy.decode(part.data.chunks[0]);
    if (this.decodedStreamingContext.format?.has_video) {
      this.playbackCookie = nextRequestPolicy.playbackCookie;
    }
  }
  private handleMediaHeader(part: Part) {
    const mediaHeader = Protos.MediaHeader.decode(part.data.chunks[0]);
    const formatKey = fromFormat(this.decodedStreamingContext.format);
    const segmentFormatKey = fromMediaHeader(mediaHeader);

    if (!this.decodedStreamingContext.isSABR || segmentFormatKey === formatKey) {
      if (!this.targetHeaderId)
        this.targetHeaderId = mediaHeader.headerId;

      this.mainSegments.push({
        headerId: mediaHeader.headerId,
        mediaHeader: mediaHeader,
        data: new Uint8Array()
      });
    }
  }
  private handleMedia(part: Part) {
    const headerId = part.data.getUint8(0);
    const chunk = part.data.split(1).remainingBuffer.chunks[0];
    const targetSegment = this.mainSegments.find((segment) => segment.headerId === headerId);

    if (targetSegment) {
      const newData = new Uint8Array(targetSegment.data.length + chunk.length);
      newData.set(targetSegment.data);
      newData.set(chunk, targetSegment.data.length);
      targetSegment.data = newData;
    }
  }
  private handleMediaEnd(part: Part, resolve: (value: shaka.extern.Response) => void, controller: ReadableStreamDefaultController) {
    const headerId = part.data.getUint8(0);
    const targetSegment = this.mainSegments.find((segment) => segment.headerId === headerId);

    if (targetSegment && targetSegment.headerId === this.targetHeaderId) {
      const headers = HttpFetchPlugin.headersToGenericObject_(this.response.headers);

      if (this.decodedStreamingContext) {
        this.decodedStreamingContext.streamInfo = {
          ...this.decodedStreamingContext.streamInfo,
          playbackCookie: this.playbackCookie,
          formatInitMetadata: this.formatInitMetadata,
          mediaHeader: targetSegment.mediaHeader
        };

        headers['X-Streaming-Context'] = btoa(JSON.stringify(this.decodedStreamingContext));
      }

      let arrayBuffer: Uint8Array;

      // Why cache the init segment? Well, SABR responses are still a bit larger than usual - caching the init segment
      // helps reduce the delay when switching between different qualities or initializing a new stream.
      if (this.decodedStreamingContext.isInit && this.decodedStreamingContext.format && this.decodedStreamingContext.byteRange) {
        cacheSegment(targetSegment, this.decodedStreamingContext.format);
        arrayBuffer = targetSegment.data.slice(this.decodedStreamingContext.byteRange.start, this.decodedStreamingContext.byteRange.end + 1);
      } else {
        arrayBuffer = targetSegment.data;
      }

      resolve(HttpFetchPlugin.makeResponse(headers, arrayBuffer, this.response.status, this.uri, this.response.url, this.requestType));

      controller.close();
      this.abortController.abort();
    }
  }
  private handleSabrError(part: Part, resolve: (value: shaka.extern.Response) => void, controller: ReadableStreamDefaultController) {
    const sabrError = Protos.SabrError.decode(part.data.chunks[0]);
    const error = new shaka.util.Error(shaka.util.Error.Severity.RECOVERABLE, shaka.util.Error.Category.NETWORK, shaka.util.Error.Code.HTTP_ERROR, 'SABR Error', sabrError);
    const headers = HttpFetchPlugin.headersToGenericObject_(this.response.headers);

    if (this.decodedStreamingContext) {
      this.decodedStreamingContext.error = { sabrError };
      headers['X-Streaming-Context'] = btoa(JSON.stringify(this.decodedStreamingContext));
    }

    resolve(HttpFetchPlugin.makeResponse(headers, new ArrayBuffer(), this.response.status, this.uri, this.response.url, this.requestType));

    // Close the stream and abort the request.
    controller.close();
    this.abortController.abort();

    throw error;
  }
  private handleStreamProtectionStatus(part: Part, resolve: (value: shaka.extern.Response) => void, controller: ReadableStreamDefaultController) {
    const streamProtectionStatus = Protos.StreamProtectionStatus.decode(part.data.chunks[0]);
    const headers = HttpFetchPlugin.headersToGenericObject_(this.response.headers);
    const error = new shaka.util.Error(shaka.util.Error.Severity.RECOVERABLE, shaka.util.Error.Category.NETWORK, shaka.util.Error.Code.HTTP_ERROR, 'Stream Protection Status', streamProtectionStatus);

    if (this.decodedStreamingContext) {
      this.decodedStreamingContext.streamInfo = {
        ...this.decodedStreamingContext.streamInfo,
        streamProtectionStatus
      };
      headers['X-Streaming-Context'] = btoa(JSON.stringify(this.decodedStreamingContext));
    }

    if (streamProtectionStatus.status === 3) {
      resolve(HttpFetchPlugin.makeResponse(headers, new ArrayBuffer(), this.response.status, this.uri, this.response.url, this.requestType));

      // Close the stream and abort the request.
      controller.close();
      this.abortController.abort();

      throw error;
    }
  }
}
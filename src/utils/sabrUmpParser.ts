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
    const reader = this.response.clone().body!.getReader();

    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        // If we got here, we read the whole stream but there was no data; it means we must follow this redirect.
        if (this.decodedStreamingContext.isSABR && this.decodedStreamingContext.streamInfo?.redirect) {
          const headers = HttpFetchPlugin.headersToGenericObject_(this.response.headers);
          headers['X-Streaming-Context'] = btoa(JSON.stringify(this.decodedStreamingContext));
          return HttpFetchPlugin.makeResponse(headers, new ArrayBuffer(), this.response.status, this.uri, this.response.url, this.requestType);
        }
        break;
      }

      const processedValue = this.handlePartialData(value);
      const result = await this.processUmpData(processedValue);

      if (result) {
        // Throw any server error we got.
        if (!result.data.byteLength && (this.decodedStreamingContext.error || this.decodedStreamingContext.streamInfo?.streamProtectionStatus?.status === 3)) {   
          throw new shaka.util.Error(
            shaka.util.Error.Severity.RECOVERABLE, 
            shaka.util.Error.Category.NETWORK, 
            shaka.util.Error.Code.HTTP_ERROR, 
            'Server streaming error',
            { info: this.decodedStreamingContext }
          );
        }
        
        return result;
      }

      if (this.abortController.signal.aborted) {
        break;
      }
    }

    // Throw a recoverable error if we get here with no result (this should not happen).
    throw new shaka.util.Error(
      shaka.util.Error.Severity.RECOVERABLE,
      shaka.util.Error.Category.NETWORK,
      shaka.util.Error.Code.HTTP_ERROR,
      'Coundn\'t read any data from the stream',
    );
  }

  private handlePartialData(value: Uint8Array): Uint8Array {
    if (this.partialPart && this.partialPart.data.getLength()) {
      const newValue = new Uint8Array(this.partialPart.data.getLength() + value.byteLength);
      newValue.set(this.partialPart.data.chunks[0]);
      newValue.set(value, this.partialPart.data.getLength());
      this.partialPart = undefined;
      return newValue;
    }
    return value;
  }

  private processUmpData(value: Uint8Array): Promise<shaka.extern.Response | undefined> {
    return new Promise((resolve) => {
      const ump = new GoogleVideo.UMP(new GoogleVideo.ChunkedDataBuffer([ value ]));
      
      this.partialPart = ump.parse((part: Part) => {
        let result: shaka.extern.Response | undefined;

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
            result = this.handleMediaEnd(part);
            break;
          case PART.SABR_ERROR:
            result = this.handleSabrError(part);
            break;
          case PART.STREAM_PROTECTION_STATUS:
            result = this.handleStreamProtectionStatus(part);
            break;
          case PART.SABR_REDIRECT:
            result = this.handleSabrRedirect(part);
            break;
          default:
        }

        if (result) {
          resolve(result);
        }
      });

      resolve(undefined);
    });
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
    const buffer = part.data.split(1).remainingBuffer;
    const targetSegment = this.mainSegments.find((segment) => segment.headerId === headerId);

    if (targetSegment) {
      const newData = new Uint8Array(targetSegment.data.byteLength + buffer.getLength());
      newData.set(targetSegment.data);
      newData.set(buffer.chunks[0], targetSegment.data.byteLength);
      targetSegment.data = newData;
    }
  }

  private handleMediaEnd(part: Part) {
    const headerId = part.data.getUint8(0);
    const targetSegment = this.mainSegments.find((segment) => segment.headerId === headerId);

    if (targetSegment && targetSegment.headerId === this.targetHeaderId) {
      const headers = HttpFetchPlugin.headersToGenericObject_(this.response.headers);

      if (this.decodedStreamingContext) {
        this.decodedStreamingContext.streamInfo = {
          ...this.decodedStreamingContext.streamInfo,
          playbackCookie: this.playbackCookie,
          formatInitMetadata: this.formatInitMetadata,
          mediaHeader: targetSegment.mediaHeader.isInitSeg ? undefined : targetSegment.mediaHeader
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

      // We got what we wanted; close the stream and abort the request.
      this.abortController.abort();
      return HttpFetchPlugin.makeResponse(headers, arrayBuffer, this.response.status, this.uri, this.response.url, this.requestType);
    } 
  }

  private handleSabrError(part: Part) {
    const sabrError = Protos.SabrError.decode(part.data.chunks[0]);
    const headers = HttpFetchPlugin.headersToGenericObject_(this.response.headers);

    if (this.decodedStreamingContext) {
      this.decodedStreamingContext.error = { sabrError };
      headers['X-Streaming-Context'] = btoa(JSON.stringify(this.decodedStreamingContext));
    }

    this.abortController.abort();
    return HttpFetchPlugin.makeResponse(headers, new ArrayBuffer(), this.response.status, this.uri, this.response.url, this.requestType);
  }

  private handleStreamProtectionStatus(part: Part) {
    const streamProtectionStatus = Protos.StreamProtectionStatus.decode(part.data.chunks[0]);
    const headers = HttpFetchPlugin.headersToGenericObject_(this.response.headers);

    if (this.decodedStreamingContext) {
      this.decodedStreamingContext.streamInfo = {
        ...this.decodedStreamingContext.streamInfo,
        streamProtectionStatus
      };
      headers['X-Streaming-Context'] = btoa(JSON.stringify(this.decodedStreamingContext));
    }

    if (streamProtectionStatus.status === 3) {
      this.abortController.abort();
      return HttpFetchPlugin.makeResponse(headers, new ArrayBuffer(), this.response.status, this.uri, this.response.url, this.requestType);
    } 
  }

  private handleSabrRedirect(part: Part) {
    const redirect = Protos.SabrRedirect.decode(part.data.chunks[0]);
    const headers = HttpFetchPlugin.headersToGenericObject_(this.response.headers);

    if (this.decodedStreamingContext) {
      this.decodedStreamingContext.streamInfo = {
        ...this.decodedStreamingContext.streamInfo,
        redirect
      };
      headers['X-Streaming-Context'] = btoa(JSON.stringify(this.decodedStreamingContext));
    }

    // With pure UMP, redirects should be followed immediately.
    if (this.decodedStreamingContext.isUMP && !this.decodedStreamingContext.isSABR) {
      this.abortController.abort();
      return HttpFetchPlugin.makeResponse(headers, new ArrayBuffer(), this.response.status, this.uri, this.response.url, this.requestType);
    } 
  }
}
<style scoped>
.video-player {
  display: flex;
  background-color: #202020;
  aspect-ratio: 16 / 9;
  width: 100%;
}

video {
  width: 100%;
  height: 100%;
  aspect-ratio: 16 / 9;
  background-color: black;
}

.controls {
  display: flex;
  gap: 1rem;
  padding: 1rem;
  background: #202020;
  color: white;
}

.controls label {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
}

.controls label.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.controls label.disabled input {
  cursor: not-allowed;
}
</style>

<template>
  <div>
    <div class="controls">
      <label :class="{ disabled: flags.requestIdempotent }">
        <input v-model="flags.useUmp" :disabled="flags.requestIdempotent" type="checkbox" @change="handleFlagChange">
        Enable UMP
      </label>
      <label :class="{ disabled: !flags.useUmp || flags.isLiveContent || flags.isPostLiveDVR }">
        <input v-model="flags.useSabr" :disabled="!flags.useUmp || flags.isLiveContent || flags.isPostLiveDVR"
               type="checkbox"
               @change="handleFlagChange">
        Use SABR stream
      </label>
      <label :class="{ disabled: flags.useSabr || flags.requestIdempotent }">
        <input v-model="flags.postEmptyBody" :disabled="flags.useSabr || flags.requestIdempotent" type="checkbox"
               @change="handleFlagChange">
        Send POST with empty body
      </label>
      <label :class="{ disabled: flags.useSabr || flags.postEmptyBody || flags.useUmp }">
        <input v-model="flags.requestIdempotent" :disabled="flags.useSabr || flags.postEmptyBody || flags.useUmp"
               type="checkbox" @change="handleFlagChange">
        Use GET with range header
      </label>
    </div>
    <div ref="shakaContainer" class="video-player">
      <video ref="videoElement" autoplay></video>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { onMounted, onUnmounted, reactive, ref } from 'vue';

import shaka from 'shaka-player/dist/shaka-player.ui';
import 'shaka-player/dist/controls.css';

import { HttpFetchPlugin, SabrStreamingContext } from '../utils/shakaHttpPlugin';
import { fromFormat, fromFormatInitializationMetadata, fromMediaHeader } from '../utils/formatKeyUtils';
import { useInnertube } from '../composables/useInnertube';
import { botguardService } from '../services/botguard';

import { base64ToU8 } from 'bgutils-js';
import { Constants, Misc, Utils, YT, YTNodes } from 'youtubei.js/web';
import { Protos } from 'googlevideo';

shaka.net.NetworkingEngine.registerScheme('http', HttpFetchPlugin.parse, shaka.net.NetworkingEngine.PluginPriority.PREFERRED);
shaka.net.NetworkingEngine.registerScheme('https', HttpFetchPlugin.parse, shaka.net.NetworkingEngine.PluginPriority.PREFERRED);

const getInnertube = useInnertube();
const videoElement = ref<HTMLVideoElement | null>(null);
const shakaContainer = ref<HTMLElement | null>(null);

const { videoId } = defineProps<{
  videoId: string;
}>();

const initializedFormats = new Map<string, {
  lastSegmentMetadata?: {
    formatId: Protos.FormatId;
    startTimeMs: number;
    startSequenceNumber: number;
    endSequenceNumber: number;
    durationMs: number;
  };
  formatInitializationMetadata: Protos.FormatInitializationMetadata;
}>();

const flags = reactive({
  // Enables the UMP protocol.
  useUmp: true,
  // If true, the SABR stream will be used. Note that UMP must be enabled for this to work.
  useSabr: true,
  // If true, segment requests will be sent as POST requests with an empty body.
  postEmptyBody: false,
  // If true, segment requests will be sent as GET requests with a range header.
  requestIdempotent: false,
  // Content that should not use SABR.
  isLiveContent: false,
  isPostLiveDVR: false
});

let player: shaka.Player | null = null;
let shakaUi: shaka.ui.Overlay | null = null;
let currentTime = 0;
let isLive = false;
let isPostLiveDVR = false;
let formatList: Misc.Format[] = [];
let videoPlaybackUstreamerConfig: string | undefined;
let drmParams: string | undefined;

let sessionPoToken: string | undefined;
let coldStartToken: string | undefined;
let sessionPoTokenContentBinding: string | undefined;
let sessionPoTokenCreationLock = false;

let lastRequestMs = 0;
let lastSeekMs = 0;
let lastManualFormatSelectionMs = 0;
let lastActionMs = 0;
let lastPlaybackCookie: Protos.PlaybackCookie | undefined;

let videoElementResizeObserver: ResizeObserver | undefined;
let clientViewportHeight = videoElement.value?.clientHeight || 0;
let clientViewportWidth = videoElement.value?.clientWidth || 0;

const clientPlaybackNonce = Utils.generateRandomString(12);
const sessionId = Array.from(Array(16), () => Math.floor(Math.random() * 36).toString(36)).join('');

const handleFlagChange = async () => {
  console.info('[Player]', 'Flags changed. Clearing state...');

  if (flags.requestIdempotent) {
    flags.useUmp = false;
    flags.useSabr = false;
  } else if (flags.useUmp) {
    flags.requestIdempotent = false;
  }

  // If UMP is disabled, also disable SABR.
  if (!flags.useUmp && flags.useSabr) {
    flags.useSabr = false;
  }

  if (flags.useSabr) {
    flags.postEmptyBody = false;
    flags.requestIdempotent = false;
  }

  if (flags.postEmptyBody) {
    flags.requestIdempotent = false;
  } else if (flags.requestIdempotent) {
    flags.postEmptyBody = false;
  }

  if (!videoElement.value || !player) return;

  // Store current playback position (just for convenience)
  currentTime = videoElement.value.currentTime;

  // Clear state
  HttpFetchPlugin.cacheManager.clearCache();
  initializedFormats.clear();
  formatList.length = 0;
  lastPlaybackCookie = undefined;

  await initializePlayer();
};

async function initializePlayer() {
  const innertube = await getInnertube();

  if (!innertube) return;
  if (!videoElement.value) return;

  sessionPoTokenContentBinding = innertube.session.context.client.visitorData;

  try {
    if (player) {
      await player.destroy();
    }

    if (shakaUi) {
      await shakaUi.destroy();
    }

    player = new shaka.Player();
    player.configure({
      abr: {
        enabled: true,
        restrictions: {
          maxWidth: 1920,
          maxHeight: 1080
        }
      },
      streaming: {
        bufferingGoal: 120,
        rebufferingGoal: 0.001,
        bufferBehind: 120,
        retryParameters: {
          maxAttempts: 30,
          baseDelay: 1500,
          backoffFactor: 2.5,
          fuzzFactor: 0.7,
          timeout: 40000
        },
        stallThreshold: 2,
        stallSkip: 0.5,
      },
    });

    await setupRequestFilters();

    player.configure('preferredAudioLanguage', 'en-US');

    player.addEventListener('variantchanged', (event) => {
      // Technically, all variant changes here are manual, given we don't handle ABR updates from the server.
      if (event.type !== 'variant') {
        lastManualFormatSelectionMs = Date.now();
      }

      lastActionMs = Date.now();
    });

    await player.attach(videoElement.value);

    shakaUi = new shaka.ui.Overlay(
      player,
      shakaContainer.value!,
      videoElement.value
    );

    const watchEndpoint = new YTNodes.NavigationEndpoint({ watchEndpoint: { videoId } });

    const extraArgs: Record<string, any> = {
      playbackContext: {
        contentPlaybackContext: {
          vis: 0,
          splay: false,
          lactMilliseconds: '-1',
          signatureTimestamp: innertube.session.player?.sts
        }
      },
      contentCheckOk: true,
      racyCheckOk: true
    };

    const rawResponse = await watchEndpoint.call(innertube.actions, { ...extraArgs, parse: false });
    const videoInfo = new YT.VideoInfo([ rawResponse ], innertube.actions, clientPlaybackNonce);

    isLive = !!videoInfo.basic_info.is_live;
    isPostLiveDVR = !!videoInfo.basic_info.is_post_live_dvr;

    if (isLive) {
      flags.useSabr = false;
      flags.isLiveContent = true;
    }

    if (isPostLiveDVR) {
      flags.useSabr = false;
      flags.isPostLiveDVR = true;
    }

    if (rawResponse.data.streamingData && (rawResponse.data.streamingData as any).drmParams) {
      drmParams = (rawResponse.data.streamingData as any).drmParams;
      player.configure({
        drm: {
          servers: {
            'com.widevine.alpha': 'https://www.youtube.com/youtubei/v1/player/get_drm_license?alt=json'
          }
        }
      });
    }

    videoPlaybackUstreamerConfig = videoInfo.page[0].player_config?.media_common_config.media_ustreamer_request_config?.video_playback_ustreamer_config;

    // Modify adaptive formats to use the SABR stream.
    if (videoInfo.streaming_data && flags.useUmp && flags.useSabr && !flags.requestIdempotent && !flags.postEmptyBody) {
      formatList = videoInfo.streaming_data.adaptive_formats.map((format) => {
        const formatKey = fromFormat(format) || '';
        format.url = `${innertube.session.player?.decipher(videoInfo.streaming_data?.server_abr_streaming_url)}&___key=${formatKey}`;
        format.signature_cipher = undefined;
        format.decipher = () => format.url || '';
        return format;
      });
    }

    let manifestUri: string | undefined;

    if (videoInfo.streaming_data) {
      if (isLive) {
        manifestUri = videoInfo.streaming_data.dash_manifest_url ?
          (`${videoInfo.streaming_data.dash_manifest_url}/mpd_version/7`) :
          videoInfo.streaming_data.hls_manifest_url;
      } else if (videoInfo.streaming_data.dash_manifest_url && isPostLiveDVR) {
        manifestUri = videoInfo.streaming_data.hls_manifest_url ?
          videoInfo.streaming_data.hls_manifest_url : // HLS is preferred for DVR streams.
          (`${videoInfo.streaming_data.dash_manifest_url}/mpd_version/7`);
      } else {
        manifestUri = `data:application/dash+xml;base64,${btoa(await videoInfo.toDash(undefined, undefined, { captions_format: 'vtt' }))}`;
      }
    }

    if (!manifestUri) {
      console.error('Could not find a valid manifest URI.');
      return;
    }

    await player.load(manifestUri);

    if (currentTime > 0) {
      videoElement.value.currentTime = currentTime;
    }
  } catch (error) {
    console.error('Error loading video:', error);
  }
}

async function mintSessionPoToken() {
  if (sessionPoTokenContentBinding && !sessionPoTokenCreationLock) {
    sessionPoTokenCreationLock = true;

    coldStartToken = botguardService.mintColdStartToken(sessionPoTokenContentBinding);
    console.info('[Player]', `Cold start token created: ${coldStartToken} (Content binding: ${decodeURIComponent(sessionPoTokenContentBinding)})`);

    try {
      if (!botguardService.isInitialized())
        await botguardService.reinit();

      if (botguardService.integrityTokenBasedMinter)
        sessionPoToken = await botguardService.integrityTokenBasedMinter.mintAsWebsafeString(decodeURIComponent(sessionPoTokenContentBinding));
    } catch (err) {
      console.error('[Player]', 'Error minting session PO token', err);
    } finally {
      sessionPoTokenCreationLock = false;
    }

    if (sessionPoToken)
      console.info('[Player]', `Session PO token created: ${sessionPoToken} (Content binding: ${decodeURIComponent(sessionPoTokenContentBinding)})`);
  }
}

async function setupRequestFilters() {
  const innertube = await getInnertube();
  const networkingEngine = player?.getNetworkingEngine();

  if (!networkingEngine) return;

  networkingEngine.registerRequestFilter(async (type, request, context) => {
    if (!player)
      return;

    const uri = request.uris[0];
    const url = new URL(uri);
    const headers = request.headers;

    // Modify the request to use our proxy for Google Video requests.
    if ((url.host.endsWith('.googlevideo.com') || url.href.includes('drm'))) {
      url.searchParams.set('__host', url.host);
      url.host = 'localhost';
      url.port = '8080';
      url.protocol = 'http';
    }

    if (type === shaka.net.NetworkingEngine.RequestType.SEGMENT && url.pathname.includes('videoplayback')) {
      if (!sessionPoToken)
        mintSessionPoToken().then();

      const isUmp = (url.searchParams.get('ump') === '1' || flags.useUmp) && !flags.requestIdempotent;
      const isSabr = (url.searchParams.get('sabr') === '1' || flags.useSabr) && flags.useUmp && !flags.postEmptyBody && !flags.requestIdempotent;

      if (isSabr) {
        const currentFormat = formatList.find((format) => fromFormat(format) === url.searchParams.get('___key') || '');

        if (!videoPlaybackUstreamerConfig)
          throw new Error('Ustreamer config not found.');

        if (!currentFormat)
          throw new Error('No format found for SABR request.');

        if (!videoElement.value)
          throw new Error('No video element found.');

        const activeVariant = player.getVariantTracks().find((track) =>
          (currentFormat.has_video ? track.originalVideoId : track.originalAudioId) === currentFormat.itag.toString() &&
          (currentFormat.has_video ? track.videoBandwidth : track.audioBandwidth) === currentFormat.bitrate
        );

        const videoFormat = formatList.find((format) => format.itag.toString() === activeVariant?.originalVideoId && format.bitrate === activeVariant?.videoBandwidth);
        const audioFormat = formatList.find((format) => format.itag.toString() === activeVariant?.originalAudioId && format.bitrate === activeVariant?.audioBandwidth);

        let videoFormatId: Protos.FormatId | undefined;
        let audioFormatId: Protos.FormatId | undefined;

        if (videoFormat && audioFormat) {
          videoFormatId = {
            itag: videoFormat?.itag,
            lastModified: parseInt(videoFormat?.last_modified_ms),
            xtags: videoFormat?.xtags
          };

          audioFormatId = {
            itag: audioFormat?.itag,
            lastModified: parseInt(audioFormat?.last_modified_ms),
            xtags: audioFormat?.xtags
          };
        }

        const isInit = context ? !context.segment : true;
        const playbackCookie = lastPlaybackCookie ? Protos.PlaybackCookie.encode(lastPlaybackCookie).finish() : undefined;

        const playerStats = player.getStats();

        const videoPlaybackAbrRequest: Protos.VideoPlaybackAbrRequest = {
          clientAbrState: {
            playbackRate: player.getPlaybackRate(),
            playerTimeMs: Math.round((context?.segment?.getStartTime() ?? videoElement.value.currentTime) * 1000),
            elapsedWallTimeMs: Date.now() - lastRequestMs,
            timeSinceLastSeek: lastSeekMs === 0 ? 0 : Date.now() - lastSeekMs,
            timeSinceLastActionMs: lastActionMs === 0 ? 0 : Date.now() - lastActionMs,
            timeSinceLastManualFormatSelectionMs: lastManualFormatSelectionMs === 0 ? 0 : Date.now() - lastManualFormatSelectionMs,
            clientViewportIsFlexible: false,
            lastManualDirection: 0,
            bandwidthEstimate: Math.round(playerStats.estimatedBandwidth),
            drcEnabled: currentFormat.is_drc,
            enabledTrackTypesBitfield: currentFormat.has_audio ? 1 : 2,
            clientViewportHeight,
            clientViewportWidth
          },
          bufferedRanges: [],
          selectedFormatIds: [],
          selectedAudioFormatIds: [ audioFormatId || {} ],
          selectedVideoFormatIds: [ videoFormatId || {} ],
          videoPlaybackUstreamerConfig: base64ToU8(videoPlaybackUstreamerConfig),
          streamerContext: {
            poToken: base64ToU8(sessionPoToken ?? coldStartToken ?? ''),
            playbackCookie: playbackCookie,
            clientInfo: {
              clientName: parseInt(Constants.CLIENT_NAME_IDS.WEB),
              clientVersion: innertube.session.context.client.clientVersion,
              osName: 'Windows',
              osVersion: '10.0'
            },
            field5: [],
            field6: []
          },
          field1000: []
        };

        const currentFormatWidth = currentFormat.width;
        const currentFormatHeight = currentFormat.height;

        // Normalize the resolution.
        if (currentFormatWidth && currentFormatHeight) {
          let resolution = currentFormat.height;

          const aspectRatio = currentFormatWidth / currentFormatWidth;

          if (aspectRatio > (16 / 9)) {
            resolution = Math.round(currentFormatWidth * 9 / 16);
          }

          if (resolution && videoPlaybackAbrRequest.clientAbrState) {
            videoPlaybackAbrRequest.clientAbrState.stickyResolution = resolution;
            videoPlaybackAbrRequest.clientAbrState.lastManualSelectedResolution = resolution;
          }
        }

        if (!isInit) {
          // Add the currently/previously active formats to the list of buffered ranges and selected formats
          // so that the server doesn't send its init data again.
          const initializedFormatsArray = Array.from(initializedFormats.values());

          for (const initializedFormat of initializedFormatsArray) {
            if (initializedFormat.lastSegmentMetadata) {
              videoPlaybackAbrRequest.bufferedRanges.push({
                formatId: initializedFormat.lastSegmentMetadata.formatId,
                startSegmentIndex: initializedFormat.lastSegmentMetadata.startSequenceNumber,
                durationMs: initializedFormat.lastSegmentMetadata.durationMs,
                startTimeMs: 0,
                endSegmentIndex: initializedFormat.lastSegmentMetadata.endSequenceNumber
              });
            }
          }

          if (audioFormatId)
            videoPlaybackAbrRequest.selectedFormatIds.push(audioFormatId);

          if (videoFormatId)
            videoPlaybackAbrRequest.selectedFormatIds.push(videoFormatId);
        }

        request.body = Protos.VideoPlaybackAbrRequest.encode(videoPlaybackAbrRequest).finish();

        const byteRange = headers.Range ? {
          start: Number(headers.Range.split('=')[1].split('-')[0]),
          end: Number(headers.Range.split('=')[1].split('-')[1])
        } : null;

        const sabrStreamingContext = {
          byteRange,
          format: currentFormat,
          isInit,
          isUMP: true,
          isSABR: true,
          playerTimeMs: videoPlaybackAbrRequest.clientAbrState?.playerTimeMs
        };

        // @NOTE: Not a real header. See the http plugin code for more info.
        request.headers['X-Streaming-Context'] = btoa(JSON.stringify(sabrStreamingContext));
        delete headers.Range;
      } else if (isUmp) {
        if (!isLive && !isPostLiveDVR) {
          url.searchParams.set('ump', '1');
          url.searchParams.set('srfvp', '1');
          if (headers.Range) {
            url.searchParams.set('range', headers.Range?.split('=')[1]);
            delete headers.Range;
          }
        } else {
          url.pathname += '/ump/1';
          url.pathname += '/srfvp/1';
        }

        request.headers['X-Streaming-Context'] = btoa(JSON.stringify({
          isUMP: true,
          isSABR: false
        }));
      }

      if (!flags.requestIdempotent)
        request.method = 'POST';

      if (!isSabr) {
        if (!flags.postEmptyBody && request.method === 'POST') {
          request.body = new Uint8Array([ 120, 0 ]);
        }

        // Set Proof of Origin Token
        if (isLive || isPostLiveDVR) {
          url.pathname += '/pot/' + (sessionPoToken ?? coldStartToken ?? '');
        } else {
          if (sessionPoToken || coldStartToken)
            url.searchParams.set('pot', sessionPoToken ?? coldStartToken ?? '');
        }
      }
    } else if (type == shaka.net.NetworkingEngine.RequestType.LICENSE) {
      const innertube = await getInnertube();
      const wrapped = {} as Record<string, any>;
      wrapped.context = innertube.session.context;
      wrapped.cpn = clientPlaybackNonce;
      wrapped.drmParams = decodeURIComponent(drmParams || '');
      wrapped.drmSystem = 'DRM_SYSTEM_WIDEVINE';
      wrapped.drmVideoFeature = 'DRM_VIDEO_FEATURE_SDR';
      wrapped.licenseRequest = shaka.util.Uint8ArrayUtils.toBase64(request.body as ArrayBuffer | ArrayBufferView);
      wrapped.sessionId = sessionId;
      wrapped.videoId = videoId;
      request.body = shaka.util.StringUtils.toUTF8(JSON.stringify(wrapped));
    }

    request.uris[0] = url.toString();
  });

  networkingEngine.registerResponseFilter(async (type, response) => {
    if (type === shaka.net.NetworkingEngine.RequestType.SEGMENT) {
      const sabrStreamingContext = response.headers['X-Streaming-Context'];

      if (sabrStreamingContext) {
        const { streamInfo } = JSON.parse(atob(sabrStreamingContext)) as SabrStreamingContext;

        if (streamInfo) {
          const playbackCookie = streamInfo.playbackCookie;
          const streamProtectionStatus = streamInfo.streamProtectionStatus;
          const formatInitMetadata = streamInfo.formatInitMetadata || [];
          const mainSegmentMediaHeader = streamInfo.mediaHeader;

          if (playbackCookie)
            lastPlaybackCookie = streamInfo.playbackCookie;

          if (streamProtectionStatus && streamProtectionStatus.status === 3) {
            console.warn('[UMP] Attestation required.');
          }

          for (const metadata of formatInitMetadata) {
            const key = fromFormatInitializationMetadata(metadata);
            if (!initializedFormats.has(key)) {
              initializedFormats.set(key, {
                formatInitializationMetadata: metadata
              });
              console.log(`[SABR] Initialized format ${key}`);
            }
          }

          if (mainSegmentMediaHeader) {
            const formatKey = fromMediaHeader(mainSegmentMediaHeader);
            const initializedFormat = initializedFormats.get(formatKey);

            if (initializedFormat) {
              initializedFormat.lastSegmentMetadata = {
                formatId: mainSegmentMediaHeader.formatId!,
                startTimeMs: mainSegmentMediaHeader.startMs || 0,
                startSequenceNumber: mainSegmentMediaHeader.sequenceNumber || 1,
                endSequenceNumber: (mainSegmentMediaHeader.sequenceNumber || 1),
                durationMs: mainSegmentMediaHeader.durationMs || 0
              };
            }
          }
        }
      }
    } else if (type == shaka.net.NetworkingEngine.RequestType.LICENSE) {
      const wrappedString = shaka.util.StringUtils.fromUTF8(response.data);
      const wrapped = JSON.parse(wrappedString);
      const rawLicenseBase64 = wrapped.license;
      response.data = shaka.util.Uint8ArrayUtils.fromBase64(rawLicenseBase64);
    }
  });
}

onMounted(async () => {
  if (!videoElement.value) return;

  shaka.polyfill.installAll();

  if (!shaka.Player.isBrowserSupported()) {
    console.error('Browser not supported!');
    return;
  }

  videoElement.value.addEventListener('seeked', () => lastSeekMs = Date.now());

  videoElementResizeObserver = new ResizeObserver(() => {
    if (videoElement.value) {
      clientViewportHeight = videoElement.value.clientHeight;
      clientViewportWidth = videoElement.value.clientWidth;
    }
  });

  videoElementResizeObserver.observe(videoElement.value);


  await initializePlayer();
});

onUnmounted(() => {
  HttpFetchPlugin.cacheManager.clearCache();

  if (player) {
    player.destroy().then(() => {
      player = null;
    });
  }

  if (shakaUi) {
    shakaUi.destroy().then(() => {
      shakaUi = null;
    });
  }

  if (videoElement.value) {
    if (videoElementResizeObserver) {
      videoElementResizeObserver.disconnect();
      videoElementResizeObserver = undefined;
    }

    videoElement.value.src = '';
    videoElement.value.load();
  }

  formatList.length = 0;
  initializedFormats.clear();
  lastPlaybackCookie = undefined;
  sessionPoToken = undefined;
  sessionPoTokenContentBinding = undefined;
  sessionPoTokenCreationLock = false;
  coldStartToken = undefined;
  videoPlaybackUstreamerConfig = undefined;
  lastRequestMs = 0;
  lastSeekMs = 0;
  lastManualFormatSelectionMs = 0;
  lastActionMs = 0;
});
</script>
/**
 * cameraRecording.ts
 *
 * HomeKit Secure Video (HKSV) recording support for the Control4-local
 * Homebridge plugin.
 *
 *  - C4RecordingDelegate implements HAP's CameraRecordingDelegate: it feeds the
 *    accessory's recordings on motion by muxing the DVR's H.264 RTSP stream into
 *    a fragmented MP4 and yielding the fMP4 boxes as RecordingPackets.
 *  - buildRecordingOptions() produces the CameraRecordingOptions the platform
 *    passes to the CameraController (see WIRING.md).
 *  - A continuous "prebuffer" ffmpeg keeps the last few seconds of fMP4 in a ring
 *    so a clip includes the moments *before* the motion trigger.
 *
 * Design mirrors camera.ts: one ffmpeg per source, spawned with the same
 * conventions, and the file stays independent of the platform -- it is handed a
 * ResolvedCamera (from cameraResolver.ts) plus HAP and a logger, nothing more.
 *
 * Pi 3 note: prefer `-c:v copy` (stream-copy). The DVR stream is H.264 so the
 * only per-fragment work is remuxing; the single always-on prebuffer process is
 * cheap because it never decodes video. Audio is (re)encoded to AAC-LC because
 * HKSV mandates AAC and the DVR carries no (or non-AAC) audio; encoding one
 * mono AAC track is negligible. See WIRING.md for the CPU tradeoff of the
 * prebuffer vs. an on-demand re-open.
 *
 * NOTE: never log the RTSP/snapshot URL or credentials.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import type { Readable } from 'stream';

import type {
  CameraController,
  CameraRecordingConfiguration,
  CameraRecordingDelegate,
  CameraRecordingOptions,
  HAP,
  HDSProtocolSpecificErrorReason,
  Logger,
  RecordingPacket,
} from 'homebridge';
import {
  AudioBitrate,
  AudioRecordingCodecType,
  AudioRecordingSamplerate,
  H264Level,
  H264Profile,
  MediaContainerType,
} from 'homebridge';
// VideoCodecType is not re-exported as a value by homebridge; take it from
// hap-nodejs (a resolvable transitive dependency). VideoCodecType.H264 === 0.
import { VideoCodecType } from 'hap-nodejs';

import type { ResolvedCamera } from './cameraResolver';

/** ffmpeg path -- override via options if a bundled static build is preferred. */
const DEFAULT_FFMPEG = 'ffmpeg';

/**
 * Hard cap on a single recording so a stuck motion trigger can't stream
 * forever. HomeKit normally closes the stream (motion reset) long before this.
 * 0 disables the cap and relies solely on the controller closing the stream.
 */
const DEFAULT_MAX_RECORDING_MS = 30_000;

/** Prebuffer ring is trimmed to this many ms of fragments beyond prebufferLength. */
const RING_SLACK_MS = 2_000;

/** How long to wait before restarting a prebuffer ffmpeg that exited. */
const PREBUFFER_RESTART_MS = 1_000;

export interface C4RecordingDelegateOptions {
  /** Pretty name for logs. */
  displayName: string;
  /** URLs/flags from resolveCamera(). */
  resolved: ResolvedCamera;
  hap: HAP;
  log: Logger;
  /** Absolute path to an ffmpeg binary; defaults to `ffmpeg` on PATH. */
  ffmpegPath?: string;
  /**
   * Keep a continuous ffmpeg running so clips include pre-trigger video.
   * Defaults to true. Set false to re-open ffmpeg on each motion event instead
   * (zero idle CPU/RAM, but the clip starts ~at the trigger with no pre-roll).
   */
  prebuffer?: boolean;
  /** Hard cap for one recording in ms (0 = no cap). Defaults to 30000. */
  maxRecordingMs?: number;
  /**
   * Use the DVR's own audio track instead of a silent AAC track. Only enable if
   * the DVR publishes an audio stream; otherwise ffmpeg will fail to map it.
   * The audio is still transcoded to AAC-LC. Defaults to false (silent track).
   */
  recordDvrAudio?: boolean;
}

/** A single demuxed fMP4 media fragment (moof + mdat) plus arrival time. */
interface Fragment {
  data: Buffer;
  ts: number;
}

export class C4RecordingDelegate implements CameraRecordingDelegate {
  private readonly hap: HAP;
  private readonly log: Logger;
  private readonly displayName: string;
  private readonly resolved: ResolvedCamera;
  private readonly ffmpegPath: string;
  private readonly usePrebuffer: boolean;
  private readonly maxRecordingMs: number;
  private readonly recordDvrAudio: boolean;

  /**
   * Set by the platform after the CameraController is built, so the delegate can
   * read the RecordingAudioActive characteristic and honour it.
   */
  public controller?: CameraController;

  private recordingActive = false;
  private configuration?: CameraRecordingConfiguration;

  /** The always-on prebuffer session (when usePrebuffer); else per-request. */
  private session?: PrebufferSession;

  constructor(opts: C4RecordingDelegateOptions) {
    this.hap = opts.hap;
    this.log = opts.log;
    this.displayName = opts.displayName;
    this.resolved = opts.resolved;
    this.ffmpegPath = opts.ffmpegPath ?? DEFAULT_FFMPEG;
    this.usePrebuffer = opts.prebuffer ?? true;
    this.maxRecordingMs = opts.maxRecordingMs ?? DEFAULT_MAX_RECORDING_MS;
    this.recordDvrAudio = opts.recordDvrAudio ?? false;
  }

  // ---------------------------------------------------------------------------
  // Recording options (advertised to HomeKit)
  // ---------------------------------------------------------------------------

  /**
   * Build the CameraRecordingOptions HomeKit negotiates against. Tuned for a
   * Pi 3: a 4 s prebuffer, 4 s fragments, H.264 (stream-copied), AAC-LC mono.
   */
  buildRecordingOptions(): CameraRecordingOptions {
    return {
      prebufferLength: 4_000, // ms; HAP requires >= 4000
      mediaContainerConfiguration: {
        type: MediaContainerType.FRAGMENTED_MP4,
        fragmentLength: 4_000, // ms per fMP4 fragment
      },
      video: {
        type: VideoCodecType.H264,
        parameters: {
          profiles: [H264Profile.BASELINE, H264Profile.MAIN, H264Profile.HIGH],
          levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
        },
        // HKSV requires 1920x1080 and 1280x720 to be offered.
        resolutions: [
          [1920, 1080, 30],
          [1920, 1080, 15],
          [1280, 720, 30],
          [1280, 720, 15],
          [640, 480, 30],
          [640, 360, 30],
          [320, 240, 15],
        ],
      },
      audio: {
        // Only AAC-LC: ffmpeg's native `aac` encoder handles LC without the
        // (usually absent) nonfree libfdk_aac that AAC-ELD needs.
        codecs: [
          {
            type: AudioRecordingCodecType.AAC_LC,
            audioChannels: 1,
            bitrateMode: AudioBitrate.VARIABLE,
            samplerate: [
              AudioRecordingSamplerate.KHZ_32,
              AudioRecordingSamplerate.KHZ_24,
              AudioRecordingSamplerate.KHZ_16,
            ],
          },
        ],
      },
    };
  }

  // ---------------------------------------------------------------------------
  // CameraRecordingDelegate
  // ---------------------------------------------------------------------------

  updateRecordingActive(active: boolean): void {
    this.recordingActive = active;
    this.log.info(`[${this.displayName}] HKSV recording ${active ? 'enabled' : 'disabled'}`);
    if (active) {
      if (this.usePrebuffer) {
        this.ensurePrebufferSession();
      }
    } else if (this.usePrebuffer) {
      this.session?.stop();
      this.session = undefined;
    }
  }

  updateRecordingConfiguration(configuration: CameraRecordingConfiguration | undefined): void {
    this.configuration = configuration;
    if (configuration) {
      this.log.debug(
        `[${this.displayName}] HKSV config: ${configuration.videoCodec.resolution[0]}x` +
          `${configuration.videoCodec.resolution[1]}@${configuration.videoCodec.resolution[2]}, ` +
          `fragment ${configuration.mediaContainerConfiguration.fragmentLength}ms, ` +
          `prebuffer ${configuration.prebufferLength}ms`,
      );
      // Reconfigure the running prebuffer to match the negotiated fragment length.
      if (this.usePrebuffer && this.recordingActive) {
        this.ensurePrebufferSession(true);
      }
    }
  }

  /**
   * Stream the next recording event as fragmented MP4. The first yielded packet
   * is the initialization segment (ftyp + moov); every subsequent packet is one
   * moof + mdat fragment, each starting on a key frame.
   */
  async *handleRecordingStreamRequest(
    streamId: number,
    signal?: AbortSignal,
  ): AsyncGenerator<RecordingPacket> {
    const config = this.configuration;
    if (!config) {
      // HAP guarantees a selected configuration here, but stay defensive.
      throw new Error(`[${this.displayName}] recording requested without a selected configuration`);
    }

    // Use the always-on prebuffer, or spin up an on-demand session for this clip.
    const onDemand = !this.usePrebuffer || !this.session;
    const session = this.session ?? this.createSession(config);
    if (onDemand) {
      session.start();
    }

    this.log.info(`[${this.displayName}] HKSV recording stream ${streamId} starting`);

    const subscriber = session.subscribe();
    try {
      // 1) Initialization segment first (required).
      const init = await session.waitForInit(signal);
      if (signal?.aborted || init === undefined) {
        return;
      }
      yield { data: init, isLast: false };

      // 2) Prebuffered fragments, then live fragments, until the controller
      //    closes the stream (abort) or we hit the safety cap.
      const startTs = Date.now();
      for (;;) {
        if (signal?.aborted) {
          return; // controller closed the stream; HAP emits the close reason.
        }
        const fragment = await subscriber.next(signal);
        if (fragment === undefined) {
          return; // aborted or session ended
        }
        const overCap =
          this.maxRecordingMs > 0 && Date.now() - startTs >= this.maxRecordingMs;
        yield { data: fragment.data, isLast: overCap };
        if (overCap) {
          this.log.debug(`[${this.displayName}] recording ${streamId} hit max duration cap`);
          return;
        }
      }
    } finally {
      session.unsubscribe(subscriber);
      if (onDemand) {
        session.stop();
      }
      this.log.debug(`[${this.displayName}] HKSV recording stream ${streamId} generator finished`);
    }
  }

  closeRecordingStream(streamId: number, reason: HDSProtocolSpecificErrorReason | undefined): void {
    this.log.info(
      `[${this.displayName}] HKSV recording stream ${streamId} closed` +
        (reason === undefined ? '' : ` (reason ${String(reason)})`),
    );
    // The async generator observes the AbortSignal HAP passed in and returns on
    // its own; on-demand sessions are torn down in that generator's finally.
  }

  // ---------------------------------------------------------------------------
  // Prebuffer session management
  // ---------------------------------------------------------------------------

  private ensurePrebufferSession(restart = false): void {
    if (this.session && !restart) {
      return;
    }
    const config = this.configuration;
    if (!config) {
      // No negotiated config yet: start with defaults; reconfigured later.
      this.session?.stop();
      this.session = this.createSession(undefined);
      this.session.start();
      return;
    }
    this.session?.stop();
    this.session = this.createSession(config);
    this.session.start();
  }

  private createSession(config: CameraRecordingConfiguration | undefined): PrebufferSession {
    const source = this.resolved.rtspUrl ?? this.resolved.mjpegUrl;
    if (!source) {
      throw new Error(`[${this.displayName}] no stream URL available for recording`);
    }
    const prebufferMs = config?.prebufferLength ?? 4_000;
    const fragmentMs = config?.mediaContainerConfiguration.fragmentLength ?? 4_000;
    const args = this.buildRecordingFfmpegArgs(source, config, fragmentMs);
    return new PrebufferSession({
      ffmpegPath: this.ffmpegPath,
      args,
      prebufferMs,
      displayName: this.displayName,
      log: this.log,
    });
  }

  /** True when the user has not switched recording audio off in the Home app. */
  private audioEnabled(): boolean {
    try {
      const svc = this.controller?.recordingManagement?.operatingModeService;
      if (!svc) {
        return true;
      }
      const value = svc.getCharacteristic(this.hap.Characteristic.RecordingAudioActive).value;
      return value !== 0 && value !== false && value !== null;
    } catch {
      return true;
    }
  }

  private buildRecordingFfmpegArgs(
    source: string,
    config: CameraRecordingConfiguration | undefined,
    fragmentMs: number,
  ): string[] {
    const wantAudio = this.audioEnabled();
    const sampleRate = config ? samplerateHz(config.audioCodec.samplerate) : 32_000;
    const audioBitrateK = config?.audioCodec.bitrate ?? 24;
    const channels = config?.audioCodec.audioChannels ?? 1;

    const args: string[] = [
      '-hide_banner',
      '-loglevel', 'error',
      '-fflags', '+genpts',
      '-rtsp_transport', 'tcp',
      '-i', source,
    ];

    // Silent audio source when we are not pulling audio from the DVR.
    const useSilentAudio = wantAudio && !this.recordDvrAudio;
    if (useSilentAudio) {
      args.push('-f', 'lavfi', '-i', `anullsrc=channel_layout=mono:sample_rate=${sampleRate}`);
    }

    // --- Video ---------------------------------------------------------------
    args.push('-map', '0:v:0');
    if (this.resolved.needsTranscode) {
      // Fallback: force a GOP aligned to the fragment length so every fragment
      // starts on a key frame. Heavier -- avoid on a Pi 3 unless unavoidable.
      const fps = config?.videoCodec.resolution[2] ?? 30;
      const gop = Math.max(1, Math.round((fragmentMs / 1000) * fps));
      args.push(
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-pix_fmt', 'yuv420p',
        '-profile:v', 'high',
        '-g', String(gop),
        '-force_key_frames', `expr:gte(t,n_forced*${(fragmentMs / 1000).toFixed(3)})`,
      );
      if (config) {
        const [w, h] = config.videoCodec.resolution;
        args.push(
          '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
          '-b:v', `${config.videoCodec.parameters.bitRate}k`,
          '-maxrate', `${config.videoCodec.parameters.bitRate}k`,
          '-bufsize', `${config.videoCodec.parameters.bitRate * 2}k`,
        );
      }
    } else {
      // H.264 passthrough -- the cheap path. frag_keyframe (below) splits on the
      // DVR's own key frames, so the DVR GOP must be <= fragmentLength.
      args.push('-c:v', 'copy');
    }

    // --- Audio ---------------------------------------------------------------
    if (wantAudio) {
      if (this.recordDvrAudio) {
        args.push('-map', '0:a:0?');
      } else {
        args.push('-map', '1:a:0');
      }
      args.push(
        '-c:a', 'aac',
        '-profile:a', 'aac_low',
        '-ar', String(sampleRate),
        '-ac', String(channels),
        '-b:a', `${audioBitrateK}k`,
      );
    } else {
      args.push('-an');
    }

    // --- Fragmented MP4 to stdout --------------------------------------------
    args.push(
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-max_muxing_queue_size', '1024',
      'pipe:1',
    );
    return args;
  }
}

// -----------------------------------------------------------------------------
// Prebuffer session: one ffmpeg -> fMP4, init segment + ring of fragments,
// with fan-out to active recording subscribers.
// -----------------------------------------------------------------------------

interface PrebufferSessionOptions {
  ffmpegPath: string;
  args: string[];
  /** Milliseconds of pre-trigger fragments to retain in the ring. */
  prebufferMs: number;
  displayName: string;
  log: Logger;
}

/** Pull-based subscriber: drains prebuffered fragments, then live ones. */
class FragmentSubscriber {
  private readonly queue: Fragment[] = [];
  private wake?: () => void;
  private done = false;

  /** Seed the queue with a snapshot of the current prebuffer ring. */
  seed(fragments: Fragment[]): void {
    this.queue.push(...fragments);
  }

  push(fragment: Fragment): void {
    this.queue.push(fragment);
    this.wake?.();
    this.wake = undefined;
  }

  end(): void {
    this.done = true;
    this.wake?.();
    this.wake = undefined;
  }

  /** Resolve with the next fragment, or undefined when aborted / ended. */
  async next(signal?: AbortSignal): Promise<Fragment | undefined> {
    for (;;) {
      if (signal?.aborted) {
        return undefined;
      }
      const fragment = this.queue.shift();
      if (fragment) {
        return fragment;
      }
      if (this.done) {
        return undefined;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        if (signal) {
          signal.addEventListener('abort', () => resolve(), { once: true });
        }
      });
    }
  }
}

class PrebufferSession {
  private readonly opts: PrebufferSessionOptions;
  private proc?: ChildProcessWithoutNullStreams;
  private running = false;

  private initSegment?: Buffer;
  private readonly initWaiters: Array<(b: Buffer | undefined) => void> = [];
  private readonly ring: Fragment[] = [];
  private readonly subscribers = new Set<FragmentSubscriber>();
  private restartTimer?: NodeJS.Timeout;

  constructor(opts: PrebufferSessionOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.spawn();
  }

  stop(): void {
    this.running = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    if (this.proc) {
      try {
        this.proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      this.proc = undefined;
    }
    this.ring.length = 0;
    this.initSegment = undefined;
    for (const waiter of this.initWaiters.splice(0)) {
      waiter(undefined);
    }
    for (const sub of this.subscribers) {
      sub.end();
    }
    this.subscribers.clear();
  }

  subscribe(): FragmentSubscriber {
    const sub = new FragmentSubscriber();
    sub.seed(this.ring.slice()); // deliver the pre-trigger fragments first
    this.subscribers.add(sub);
    return sub;
  }

  unsubscribe(sub: FragmentSubscriber): void {
    this.subscribers.delete(sub);
    sub.end();
  }

  /** Resolve with the init segment, or undefined if aborted / session stopped. */
  waitForInit(signal?: AbortSignal): Promise<Buffer | undefined> {
    if (this.initSegment) {
      return Promise.resolve(this.initSegment);
    }
    return new Promise<Buffer | undefined>((resolve) => {
      const done = (b: Buffer | undefined): void => resolve(b);
      this.initWaiters.push(done);
      if (signal) {
        signal.addEventListener('abort', () => resolve(undefined), { once: true });
      }
    });
  }

  private spawn(): void {
    const { ffmpegPath, args, log, displayName } = this.opts;
    const proc = spawn(ffmpegPath, args, { env: process.env });
    this.proc = proc;

    proc.stderr.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      if (line) {
        log.debug(`[${displayName}] record ffmpeg: ${line}`);
      }
    });
    proc.on('error', (err) => {
      log.error(`[${displayName}] record ffmpeg spawn error: ${errMessage(err)}`);
    });
    proc.on('close', (code) => {
      if (this.proc === proc) {
        this.proc = undefined;
      }
      if (this.running) {
        log.debug(`[${displayName}] record ffmpeg exited (${String(code)}); restarting`);
        this.initSegment = undefined;
        this.ring.length = 0;
        this.restartTimer = setTimeout(() => {
          this.restartTimer = undefined;
          if (this.running) {
            this.spawn();
          }
        }, PREBUFFER_RESTART_MS);
        this.restartTimer.unref();
      }
    });

    this.consume(proc.stdout).catch((err: unknown) => {
      log.debug(`[${displayName}] record fMP4 parser ended: ${errMessage(err)}`);
    });
  }

  private async consume(stdout: Readable): Promise<void> {
    for await (const seg of parseFragmentedMp4(stdout)) {
      if (seg.kind === 'init') {
        this.initSegment = seg.data;
        for (const waiter of this.initWaiters.splice(0)) {
          waiter(seg.data);
        }
      } else {
        const fragment: Fragment = { data: seg.data, ts: Date.now() };
        this.ring.push(fragment);
        this.trimRing();
        for (const sub of this.subscribers) {
          sub.push(fragment);
        }
      }
    }
  }

  private trimRing(): void {
    const keepFrom = Date.now() - (this.opts.prebufferMs + RING_SLACK_MS);
    while (this.ring.length > 1 && this.ring[0].ts < keepFrom) {
      this.ring.shift();
    }
  }
}

// -----------------------------------------------------------------------------
// Fragmented-MP4 box parser
// -----------------------------------------------------------------------------

interface Mp4Segment {
  kind: 'init' | 'segment';
  data: Buffer;
}

/**
 * Parse an ffmpeg fragmented-MP4 byte stream into HKSV-shaped segments:
 *   - one 'init' segment (ftyp + moov), yielded first
 *   - one 'segment' (moof + mdat) per media fragment, each key-frame aligned
 */
async function* parseFragmentedMp4(stream: Readable): AsyncGenerator<Mp4Segment> {
  const reader = new BoxStreamReader(stream);
  let ftyp: Buffer | undefined;
  let moof: Buffer | undefined;

  for (;;) {
    const box = await reader.readBox();
    if (!box) {
      return;
    }
    switch (box.type) {
      case 'ftyp':
        ftyp = box.data;
        break;
      case 'moov':
        yield { kind: 'init', data: ftyp ? Buffer.concat([ftyp, box.data]) : box.data };
        ftyp = undefined;
        break;
      case 'moof':
        moof = box.data;
        break;
      case 'mdat':
        yield { kind: 'segment', data: moof ? Buffer.concat([moof, box.data]) : box.data };
        moof = undefined;
        break;
      default:
        break; // styp, sidx, mfra, free, ... -- ignored
    }
  }
}

/** One ISO-BMFF box: 4-byte type plus the complete box bytes (header + body). */
interface Box {
  type: string;
  data: Buffer;
}

/** Reads whole MP4 boxes from a stream, honouring 64-bit largesize. */
class BoxStreamReader {
  private buffer: Buffer = Buffer.alloc(0);
  private wake?: () => void;
  private ended = false;

  constructor(stream: Readable) {
    stream.on('data', (chunk: Buffer) => {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      this.signal();
    });
    stream.on('end', () => {
      this.ended = true;
      this.signal();
    });
    stream.on('error', () => {
      this.ended = true;
      this.signal();
    });
  }

  private signal(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  private async readBytes(n: number): Promise<Buffer | undefined> {
    while (this.buffer.length < n) {
      if (this.ended) {
        return undefined;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
    const out = this.buffer.subarray(0, n);
    this.buffer = this.buffer.subarray(n);
    return out;
  }

  async readBox(): Promise<Box | undefined> {
    const header = await this.readBytes(8);
    if (!header) {
      return undefined;
    }
    let size = header.readUInt32BE(0);
    const type = header.toString('latin1', 4, 8);

    if (size === 1) {
      // 64-bit largesize follows the 8-byte header (used by large mdat boxes).
      const ext = await this.readBytes(8);
      if (!ext) {
        return undefined;
      }
      const large = Number(ext.readBigUInt64BE(0));
      const body = await this.readBytes(large - 16);
      if (!body) {
        return undefined;
      }
      return { type, data: Buffer.concat([header, ext, body]) };
    }

    if (size < 8) {
      // size 0 ("to end of stream") is never produced by the fragmented muxer.
      return undefined;
    }
    const body = await this.readBytes(size - 8);
    if (!body) {
      return undefined;
    }
    return { type, data: Buffer.concat([header, body]) };
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Map HAP's AudioRecordingSamplerate enum to a sample rate in Hz. */
function samplerateHz(rate: AudioRecordingSamplerate): number {
  switch (rate) {
    case AudioRecordingSamplerate.KHZ_8:
      return 8_000;
    case AudioRecordingSamplerate.KHZ_16:
      return 16_000;
    case AudioRecordingSamplerate.KHZ_24:
      return 24_000;
    case AudioRecordingSamplerate.KHZ_32:
      return 32_000;
    case AudioRecordingSamplerate.KHZ_44_1:
      return 44_100;
    case AudioRecordingSamplerate.KHZ_48:
      return 48_000;
    default:
      return 32_000;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

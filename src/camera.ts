/**
 * camera.ts
 *
 * HomeKit camera support for the Control4-local Homebridge plugin.
 *
 *  - C4CameraDelegate implements HAP's CameraStreamingDelegate: snapshots,
 *    SRTP stream setup, and ffmpeg process management.
 *  - attachCameraController() wires a configured CameraController onto an
 *    accessory the platform already created.
 *
 * Structure follows homebridge-camera-ffmpeg: one ffmpeg process per active
 * streaming session, SRTP keys minted in prepareStream, torn down on STOP.
 *
 * This file is deliberately independent of the platform -- it is handed a
 * ResolvedCamera (from cameraResolver.ts) plus HAP and a logger, nothing more.
 *
 * NOTE: never log the RTSP/snapshot URL or credentials.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { randomBytes } from 'crypto';
import { createSocket } from 'dgram';

import type {
  API,
  CameraController,
  CameraControllerOptions,
  CameraStreamingDelegate,
  HAP,
  Logger,
  PlatformAccessory,
  PrepareStreamCallback,
  PrepareStreamRequest,
  PrepareStreamResponse,
  SnapshotRequest,
  SnapshotRequestCallback,
  StreamingRequest,
  StreamRequestCallback,
} from 'homebridge';
import { StreamRequestTypes } from 'homebridge';

import type { ResolvedCamera } from './cameraResolver';

/** Pi 3 can realistically handle two concurrent sessions. */
const CAMERA_STREAM_COUNT = 2;
/** ffmpeg path -- override via options if a bundled static build is preferred. */
const DEFAULT_FFMPEG = 'ffmpeg';

interface SessionInfo {
  address: string;
  ipv6: boolean;
  videoPort: number;
  /** Local RTP/RTCP port we reserved and reported back to HomeKit. */
  localVideoPort: number;
  videoSSRC: number;
  /** base64(key16 || salt14) -- our OUTGOING SRTP material. */
  videoSRTP: string;
}

interface ActiveSession {
  ffmpeg: ChildProcessWithoutNullStreams;
}

export interface C4CameraDelegateOptions {
  /** Pretty name for logs. */
  displayName: string;
  /** URLs/flags from resolveCamera(). */
  resolved: ResolvedCamera;
  hap: HAP;
  log: Logger;
  /** Absolute path to an ffmpeg binary; defaults to `ffmpeg` on PATH. */
  ffmpegPath?: string;
  /** Max UDP payload size for SRTP packets. */
  packetSize?: number;
}

export class C4CameraDelegate implements CameraStreamingDelegate {
  private readonly hap: HAP;
  private readonly log: Logger;
  private readonly displayName: string;
  private readonly resolved: ResolvedCamera;
  private readonly ffmpegPath: string;
  private readonly packetSize: number;

  /** Set by attachCameraController once the controller exists. */
  public controller?: CameraController;

  private readonly pendingSessions = new Map<string, SessionInfo>();
  private readonly activeSessions = new Map<string, ActiveSession>();

  constructor(opts: C4CameraDelegateOptions) {
    this.hap = opts.hap;
    this.log = opts.log;
    this.displayName = opts.displayName;
    this.resolved = opts.resolved;
    this.ffmpegPath = opts.ffmpegPath ?? DEFAULT_FFMPEG;
    this.packetSize = opts.packetSize ?? 1316;
  }

  // ---------------------------------------------------------------------------
  // CameraController options
  // ---------------------------------------------------------------------------

  buildControllerOptions(): CameraControllerOptions {
    const hap = this.hap;
    return {
      cameraStreamCount: CAMERA_STREAM_COUNT,
      delegate: this,
      streamingOptions: {
        supportedCryptoSuites: [hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          resolutions: [
            [1280, 720, 30],
            [1280, 720, 15],
            [1024, 768, 30],
            [640, 480, 30],
            [640, 360, 30],
            [480, 360, 30],
            [480, 270, 30],
            [320, 240, 30],
            [320, 240, 15],
            [320, 180, 30],
          ],
          codec: {
            profiles: [
              hap.H264Profile.BASELINE,
              hap.H264Profile.MAIN,
              hap.H264Profile.HIGH,
            ],
            levels: [
              hap.H264Level.LEVEL3_1,
              hap.H264Level.LEVEL3_2,
              hap.H264Level.LEVEL4_0,
            ],
          },
        },
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Snapshots
  // ---------------------------------------------------------------------------

  handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): void {
    this.fetchSnapshot(request)
      .then((buffer) => callback(undefined, buffer))
      .catch((err: unknown) => {
        this.log.error(`[${this.displayName}] snapshot failed: ${errMessage(err)}`);
        callback(err instanceof Error ? err : new Error(String(err)));
      });
  }

  private async fetchSnapshot(request: SnapshotRequest): Promise<Buffer> {
    // Prefer the DVR's HTTP JPEG endpoint; fall back to grabbing one frame
    // from the RTSP stream with ffmpeg.
    if (this.resolved.snapshotUrl) {
      try {
        return await snapshotViaHttp(this.resolved.snapshotUrl);
      } catch (err) {
        this.log.debug(`[${this.displayName}] HTTP snapshot failed, trying ffmpeg: ${errMessage(err)}`);
      }
    }
    const source = this.resolved.rtspUrl ?? this.resolved.mjpegUrl;
    if (!source) {
      throw new Error('no snapshot or stream URL available');
    }
    return this.snapshotViaFfmpeg(source, request.width, request.height);
  }

  private snapshotViaFfmpeg(source: string, width: number, height: number): Promise<Buffer> {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-rtsp_transport', 'tcp',
      '-i', source,
      '-frames:v', '1',
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      '-f', 'image2',
      '-',
    ];
    return new Promise<Buffer>((resolve, reject) => {
      const proc = spawn(this.ffmpegPath, args, { env: process.env });
      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      proc.stdout.on('data', (d: Buffer) => chunks.push(d));
      proc.stderr.on('data', (d: Buffer) => errChunks.push(d));
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0 && chunks.length > 0) {
          resolve(Buffer.concat(chunks));
        } else {
          reject(new Error(`ffmpeg snapshot exited ${String(code)}: ${Buffer.concat(errChunks).toString().trim()}`));
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Stream preparation (SRTP parameters)
  // ---------------------------------------------------------------------------

  prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): void {
    this.doPrepareStream(request)
      .then(({ response, info }) => {
        this.pendingSessions.set(request.sessionID, info);
        callback(undefined, response);
      })
      .catch((err: unknown) => {
        this.log.error(`[${this.displayName}] prepareStream failed: ${errMessage(err)}`);
        callback(err instanceof Error ? err : new Error(String(err)));
      });
  }

  private async doPrepareStream(
    request: PrepareStreamRequest,
  ): Promise<{ response: PrepareStreamResponse; info: SessionInfo }> {
    const ipv6 = request.addressVersion === 'ipv6';
    const localVideoPort = await reservePort(ipv6);

    // Our OUTGOING SRTP material: 16-byte key + 14-byte salt.
    const key = randomBytes(16);
    const salt = randomBytes(14);
    const videoSRTP = Buffer.concat([key, salt]).toString('base64');
    const videoSSRC = this.hap.CameraController.generateSynchronisationSource();

    const info: SessionInfo = {
      address: request.targetAddress,
      ipv6,
      videoPort: request.video.port,
      localVideoPort,
      videoSSRC,
      videoSRTP,
    };

    const response: PrepareStreamResponse = {
      video: {
        port: localVideoPort,
        ssrc: videoSSRC,
        srtp_key: key,
        srtp_salt: salt,
      },
    };

    return { response, info };
  }

  // ---------------------------------------------------------------------------
  // Stream lifecycle
  // ---------------------------------------------------------------------------

  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    switch (request.type) {
      case StreamRequestTypes.START:
        this.startStream(request, callback);
        break;
      case StreamRequestTypes.RECONFIGURE:
        // We stream-copy / use a fixed ladder, so there is nothing to retune.
        this.log.debug(`[${this.displayName}] reconfigure request (no-op)`);
        callback();
        break;
      case StreamRequestTypes.STOP:
        this.stopStream(request.sessionID);
        callback();
        break;
      default:
        callback();
    }
  }

  private startStream(request: StreamingRequest & { type: StreamRequestTypes.START }, callback: StreamRequestCallback): void {
    const info = this.pendingSessions.get(request.sessionID);
    if (!info) {
      callback(new Error('no pending session for START'));
      return;
    }
    const source = this.resolved.rtspUrl ?? this.resolved.mjpegUrl;
    if (!source) {
      callback(new Error('no stream URL available'));
      return;
    }

    const args = this.buildFfmpegArgs(request, info, source);
    const proc = spawn(this.ffmpegPath, args, { env: process.env });

    let started = false;
    const onStderr = (data: Buffer): void => {
      const line = data.toString();
      // ffmpeg prints the progress line ("frame=") once it is flowing.
      if (!started && /frame=\s*\d+/.test(line)) {
        started = true;
        callback();
      }
      if (/error|not found|unauthorized|failed|invalid/i.test(line)) {
        this.log.debug(`[${this.displayName}] ffmpeg: ${line.trim()}`);
      }
    };

    proc.stderr.on('data', onStderr);
    proc.on('error', (err) => {
      this.log.error(`[${this.displayName}] ffmpeg spawn error: ${errMessage(err)}`);
      if (!started) {
        started = true;
        callback(err);
      }
    });
    proc.on('close', (code) => {
      this.activeSessions.delete(request.sessionID);
      if (!started) {
        started = true;
        callback(new Error(`ffmpeg exited before streaming (code ${String(code)})`));
      } else if (code !== 0 && code !== null) {
        this.log.debug(`[${this.displayName}] ffmpeg exited with code ${String(code)}`);
        // Ask HAP to tear the session down cleanly.
        this.controller?.forceStopStreamingSession(request.sessionID);
      }
    });

    this.activeSessions.set(request.sessionID, { ffmpeg: proc });
    this.pendingSessions.delete(request.sessionID);

    // Safety net: if ffmpeg never prints a progress line, don't hang HomeKit.
    setTimeout(() => {
      if (!started) {
        started = true;
        callback();
      }
    }, 4000).unref();
  }

  private buildFfmpegArgs(
    request: StreamingRequest & { type: StreamRequestTypes.START },
    info: SessionInfo,
    source: string,
  ): string[] {
    const v = request.video;
    const args: string[] = [
      '-hide_banner',
      '-loglevel', 'error',
      '-fflags', '+genpts',
      '-rtsp_transport', 'tcp',
      '-i', source,
      '-an',
      '-sn',
      '-dn',
    ];

    if (this.resolved.needsTranscode) {
      args.push(
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-pix_fmt', 'yuv420p',
        '-color_range', 'mpeg',
        '-r', String(v.fps),
        '-vf', `scale=${v.width}:${v.height}:force_original_aspect_ratio=decrease`,
        '-b:v', `${v.max_bit_rate}k`,
        '-maxrate', `${v.max_bit_rate}k`,
        '-bufsize', `${v.max_bit_rate * 2}k`,
      );
    } else {
      // H.264 passthrough -- cheapest path, ideal for a Pi 3.
      args.push('-c:v', 'copy');
    }

    const target = info.ipv6 ? `[${info.address}]` : info.address;
    args.push(
      '-payload_type', String(v.pt),
      '-ssrc', String(info.videoSSRC),
      '-f', 'rtp',
      '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
      '-srtp_out_params', info.videoSRTP,
      `srtp://${target}:${info.videoPort}` +
        `?rtcpport=${info.videoPort}` +
        `&localrtcpport=${info.localVideoPort}` +
        `&pkt_size=${this.packetSize}`,
    );

    return args;
  }

  private stopStream(sessionID: string): void {
    const active = this.activeSessions.get(sessionID);
    if (active) {
      try {
        active.ffmpeg.kill('SIGKILL');
      } catch (err) {
        this.log.debug(`[${this.displayName}] error killing ffmpeg: ${errMessage(err)}`);
      }
      this.activeSessions.delete(sessionID);
    }
    this.pendingSessions.delete(sessionID);
  }
}

// -----------------------------------------------------------------------------
// Controller wiring
// -----------------------------------------------------------------------------

/**
 * Create a HAP CameraController from the delegate and attach it to an accessory
 * the platform already built. Returns the controller for the caller's records.
 */
export function attachCameraController(
  api: API,
  accessory: PlatformAccessory,
  delegate: C4CameraDelegate,
): CameraController {
  const options: CameraControllerOptions = delegate.buildControllerOptions();
  const controller = new api.hap.CameraController(options);
  delegate.controller = controller;
  accessory.configureController(controller);
  return controller;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Fetch a JPEG snapshot over HTTP, moving any URL userinfo into a BASIC header. */
async function snapshotViaHttp(rawUrl: string): Promise<Buffer> {
  const url = new URL(rawUrl);
  const headers: Record<string, string> = {};
  if (url.username) {
    const creds = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    headers['Authorization'] = 'Basic ' + Buffer.from(creds).toString('base64');
    url.username = '';
    url.password = '';
  }
  const controllerAbort = new AbortController();
  const timer = setTimeout(() => controllerAbort.abort(), 10_000);
  try {
    const res = await fetch(url.toString(), { headers, signal: controllerAbort.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const arrayBuf = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    if (buf.length === 0) {
      throw new Error('empty snapshot body');
    }
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

/** Reserve a free UDP port by binding ephemeral, reading it, then releasing. */
function reservePort(ipv6: boolean): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const socket = createSocket(ipv6 ? 'udp6' : 'udp4');
    socket.once('error', reject);
    socket.bind(0, () => {
      const address = socket.address();
      const port = typeof address === 'object' ? address.port : 0;
      socket.close(() => {
        if (port > 0) {
          resolve(port);
        } else {
          reject(new Error('failed to reserve UDP port'));
        }
      });
    });
  });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

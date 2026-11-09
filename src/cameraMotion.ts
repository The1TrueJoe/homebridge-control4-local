/**
 * cameraMotion.ts
 *
 * Software motion detection for the Control4-local Homebridge plugin.
 *
 * The Luma/Hikvision DVR's own motion events are not exposed through Control4's
 * REST API, so this module derives motion from the video itself: a cheap ffmpeg
 * process decodes the DVR's *sub-stream* at a reduced frame rate and resolution
 * and runs scene-change detection. When the scene score crosses a threshold we
 * flip the HomeKit MotionSensor's MotionDetected characteristic on, then back
 * off after a configurable cooldown. For HKSV, that characteristic is the
 * EventTriggerOption.MOTION trigger that starts a recording.
 *
 * Pi 3 note: the only cost is decoding the sub-stream. We minimise it by
 * sampling a few frames per second at a small size (see sampleFps / scaleWidth)
 * -- scene detection on 320px @ 3fps is a few percent of one core. A still
 * lighter (but coarser) alternative is to poll the ISAPI JPEG snapshot every
 * few seconds and diff successive frames; scene detection on the sub-stream was
 * chosen for lower latency and no extra HTTP load on the DVR. For completeness,
 * `-vf scdet` (dedicated scene-change filter) is an equivalent substitute for
 * the `select`/`metadata` pipeline used here.
 *
 * NOTE: never log the RTSP URL or credentials.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

import type { CameraController, HAP, Logger, PlatformAccessory, Service } from 'homebridge';

import type { ResolvedCamera } from './cameraResolver';

const DEFAULT_FFMPEG = 'ffmpeg';
/** Scene-score threshold in [0,1]; higher = less sensitive. */
const DEFAULT_THRESHOLD = 0.1;
/** Hold MotionDetected true for at least this long after the last event. */
const DEFAULT_COOLDOWN_MS = 5_000;
/** Frames per second to sample for detection (keep low for a Pi 3). */
const DEFAULT_SAMPLE_FPS = 3;
/** Downscale width before scene detection (height auto, keeps aspect). */
const DEFAULT_SCALE_WIDTH = 320;
/** Restart the detector ffmpeg this long after it exits. */
const RESTART_MS = 2_000;

export interface MotionDetectorOptions {
  displayName: string;
  resolved: ResolvedCamera;
  log: Logger;
  /** Absolute path to an ffmpeg binary; defaults to `ffmpeg` on PATH. */
  ffmpegPath?: string;
  /** Scene-score threshold [0,1]. Default 0.1. Raise to reduce false triggers. */
  threshold?: number;
  /** Minimum MotionDetected hold time after the last scene event (ms). */
  cooldownMs?: number;
  /** Detection sampling rate (fps). Default 3. */
  sampleFps?: number;
  /** Downscale width for detection. Default 320. */
  scaleWidth?: number;
}

/**
 * Drives a HomeKit MotionSensor service from ffmpeg scene-change detection on
 * the DVR sub-stream. Construct it with the service to drive (for HKSV, the one
 * the CameraController created -- `controller.motionService`), then start().
 */
export class C4MotionDetector {
  private readonly displayName: string;
  private readonly resolved: ResolvedCamera;
  private readonly log: Logger;
  private readonly ffmpegPath: string;
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly sampleFps: number;
  private readonly scaleWidth: number;

  private readonly hap: HAP;
  private readonly service: Service;

  private proc?: ChildProcessWithoutNullStreams;
  private running = false;
  private motion = false;
  private cooldownTimer?: NodeJS.Timeout;
  private restartTimer?: NodeJS.Timeout;
  private stderrTail = '';

  constructor(hap: HAP, service: Service, opts: MotionDetectorOptions) {
    this.hap = hap;
    this.service = service;
    this.displayName = opts.displayName;
    this.resolved = opts.resolved;
    this.log = opts.log;
    this.ffmpegPath = opts.ffmpegPath ?? DEFAULT_FFMPEG;
    this.threshold = clamp(opts.threshold ?? DEFAULT_THRESHOLD, 0, 1);
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.sampleFps = opts.sampleFps ?? DEFAULT_SAMPLE_FPS;
    this.scaleWidth = opts.scaleWidth ?? DEFAULT_SCALE_WIDTH;
  }

  start(): void {
    if (this.running) {
      return;
    }
    const source = this.subStreamUrl();
    if (!source) {
      this.log.warn(`[${this.displayName}] motion detection: no stream URL; detector not started`);
      return;
    }
    this.running = true;
    this.spawn(source);
  }

  stop(): void {
    this.running = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = undefined;
    }
    if (this.proc) {
      try {
        this.proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      this.proc = undefined;
    }
    this.setMotion(false);
  }

  /**
   * Prefer the DVR sub-stream for detection: on this DVR family the main-stream
   * RTSP ends in `/101` and the sub-stream in `/102`. Fall back to whatever
   * stream URL we have.
   */
  private subStreamUrl(): string | undefined {
    const main = this.resolved.rtspUrl;
    if (main) {
      return main.replace(/\/Streaming\/Channels\/(\d+?)1(\b|$)/, '/Streaming/Channels/$12$2');
    }
    return this.resolved.mjpegUrl;
  }

  private spawn(source: string): void {
    // select='gt(scene,T)' passes only frames whose scene score exceeds the
    // threshold; metadata=print:file=- then writes that score to stdout (plain
    // `metadata=print` logs at info level, which `-loglevel error` would hide).
    // Each printed block is a motion event. fps + scale keep decode cost tiny on
    // a Pi 3. The `-f null -` muxer discards the frames (writes nothing), so
    // stdout carries only the metadata lines.
    const filter =
      `fps=${this.sampleFps},scale=${this.scaleWidth}:-2,` +
      `select='gt(scene,${this.threshold})',metadata=print:file=-`;
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-rtsp_transport', 'tcp',
      '-i', source,
      '-an',
      '-sn',
      '-dn',
      '-filter:v', filter,
      '-f', 'null',
      '-',
    ];

    const proc = spawn(this.ffmpegPath, args, { env: process.env });
    this.proc = proc;

    proc.stdout.on('data', (d: Buffer) => this.onMetadata(d.toString()));
    proc.stderr.on('data', (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-512);
    });
    proc.on('error', (err) => {
      this.log.error(`[${this.displayName}] motion ffmpeg spawn error: ${errMessage(err)}`);
    });
    proc.on('close', (code) => {
      if (this.proc === proc) {
        this.proc = undefined;
      }
      if (this.running) {
        this.log.debug(
          `[${this.displayName}] motion ffmpeg exited (${String(code)}); ` +
            `${this.stderrTail.trim()}; restarting`,
        );
        this.restartTimer = setTimeout(() => {
          this.restartTimer = undefined;
          if (this.running) {
            this.spawn(source);
          }
        }, RESTART_MS);
        this.restartTimer.unref();
      }
    });
  }

  /**
   * metadata=print emits blocks like:
   *   frame:12  pts:...  pts_time:4.0
   *   lavfi.scene_score=0.254392
   * Any `lavfi.scene_score=` line means a frame cleared the threshold -> motion.
   */
  private onMetadata(text: string): void {
    if (text.includes('lavfi.scene_score=')) {
      this.trigger();
    }
  }

  private trigger(): void {
    if (!this.sensorEnabled()) {
      return; // StatusActive is off: user disabled the sensor in Home.
    }
    this.setMotion(true);
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
    }
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = undefined;
      this.setMotion(false);
    }, this.cooldownMs);
    this.cooldownTimer.unref();
  }

  private setMotion(value: boolean): void {
    if (this.motion === value) {
      return;
    }
    this.motion = value;
    this.service.updateCharacteristic(this.hap.Characteristic.MotionDetected, value);
    this.log.debug(`[${this.displayName}] motion ${value ? 'detected' : 'cleared'}`);
  }

  /** Respect StatusActive (added by HAP for HKSV) when present. */
  private sensorEnabled(): boolean {
    try {
      const characteristic = this.service.getCharacteristic(this.hap.Characteristic.StatusActive);
      const value = characteristic.value;
      // Default true when the characteristic is absent / unset.
      return value === undefined || value === null || value === true || value === 1;
    } catch {
      return true;
    }
  }
}

/**
 * Get (or create) a standalone MotionSensor service on an accessory.
 *
 * For HKSV you normally do NOT need this: pass `sensors: { motion: true }` in
 * CameraControllerOptions and the CameraController creates/maintains the service
 * for you -- then drive `controller.motionService` with C4MotionDetector. Use
 * this helper only for a non-HKSV (standalone) motion sensor.
 */
export function ensureMotionSensorService(
  hap: HAP,
  accessory: PlatformAccessory,
  displayName: string,
): Service {
  const existing = accessory.getService(hap.Service.MotionSensor);
  if (existing) {
    return existing;
  }
  return accessory.addService(hap.Service.MotionSensor, `${displayName} Motion`);
}

/**
 * Convenience wiring for HKSV: take the MotionSensor the CameraController built,
 * attach a scene-detection detector, and start it. Returns the detector so the
 * platform can stop() it on shutdown. No-op (returns undefined) if the
 * controller has no motion service (i.e. sensors.motion was not enabled).
 */
export function attachMotionDetector(
  hap: HAP,
  controller: CameraController,
  opts: MotionDetectorOptions,
): C4MotionDetector | undefined {
  const service = controller.motionService;
  if (!service) {
    opts.log.warn(
      `[${opts.displayName}] attachMotionDetector: controller has no motionService ` +
        `(did you set sensors.motion?)`,
    );
    return undefined;
  }
  const detector = new C4MotionDetector(hap, service, opts);
  detector.start();
  return detector;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

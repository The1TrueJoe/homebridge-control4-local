/**
 * cameraResolver.ts
 *
 * Resolves a Control4 camera item into concrete stream/snapshot URLs that
 * HomeKit's CameraController can consume.
 *
 * Connection info (host, ports, credentials) is obtained token-only via
 *   director.sendCommandSync(camItem.id, 'GET_PROPERTIES', {})
 * which returns a `camera_properties` object. GET_PROPERTIES does NOT return
 * the URL *path* -- the path is DVR-model specific and was determined by
 * probing the real DVR (a Luma / SnapAV unit, Hikvision/ISAPI OEM).
 *
 * Confirmed against the live DVR (192.168.1.107):
 *   RTSP  (H.264, stream-copyable):
 *     rtsp://<user>:<pass>@<host>:<rtspPort>/Streaming/Channels/<ch*100+1>   (main)
 *     rtsp://<user>:<pass>@<host>:<rtspPort>/Streaming/Channels/<ch*100+2>   (sub)
 *   Snapshot (JPEG, BASIC auth):
 *     http://<host>:<httpPort>/ISAPI/Streaming/channels/<ch*100+1>/picture
 *
 * Channel substitution: the DVR encodes "channel"+"stream" as a single integer
 * `channel * 100 + streamIndex`, where streamIndex 1 = main, 2 = sub. So the
 * 1-based DVR channel N maps to 101/102 (ch1), 201/202 (ch2), ... 1601/1602.
 *
 * NOTE: never log credentials from this module.
 */

import type { Control4Director, C4Item } from './control4/director';

export interface ResolvedCamera {
  /** RTSP main-stream URL with credentials in userinfo (H.264). */
  rtspUrl?: string;
  /** HTTP snapshot URL with credentials in userinfo (BASIC auth, JPEG). */
  snapshotUrl?: string;
  /** MJPEG stream URL, if the DVR only offers motion-JPEG (not this DVR). */
  mjpegUrl?: string;
  /**
   * true  -> no stream-copyable H.264 was found; live video must be
   *          transcoded (e.g. from MJPEG/snapshots).
   * false -> rtspUrl is H.264 and can be passed through with `-c:v copy`.
   */
  needsTranscode: boolean;

  /** Raw DVR connection details (for subscribing to the DVR's native motion events). */
  host?: string;
  httpPort?: number;
  useHttps?: boolean;
  username?: string;
  password?: string;
  /** 1-based DVR channel for this camera. */
  channel?: number;
}

/** Subset of the `camera_properties` object returned by GET_PROPERTIES. */
interface CameraProperties {
  address?: string;
  http_port?: number;
  https_port?: number;
  use_https?: boolean;
  rtsp_port?: number;
  authentication_required?: boolean;
  authentication_type?: string;
  username?: string;
  password?: string;
  [k: string]: unknown;
}

/**
 * Ordered URL templates, best-known first. `{main}` / `{sub}` are the encoded
 * stream integers (channel*100 + 1/2); `{ch}` is the raw 1-based channel.
 * The first entry in each list is the pattern confirmed against this DVR; the
 * rest are kept as graceful fallbacks for other OEM firmware.
 */
export const RTSP_PATH_TEMPLATES: ReadonlyArray<string> = [
  '/Streaming/Channels/{main}', // Hikvision / Luma (CONFIRMED)
  '/Streaming/Channels/{sub}', // Hikvision sub-stream
  '/cam/realmonitor?channel={ch}&subtype=0', // Dahua
  '/unicast/c{ch}/s0/live', // Uniview
  '/h264/ch{ch}/main/av_stream', // generic
];

export const SNAPSHOT_PATH_TEMPLATES: ReadonlyArray<string> = [
  '/ISAPI/Streaming/channels/{main}/picture', // Hikvision / Luma (CONFIRMED)
  '/Streaming/channels/{main}/picture', // Hikvision (older firmware)
  '/cgi-bin/snapshot.cgi?channel={ch}', // Dahua
  '/onvif/snapshot', // generic ONVIF
];

/** Encode a 1-based channel + stream index the way this DVR family expects. */
function encodeChannel(channel: number, stream: 1 | 2): number {
  return channel * 100 + stream;
}

function fillTemplate(template: string, channel: number): string {
  return template
    .replace('{main}', String(encodeChannel(channel, 1)))
    .replace('{sub}', String(encodeChannel(channel, 2)))
    .replace('{ch}', String(channel));
}

/** Percent-encode userinfo so passwords with reserved chars survive the URL. */
function encodeUserinfo(value: string): string {
  // encodeURIComponent, plus the sub-delims that are legal but ambiguous in
  // the userinfo component.
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function pickFirst<T>(list: ReadonlyArray<T>): T | undefined {
  return list.length > 0 ? list[0] : undefined;
}

/**
 * Build the concrete camera URLs for a given DVR channel.
 *
 * @param director Control4 Director client (token already loaded).
 * @param camItem  The camera item (proxy === 'camera' | 'camera_v2').
 * @param channel  1-based DVR channel ("Camera Number" property).
 */
export async function resolveCamera(
  director: Control4Director,
  camItem: C4Item,
  channel: number,
): Promise<ResolvedCamera> {
  if (!Number.isInteger(channel) || channel < 1) {
    throw new Error(`resolveCamera: invalid channel ${String(channel)} for item ${camItem.id}`);
  }

  const reply = await director.sendCommandSync(camItem.id, 'GET_PROPERTIES', {});
  const props = extractCameraProperties(reply);
  if (!props) {
    throw new Error(`resolveCamera: GET_PROPERTIES returned no camera_properties for item ${camItem.id}`);
  }

  const host = props.address;
  if (!host) {
    throw new Error(`resolveCamera: GET_PROPERTIES returned no address for item ${camItem.id}`);
  }

  const rtspPort = props.rtsp_port ?? 554;
  const useHttps = props.use_https === true;
  const httpPort = (useHttps ? props.https_port : props.http_port) ?? (useHttps ? 443 : 80);
  const scheme = useHttps ? 'https' : 'http';

  const authRequired = props.authentication_required !== false;
  const username = props.username ?? '';
  const password = props.password ?? '';
  const userinfo =
    authRequired && username
      ? `${encodeUserinfo(username)}:${encodeUserinfo(password)}@`
      : '';

  // --- RTSP (H.264 main stream) ---------------------------------------------
  const rtspPath = fillTemplate(pickFirst(RTSP_PATH_TEMPLATES) ?? '', channel);
  const rtspUrl = `rtsp://${userinfo}${host}:${rtspPort}${rtspPath}`;

  // --- Snapshot (JPEG, BASIC auth) ------------------------------------------
  const snapPath = fillTemplate(pickFirst(SNAPSHOT_PATH_TEMPLATES) ?? '', channel);
  // Credentials are carried in the userinfo so the interface stays simple;
  // camera.ts turns userinfo into a BASIC Authorization header for fetch().
  const snapshotUrl = `${scheme}://${userinfo}${host}:${httpPort}${snapPath}`;

  // The confirmed RTSP stream is H.264 High profile -> HomeKit can stream-copy.
  const needsTranscode = false;

  return {
    rtspUrl,
    snapshotUrl,
    mjpegUrl: undefined,
    needsTranscode,
    host,
    httpPort,
    useHttps,
    username,
    password,
    channel,
  };
}

/** Pull `camera_properties` out of a GET_PROPERTIES reply body, defensively. */
function extractCameraProperties(reply: unknown): CameraProperties | undefined {
  if (!reply || typeof reply !== 'object') {
    return undefined;
  }
  const body = reply as Record<string, unknown>;
  const cp = body['camera_properties'];
  if (cp && typeof cp === 'object') {
    return cp as CameraProperties;
  }
  return undefined;
}

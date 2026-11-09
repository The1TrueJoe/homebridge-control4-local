import * as http from 'http';
import * as https from 'https';
import { Logger } from 'homebridge';

/**
 * Subscribes to a DVR/NVR's native motion events (Hikvision/ISAPI alert stream) and forwards
 * them to HomeKit as the Secure-Video trigger. One streaming HTTP connection per DVR covers
 * every channel — there is no video decoding on the host, so this is near-zero CPU/memory.
 * The Apple home hub does all the clip analysis (person/vehicle/package) once recording starts.
 */
export class DvrMotionHub {
  private readonly targets = new Map<number, { set: (active: boolean) => void; timer?: NodeJS.Timeout }>();
  private req?: http.ClientRequest;
  private buffer = '';
  private stopped = false;
  private started = false;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly useHttps: boolean,
    private readonly username: string,
    private readonly password: string,
    private readonly log: Logger,
    /** How long after the last motion event to clear MotionDetected (the DVR doesn't always send "inactive"). */
    private readonly resetMs = 15000,
  ) {}

  /** Map a 1-based DVR channel to a HomeKit MotionDetected setter. */
  register(channel: number, set: (active: boolean) => void): void {
    this.targets.set(channel, { set });
  }

  start(): void {
    if (this.started || this.stopped) {
      return;
    }
    this.started = true;
    this.connect();
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }
    const auth = 'Basic ' + Buffer.from(`${this.username}:${this.password}`).toString('base64');
    const mod = this.useHttps ? https : http;
    const options: https.RequestOptions = {
      host: this.host,
      port: this.port,
      path: '/ISAPI/Event/notification/alertStream',
      method: 'GET',
      headers: { 'Authorization': auth },
      ...(this.useHttps ? { rejectUnauthorized: false } : {}),
    };
    this.req = mod.request(options, (res) => {
      if (res.statusCode !== 200) {
        this.log.warn(`[camera motion] DVR ${this.host} alertStream returned HTTP ${res.statusCode} — motion events unavailable`);
        res.resume();
        this.reconnect();
        return;
      }
      this.log.info(`[camera motion] DVR ${this.host}: subscribed to native motion events (${this.targets.size} channel(s)).`);
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => this.consume(chunk));
      res.on('end', () => this.reconnect());
      res.on('error', () => this.reconnect());
    });
    this.req.on('error', (e) => {
      this.log.debug(`[camera motion] DVR ${this.host}: ${e.message}`);
      this.reconnect();
    });
    this.req.end();
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 65536) {
      this.buffer = this.buffer.slice(-16384); // guard against unbounded growth
    }
    let idx: number;
    while ((idx = this.buffer.indexOf('</EventNotificationAlert>')) !== -1) {
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + '</EventNotificationAlert>'.length);
      this.handleBlock(block);
    }
  }

  private handleBlock(xml: string): void {
    const type = (/<eventType>([^<]+)<\/eventType>/i.exec(xml) || [])[1];
    if (!type || !/vmd|motion|linedetection|fielddetection|intrusion/i.test(type)) {
      return; // ignore heartbeats / non-motion events
    }
    const state = ((/<eventState>([^<]+)<\/eventState>/i.exec(xml) || [])[1] || 'active').toLowerCase();
    const chStr = (/<(?:dynChannelID|channelID)>(\d+)<\/(?:dynChannelID|channelID)>/i.exec(xml) || [])[1];
    const channel = chStr ? Number(chStr) : NaN;
    const t = this.targets.get(channel);
    if (!t) {
      return;
    }
    if (state === 'inactive') {
      if (t.timer) {
        clearTimeout(t.timer);
        t.timer = undefined;
      }
      t.set(false);
      return;
    }
    t.set(true);
    if (t.timer) {
      clearTimeout(t.timer);
    }
    t.timer = setTimeout(() => t.set(false), this.resetMs);
  }

  private reconnect(): void {
    if (this.stopped) {
      return;
    }
    setTimeout(() => this.connect(), 5000);
  }

  stop(): void {
    this.stopped = true;
    try {
      this.req?.destroy();
    } catch {
      /* ignore */
    }
    for (const t of this.targets.values()) {
      if (t.timer) {
        clearTimeout(t.timer);
      }
    }
  }
}

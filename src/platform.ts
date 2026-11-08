import {
  API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { Control4Account } from './control4/account';
import { Control4Director, C4Item, C4Variable, UnauthorizedError } from './control4/director';
import { C4Accessory, LightAccessory, LockAccessory } from './accessories';

export interface Control4Config extends PlatformConfig {
  username?: string;
  password?: string;
  controllerIp?: string;
  controllerCommonName?: string;
  pollSeconds?: number;
  excludeRooms?: string[];
}

/** Control4 proxies this plugin maps, and the HomeKit handler for each. */
const HANDLERS: Record<string, new (p: Control4Platform, a: PlatformAccessory, i: C4Item) => C4Accessory> = {
  light: LightAccessory,
  light_v2: LightAccessory,
  relaysingle_doorlock_c4: LockAccessory,
};

export class Control4Platform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  private readonly cached: PlatformAccessory[] = [];
  private readonly handlers = new Map<string, C4Accessory>();

  public director?: Control4Director;
  private account?: Control4Account;
  private commonName?: string;
  private pollTimer?: NodeJS.Timeout;

  constructor(
    public readonly log: Logger,
    public readonly config: Control4Config,
    public readonly api: API,
  ) {
    if (!config.username || !config.password) {
      this.log.warn('Control4: set your Control4 account email/password in the plugin settings. Waiting until then.');
      return;
    }
    this.api.on('didFinishLaunching', () => {
      this.start().catch((e) => this.log.error('Control4 startup failed:', e?.message || e));
    });
    this.api.on('shutdown', () => this.pollTimer && clearInterval(this.pollTimer));
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.push(accessory);
  }

  // ---- Authentication & Director plumbing ------------------------------------

  private async start(): Promise<void> {
    this.account = new Control4Account(this.config.username!, this.config.password!);

    const controllers = await this.account.getControllers();
    if (!controllers.length) {
      throw new Error('No controllers found on this Control4 account.');
    }
    const chosen = this.config.controllerCommonName
      ? controllers.find((c) => c.commonName === this.config.controllerCommonName)
      : controllers[0];
    if (!chosen) {
      throw new Error(`Controller "${this.config.controllerCommonName}" not found. Available: ${controllers.map((c) => c.commonName).join(', ')}`);
    }
    this.commonName = chosen.commonName;

    if (!this.config.controllerIp) {
      throw new Error('Set "controllerIp" to the controller\'s LAN address in the plugin settings.');
    }

    const dt = await this.account.getDirectorToken(this.commonName);
    this.director = new Control4Director(this.config.controllerIp, dt.token);
    this.log.info(`Connected to Control4 director ${this.commonName} at ${this.config.controllerIp}.`);

    await this.discover();

    const period = Math.max(5, this.config.pollSeconds ?? 30) * 1000;
    this.pollTimer = setInterval(() => this.poll().catch((e) => this.log.debug('poll error:', e?.message || e)), period);
  }

  /** Run a Director call; on a 401 refresh the token once and retry. */
  private async withAuth<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof UnauthorizedError && this.account && this.commonName) {
        this.log.info('Director token expired; refreshing.');
        const dt = await this.account.getDirectorToken(this.commonName);
        this.director!.setToken(dt.token);
        return await fn();
      }
      throw e;
    }
  }

  async getVariables(id: number): Promise<C4Variable[]> {
    return this.withAuth(() => this.director!.getItemVariables(id));
  }

  async sendCommand(id: number, command: string, params: Record<string, unknown>): Promise<void> {
    return this.withAuth(() => this.director!.sendCommand(id, command, params));
  }

  // ---- Discovery & accessories -----------------------------------------------

  private async discover(): Promise<void> {
    const items = await this.withAuth(() => this.director!.getAllItems());
    const exclude = new Set((this.config.excludeRooms || []).map((r) => r.toLowerCase()));

    // Keep items we have a handler for, not in an excluded room.
    const supported = items.filter((it) =>
      it.proxy && HANDLERS[String(it.proxy)] && !exclude.has(String(it.roomName || '').toLowerCase()));

    // Collapse the hardware device + its named load (same name+room): prefer light_v2.
    const byKey = new Map<string, C4Item>();
    for (const it of supported) {
      const key = `${it.roomName}|${it.name}`;
      const prev = byKey.get(key);
      if (!prev || (it.proxy === 'light_v2' && prev.proxy === 'light')) {
        byKey.set(key, it);
      }
    }
    const chosen = [...byKey.values()];

    const activeUuids = new Set<string>();
    for (const it of chosen) {
      const uuid = this.api.hap.uuid.generate(`c4:${it.id}`);
      activeUuids.add(uuid);
      let accessory = this.cached.find((a) => a.UUID === uuid);
      if (!accessory) {
        accessory = new this.api.platformAccessory(it.name, uuid);
        accessory.context.item = it;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      } else {
        accessory.context.item = it;
      }
      const Handler = HANDLERS[String(it.proxy)];
      this.handlers.set(uuid, new Handler(this, accessory, it));
    }

    // Drop accessories that no longer exist in the project.
    const stale = this.cached.filter((a) => !activeUuids.has(a.UUID));
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }

    this.log.info(`Control4: exposed ${chosen.length} devices to HomeKit (from ${items.length} items).`);
    await this.poll();
  }

  private async poll(): Promise<void> {
    for (const handler of this.handlers.values()) {
      await handler.refresh().catch((e) => this.log.debug('refresh error:', e?.message || e));
    }
  }
}

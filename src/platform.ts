import {
  API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic,
} from 'homebridge';

import { Control4Account } from './control4/account';
import { Control4Director, C4Item } from './control4/director';

export interface Control4Config extends PlatformConfig {
  username?: string;
  password?: string;
  controllerIp?: string;
  controllerCommonName?: string;
  pollSeconds?: number;
  excludeRooms?: string[];
}

export class Control4Platform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  /** Accessories restored from Homebridge's cache on launch. */
  public readonly cachedAccessories: PlatformAccessory[] = [];

  public director?: Control4Director;
  private account?: Control4Account;

  constructor(
    public readonly log: Logger,
    public readonly config: Control4Config,
    public readonly api: API,
  ) {
    if (!config.username || !config.password) {
      this.log.error('Control4: "username" and "password" are required in config. Plugin disabled.');
      return;
    }

    this.api.on('didFinishLaunching', () => {
      this.start().catch((e) => this.log.error('Control4 startup failed:', e?.message || e));
    });
  }

  /** Homebridge calls this for every accessory it restores from disk cache. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.push(accessory);
  }

  private async start(): Promise<void> {
    this.account = new Control4Account(this.config.username!, this.config.password!);

    // Resolve which controller, and its LAN IP.
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
    if (controllers.length > 1 && !this.config.controllerCommonName) {
      this.log.info(`Multiple controllers on the account; using ${chosen.commonName}. Set "controllerCommonName" to choose another: ${controllers.map((c) => c.commonName).join(', ')}`);
    }

    const ip = this.config.controllerIp;
    if (!ip) {
      throw new Error('Could not determine controller IP; set "controllerIp" in config to the controller\'s LAN address.');
    }

    const dt = await this.account.getDirectorToken(chosen.commonName);
    this.director = new Control4Director(ip, dt.token);
    this.log.info(`Connected to Control4 director at ${ip} (${chosen.commonName}); token valid ${Math.round(dt.validSeconds / 3600)} h.`);

    await this.discover();
  }

  /** Pull every item and, for now, report what the system contains. */
  private async discover(): Promise<void> {
    const items = await this.director!.getAllItems();
    const exclude = new Set((this.config.excludeRooms || []).map((r) => r.toLowerCase()));

    const usable = items.filter((it) => !!it.proxy && !exclude.has(String(it.roomName || '').toLowerCase()));

    // Summarise by proxy so the device model is visible in the Homebridge log.
    const byProxy = new Map<string, number>();
    for (const it of usable) {
      const p = String(it.proxy);
      byProxy.set(p, (byProxy.get(p) || 0) + 1);
    }
    this.log.info(`Control4 discovery: ${items.length} items total, ${usable.length} with a proxy.`);
    for (const [proxy, n] of [...byProxy.entries()].sort((a, b) => b[1] - a[1])) {
      this.log.info(`  ${proxy}: ${n}`);
    }
    for (const it of usable) {
      this.logItem(it);
    }
    // Accessory mapping is added next, once the proxy set is confirmed on real hardware.
  }

  private logItem(it: C4Item): void {
    this.log.debug(`item #${it.id} [${it.proxy}] "${it.name}" room="${it.roomName ?? '?'}" type=${it.type ?? '?'}`);
  }
}

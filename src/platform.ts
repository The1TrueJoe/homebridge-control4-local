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
  /** Diagnostic: on startup, toggle this device once and log the command model that works. */
  controlTest?: string;
}

/** Control4 proxies this plugin maps, and the HomeKit handler for each. */
const HANDLERS: Record<string, new (p: Control4Platform, a: PlatformAccessory, i: C4Item) => C4Accessory> = {
  light: LightAccessory,
  light_v2: LightAccessory,
  relaysingle_doorlock_c4: LockAccessory,
  ExtraVeg_ZWave_DoorLock: LockAccessory,
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
    this.log.info(`-> Control4 #${id}: ${command}${Object.keys(params).length ? ' ' + JSON.stringify(params) : ''}`);
    try {
      await this.withAuth(() => this.director!.sendCommand(id, command, params));
    } catch (e) {
      this.log.error(`command #${id} ${command} failed: ${(e as Error)?.message || e}`);
      throw e;
    }
  }

  // ---- Discovery & accessories -----------------------------------------------

  private async discover(): Promise<void> {
    const items = await this.withAuth(() => this.director!.getAllItems());
    const exclude = new Set((this.config.excludeRooms || []).map((r) => r.toLowerCase()));

    // Visibility: what proxies does this system actually have, and which do we not map yet?
    const hist = new Map<string, number>();
    for (const it of items) {
      if (it.proxy) {
        hist.set(String(it.proxy), (hist.get(String(it.proxy)) || 0) + 1);
      }
    }
    this.log.info('Control4 proxies: ' + [...hist.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p}:${n}`).join(', '));
    const unmapped = [...hist.keys()].filter((p) => !HANDLERS[p]);
    if (unmapped.length) {
      this.log.info('Control4 proxies not yet mapped to HomeKit: ' + unmapped.join(', '));
    }

    // A Control4 light is a pair: a hardware wrapper (parent) + the named load (its child).
    // Expose only the load — it carries the real name and is what you actually control.
    const lights = items.filter((it) => it.proxy === 'light' || it.proxy === 'light_v2');
    const lightIds = new Set(lights.map((it) => it.id));
    const wrappers = new Set<number>();
    for (const it of lights) {
      const p = Number(it.parentId);
      if (lightIds.has(p)) {
        wrappers.add(p); // this item's parent is itself a light → the parent is a wrapper
      }
    }
    const lightLoads = lights.filter((it) => !wrappers.has(it.id));

    // Everything else we have a handler for (locks, …).
    const others = items.filter((it) =>
      it.proxy && HANDLERS[String(it.proxy)] && it.proxy !== 'light' && it.proxy !== 'light_v2');

    let chosen = [...lightLoads, ...others]
      .filter((it) => !exclude.has(String(it.roomName || '').toLowerCase()));

    // Give each accessory a unique, readable name: prefer the bare load name, but when the
    // same name occurs more than once (e.g. "Sconces" in three rooms) prefix the room.
    const nameCounts = new Map<string, number>();
    for (const it of chosen) {
      const k = String(it.name).toLowerCase();
      nameCounts.set(k, (nameCounts.get(k) || 0) + 1);
    }
    for (const it of chosen) {
      const dup = (nameCounts.get(String(it.name).toLowerCase()) || 0) > 1;
      if (dup && it.roomName) {
        it.name = `${it.roomName} ${it.name}`;
      }
    }

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

    if (this.config.controlTest) {
      await this.runControlTest(String(this.config.controlTest), chosen).catch((e) => this.log.error('control test error:', e?.message || e));
    }
  }

  /** One-shot diagnostic: toggle a light and log which command model the Director accepts. */
  private async runControlTest(name: string, chosen: C4Item[]): Promise<void> {
    const key = name.toLowerCase();
    const item = chosen.find((it) => String(it.name).toLowerCase() === key);
    if (!item) {
      this.log.warn(`[control test] "${name}" not found. Available: ${chosen.map((c) => c.name).join(', ')}`);
      return;
    }
    const vars = await this.getVariables(item.id).catch(() => []);
    this.log.info(`[control test] "${item.name}" #${item.id} variables: ${JSON.stringify(vars.slice(0, 10))}`);

    const tryCmd = async (command: string, params: Record<string, unknown>): Promise<boolean> => {
      try {
        await this.withAuth(() => this.director!.sendCommand(item.id, command, params));
        this.log.info(`[control test]   OK  ${command} ${JSON.stringify(params)}`);
        return true;
      } catch (e) {
        this.log.warn(`[control test]   FAIL ${command}: ${(e as Error)?.message || e}`);
        return false;
      }
    };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    this.log.info(`[control test] turning "${item.name}" OFF ...`);
    if (!(await tryCmd('OFF', {}))) {
      await tryCmd('SET_LEVEL', { LEVEL: 0, TIME: 0 });
    }
    await sleep(2500);
    this.log.info(`[control test] turning "${item.name}" ON ...`);
    if (!(await tryCmd('ON', {}))) {
      await tryCmd('SET_LEVEL', { LEVEL: 100, TIME: 0 });
    }
    this.log.info('[control test] done — check whether the light physically responded.');
  }

  private async poll(): Promise<void> {
    for (const handler of this.handlers.values()) {
      await handler.refresh().catch((e) => this.log.debug('refresh error:', e?.message || e));
    }
  }
}

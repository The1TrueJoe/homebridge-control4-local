import { PlatformAccessory, Service, CharacteristicValue } from 'homebridge';
import { Control4Platform } from './platform';
import { C4Item } from './control4/director';

/**
 * One HomeKit accessory bound to one Control4 item. Subclasses wire specific
 * characteristics. Reads go through the platform (which refreshes the token on a
 * 401 and retries), so handlers never touch auth directly.
 */
export abstract class C4Accessory {
  protected readonly id: number;
  protected readonly name: string;

  constructor(
    protected readonly platform: Control4Platform,
    protected readonly accessory: PlatformAccessory,
    item: C4Item,
  ) {
    this.id = item.id;
    this.name = item.name;

    const info = accessory.getService(platform.Service.AccessoryInformation)
      || accessory.addService(platform.Service.AccessoryInformation);
    info
      .setCharacteristic(platform.Characteristic.Manufacturer, String(item.manufacturer ?? 'Control4'))
      .setCharacteristic(platform.Characteristic.Model, String(item.model ?? item.proxy ?? 'Control4'))
      .setCharacteristic(platform.Characteristic.SerialNumber, `c4-${item.id}`);
  }

  /** Read current state from Director and push it into HomeKit. Called on poll. */
  abstract refresh(): Promise<void>;

  /** Helper: fetch this item's variables as a name→value map. */
  protected async variables(): Promise<Record<string, unknown>> {
    const vars = await this.platform.getVariables(this.id);
    const out: Record<string, unknown> = {};
    for (const v of vars) {
      out[v.name] = v.value;
    }
    return out;
  }

  /** Pick the first present variable from a list of candidate names. */
  protected pick(vars: Record<string, unknown>, names: string[]): unknown {
    for (const n of names) {
      if (vars[n] !== undefined && vars[n] !== null) {
        return vars[n];
      }
    }
    return undefined;
  }
}

/** Control4 light proxy ("light" / "light_v2") → HomeKit Lightbulb. */
export class LightAccessory extends C4Accessory {
  private service: Service;
  private isDimmer: boolean;
  private lastLevel = 100; // remembered brightness for On without a level

  constructor(platform: Control4Platform, accessory: PlatformAccessory, item: C4Item) {
    super(platform, accessory, item);
    // light_v2 is always dimmable; legacy "light" may be a relay. Heuristic until
    // a first read reveals a brightness variable, then we trust that.
    const nm = (item.name + ' ' + (item.model ?? '')).toLowerCase();
    this.isDimmer = item.proxy === 'light_v2' || /dimmer|hue|lamp|chandelier|pendant|recessed|sconce|landscape|spot/.test(nm);

    this.service = accessory.getService(platform.Service.Lightbulb)
      || accessory.addService(platform.Service.Lightbulb, item.name);
    this.service.setCharacteristic(platform.Characteristic.Name, item.name);

    this.service.getCharacteristic(platform.Characteristic.On)
      .onGet(() => this.getOn())
      .onSet((v) => this.setOn(v));

    if (this.isDimmer) {
      this.service.getCharacteristic(platform.Characteristic.Brightness)
        .onGet(() => this.getBrightness())
        .onSet((v) => this.setBrightness(v));
    }
  }

  private cachedLevel = 0;

  async refresh(): Promise<void> {
    const vars = await this.variables();
    const raw = this.pick(vars, ['LIGHT_LEVEL', 'LEVEL', 'Brightness', 'BRIGHTNESS', 'Light Level', 'brightness']);
    if (raw !== undefined) {
      const lvl = Math.max(0, Math.min(100, Math.round(Number(raw))));
      this.cachedLevel = lvl;
      if (lvl > 0) {
        this.lastLevel = lvl;
      }
      this.service.updateCharacteristic(this.platform.Characteristic.On, lvl > 0);
      if (this.isDimmer) {
        this.service.updateCharacteristic(this.platform.Characteristic.Brightness, lvl);
      }
    }
  }

  private getOn(): CharacteristicValue {
    return this.cachedLevel > 0;
  }

  private async setOn(value: CharacteristicValue): Promise<void> {
    const on = value as boolean;
    // Prefer explicit ON/OFF; fall back to a level set for relays that lack them.
    await this.platform.sendCommand(this.id, on ? 'ON' : 'OFF', {})
      .catch(() => this.platform.sendCommand(this.id, 'SET_LEVEL', { LEVEL: on ? this.lastLevel : 0 }));
    this.cachedLevel = on ? this.lastLevel : 0;
  }

  private getBrightness(): CharacteristicValue {
    return this.cachedLevel;
  }

  private async setBrightness(value: CharacteristicValue): Promise<void> {
    const lvl = Math.max(0, Math.min(100, Math.round(Number(value))));
    this.cachedLevel = lvl;
    if (lvl > 0) {
      this.lastLevel = lvl;
    }
    // light_v2 takes SET_LEVEL { LEVEL, TIME(ms) }; TIME 0 = instant.
    await this.platform.sendCommand(this.id, 'SET_LEVEL', { LEVEL: lvl, TIME: 0 })
      .catch(() => this.platform.sendCommand(this.id, 'RAMP_TO_LEVEL', { LEVEL: lvl, TIME: 0 }));
  }
}

/** Control4 door-lock proxy → HomeKit Lock Mechanism. */
export class LockAccessory extends C4Accessory {
  private service: Service;

  constructor(platform: Control4Platform, accessory: PlatformAccessory, item: C4Item) {
    super(platform, accessory, item);
    this.service = accessory.getService(platform.Service.LockMechanism)
      || accessory.addService(platform.Service.LockMechanism, item.name);
    this.service.setCharacteristic(platform.Characteristic.Name, item.name);

    this.service.getCharacteristic(platform.Characteristic.LockTargetState)
      .onGet(() => this.cachedSecured ? 1 : 0)
      .onSet((v) => this.setTarget(v));
    this.service.getCharacteristic(platform.Characteristic.LockCurrentState)
      .onGet(() => this.cachedSecured ? 1 : 0);
  }

  private cachedSecured = true;

  async refresh(): Promise<void> {
    const vars = await this.variables();
    const raw = this.pick(vars, ['LockStatus', 'LOCK_STATUS', 'Locked', 'locked', 'DoorState', 'RelayState']);
    if (raw === undefined) {
      return;
    }
    const s = String(raw).toLowerCase();
    const secured = s === 'locked' || s === '1' || s === 'true' || s === 'closed';
    this.cachedSecured = secured;
    const C = this.platform.Characteristic;
    this.service.updateCharacteristic(C.LockCurrentState, secured ? 1 : 0);
    this.service.updateCharacteristic(C.LockTargetState, secured ? 1 : 0);
  }

  private async setTarget(value: CharacteristicValue): Promise<void> {
    const secure = Number(value) === 1;
    await this.platform.sendCommand(this.id, secure ? 'LOCK' : 'UNLOCK', {})
      .catch(() => this.platform.sendCommand(this.id, 'TOGGLE', {}));
    this.cachedSecured = secure;
    this.service.updateCharacteristic(this.platform.Characteristic.LockCurrentState, secure ? 1 : 0);
  }
}

import { PlatformAccessory, Service, CharacteristicValue } from 'homebridge';
import { Control4Platform } from './platform';
import { C4Item } from './control4/director';

// Control4 light_v2 expresses colour as CIE xy chromaticity; CCT is an xy point on the
// Planckian locus. These port the conversions our control4-tuya driver uses.
function kelvinToXy(k: number): [number, number] {
  k = Math.max(1667, Math.min(25000, k));
  const x = k <= 4000
    ? -0.2661239e9 / k ** 3 - 0.2343589e6 / k ** 2 + 0.8776956e3 / k + 0.179910
    : -3.0258469e9 / k ** 3 + 2.1070379e6 / k ** 2 + 0.2226347e3 / k + 0.240390;
  const y = k <= 2222
    ? -1.1063814 * x ** 3 - 1.34811020 * x ** 2 + 2.18555832 * x - 0.20219683
    : k <= 4000
      ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
      : 3.0817580 * x ** 3 - 5.87338670 * x ** 2 + 3.75112997 * x - 0.37001483;
  return [x, y];
}
function xyToKelvin(x: number, y: number): number {
  const n = (x - 0.3320) / (0.1858 - y);
  return 449 * n ** 3 + 3525 * n ** 2 + 6823.3 * n + 5520.33;
}

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

    // HomeKit rejects a Manufacturer/Model shorter than 2 chars, and the named light
    // "loads" often carry an empty model, so fall back to the proxy type.
    const manufacturer = String(item.manufacturer || '').length > 1 ? String(item.manufacturer) : 'Control4';
    const rawModel = String(item.model || '');
    const model = rawModel.length > 1 ? rawModel : `Control4 ${item.proxy || 'device'}`;

    const info = accessory.getService(platform.Service.AccessoryInformation)
      || accessory.addService(platform.Service.AccessoryInformation);
    info
      .setCharacteristic(platform.Characteristic.Manufacturer, manufacturer)
      .setCharacteristic(platform.Characteristic.Model, model)
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

    void this.initColor();
  }

  /** Wire colour-temperature + Adaptive Lighting for lights that report CCT support. */
  private async initColor(): Promise<void> {
    try {
      const vars = await this.variables();
      const ndc = vars['Navigator Dynamic Capabilities'] as { DynamicCapabilities?: Record<string, unknown> } | undefined;
      const caps = (ndc && ndc.DynamicCapabilities) || (ndc as Record<string, unknown> | undefined);
      if (!caps || caps['supports_color_correlated_temperature'] !== true) {
        return;
      }
      const kMin = Number(caps['color_correlated_temperature_min']) || 2700;
      const kMax = Number(caps['color_correlated_temperature_max']) || 6500;
      this.minMired = Math.round(1e6 / kMax);
      this.maxMired = Math.round(1e6 / kMin);
      const C = this.platform.Characteristic;
      const ct = this.service.getCharacteristic(C.ColorTemperature);
      ct.setProps({ minValue: this.minMired, maxValue: this.maxMired });
      ct.onGet(() => this.cachedMired).onSet((v) => this.setColorTemp(Number(v)));
      this.cctWired = true;

      // Adaptive Lighting: HomeKit shifts colour temperature across the day automatically.
      const hap = this.platform.api.hap as unknown as { AdaptiveLightingController?: new (s: Service) => unknown };
      if (hap.AdaptiveLightingController) {
        const controller = new hap.AdaptiveLightingController(this.service);
        (this.accessory as unknown as { configureController: (c: unknown) => void }).configureController(controller);
      }
    } catch {
      /* capabilities unavailable / AL unsupported — leave the light as on/off+brightness */
    }
  }

  private cachedLevel = 0;
  private cachedOn = false;
  private cctWired = false;
  private minMired = 153;
  private maxMired = 500;
  private cachedMired = 250;

  async refresh(): Promise<void> {
    const vars = await this.variables();
    // Control4 light_v2 reports "Brightness Percent" (0-100) and "LIGHT_STATE" (1/0);
    // legacy "light" uses LEVEL. Read whichever is present.
    const rawLevel = this.pick(vars, ['Brightness Percent', 'LIGHT_LEVEL', 'LEVEL', 'Light Level']);
    const rawState = this.pick(vars, ['LIGHT_STATE', 'POWER_STATE']);
    if (rawLevel !== undefined) {
      const lvl = Math.max(0, Math.min(100, Math.round(Number(rawLevel))));
      this.cachedLevel = lvl;
      if (lvl > 0) {
        this.lastLevel = lvl;
      }
      if (this.isDimmer) {
        this.service.updateCharacteristic(this.platform.Characteristic.Brightness, lvl);
      }
    }
    this.cachedOn = rawState !== undefined ? Number(rawState) > 0 : this.cachedLevel > 0;
    this.service.updateCharacteristic(this.platform.Characteristic.On, this.cachedOn);

    this.applyColorCapability(vars);
  }

  /** Update the colour-temperature value from the light's current xy colour. */
  private applyColorCapability(vars: Record<string, unknown>): void {
    if (!this.cctWired) {
      return;
    }
    const x = this.pick(vars, ['LIGHT_COLOR_CURRENT_X', 'Color X']);
    const y = this.pick(vars, ['LIGHT_COLOR_CURRENT_Y', 'Color Y']);
    if (x !== undefined && y !== undefined) {
      const mired = Math.round(1e6 / xyToKelvin(Number(x), Number(y)));
      this.cachedMired = Math.max(this.minMired, Math.min(this.maxMired, mired));
      this.service.updateCharacteristic(this.platform.Characteristic.ColorTemperature, this.cachedMired);
    }
  }

  private async setColorTemp(mired: number): Promise<void> {
    const m = Math.max(this.minMired, Math.min(this.maxMired, Math.round(mired)));
    const [x, y] = kelvinToXy(1e6 / m);
    // LIGHT_COLOR_TARGET_MODE 1 = colour-temperature mode (0 = full colour).
    await this.platform.sendCommand(this.id, 'SET_COLOR_TARGET', {
      LIGHT_COLOR_TARGET_X: x,
      LIGHT_COLOR_TARGET_Y: y,
      LIGHT_COLOR_TARGET_MODE: 1,
    });
    this.cachedMired = m;
  }

  private getOn(): CharacteristicValue {
    return this.cachedOn;
  }

  private async setOn(value: CharacteristicValue): Promise<void> {
    const on = value as boolean;
    // ON/OFF are accepted by light_v2; fall back to a level set for relays that lack them.
    await this.platform.sendCommand(this.id, on ? 'ON' : 'OFF', {})
      .catch(() => this.platform.sendCommand(this.id, 'SET_LEVEL', { LEVEL: on ? this.lastLevel : 0, TIME: 0 }));
    this.cachedOn = on;
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

import { PlatformAccessory, Service } from 'homebridge';
import { Control4Platform } from './platform';
import { C4Item } from './control4/director';

/** Normalize a name for matching a sensor to a camera. */
export function normName(s: string): string {
  return String(s).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * A Control4 contact / motion sensor exposed as a HomeKit MotionSensor. If its name matches a
 * camera, it also drives that camera's HomeKit Secure Video motion trigger — so camera recording
 * is triggered by a normal Control4 sensor (fed, for example, by a separate DVR-motion driver),
 * and this plugin stays completely device-agnostic.
 */
export class MotionSensorAccessory {
  private readonly service: Service;
  private readonly id: number;
  private cachedMotion = false;

  /** Optional camera HKSV motion service driven in lockstep with this sensor. */
  public linkedCameraMotion?: Service;

  constructor(
    private readonly platform: Control4Platform,
    public readonly accessory: PlatformAccessory,
    item: C4Item,
  ) {
    this.id = item.id;
    const C = platform.Characteristic;
    const S = platform.Service;
    (accessory.getService(S.AccessoryInformation) || accessory.addService(S.AccessoryInformation))
      .setCharacteristic(C.Manufacturer, 'Control4')
      .setCharacteristic(C.Model, 'Control4 Motion Sensor')
      .setCharacteristic(C.SerialNumber, `c4-sensor-${item.id}`);

    this.service = accessory.getService(S.MotionSensor) || accessory.addService(S.MotionSensor, item.name);
    this.service.setCharacteristic(C.Name, item.name);
    this.service.getCharacteristic(C.MotionDetected).onGet(() => this.cachedMotion);
  }

  async refresh(): Promise<void> {
    const vars = await this.platform.getVariables(this.id).catch(() => []);
    let raw: unknown;
    for (const v of vars) {
      if (['ContactState', 'Contact State', 'CONTACT_STATE', 'MotionDetected', 'MOTION', 'state'].includes(v.name)) {
        raw = v.value;
        break;
      }
    }
    if (raw === undefined) {
      return;
    }
    const s = String(raw).toLowerCase();
    const motion = s === 'opened' || s === 'open' || s === '1' || s === 'true' || s === 'motion' || s === 'detected' || s === 'active';
    this.cachedMotion = motion;
    const C = this.platform.Characteristic;
    this.service.updateCharacteristic(C.MotionDetected, motion);
    if (this.linkedCameraMotion) {
      this.linkedCameraMotion.updateCharacteristic(C.MotionDetected, motion);
    }
  }
}

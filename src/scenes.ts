import { PlatformAccessory, Service } from 'homebridge';
import { Control4Platform } from './platform';

/**
 * A Control4 Advanced Lighting scene exposed as a HomeKit switch: turning it on
 * runs ACTIVATE_SCENE on the advanced-lighting agent, off runs DEACTIVATE_SCENE.
 * The switch reflects the scene's live `is_active` state, so it can be triggered
 * by Siri/automations and added to HomeKit scenes.
 */
export class SceneSwitch {
  private readonly service: Service;
  private cachedOn = false;

  constructor(
    private readonly platform: Control4Platform,
    public readonly accessory: PlatformAccessory,
    private readonly agentId: number,
    public readonly sceneId: number,
    name: string,
  ) {
    const C = platform.Characteristic;
    const S = platform.Service;
    (accessory.getService(S.AccessoryInformation) || accessory.addService(S.AccessoryInformation))
      .setCharacteristic(C.Manufacturer, 'Control4')
      .setCharacteristic(C.Model, 'Control4 Lighting Scene')
      .setCharacteristic(C.SerialNumber, `c4-scene-${sceneId}`);

    this.service = accessory.getService(S.Switch) || accessory.addService(S.Switch, name);
    this.service.setCharacteristic(C.Name, name);
    this.service.getCharacteristic(C.On)
      .onGet(() => this.cachedOn)
      .onSet((v) => this.set(!!v));
  }

  private async set(on: boolean): Promise<void> {
    await this.platform.sendCommand(this.agentId, on ? 'ACTIVATE_SCENE' : 'DEACTIVATE_SCENE', { SCENE_ID: this.sceneId });
    this.cachedOn = on;
  }

  /** Push the scene's live active state into HomeKit. */
  update(isActive: boolean): void {
    this.cachedOn = isActive;
    this.service.updateCharacteristic(this.platform.Characteristic.On, isActive);
  }
}

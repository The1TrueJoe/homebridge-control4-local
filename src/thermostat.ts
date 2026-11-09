import { PlatformAccessory, Service, CharacteristicValue } from 'homebridge';
import { C4Accessory } from './accessories';
import { Control4Platform } from './platform';
import { C4Item } from './control4/director';

/**
 * Control4 thermostatV2 proxy -> HomeKit Thermostat.
 *
 * HomeKit works in Celsius internally; Control4 may report Fahrenheit or Celsius, so we read
 * whichever variables are present (*_C preferred, else *_F converted). Setpoints are sent back
 * with both CELSIUS and FAHRENHEIT so the driver can take whichever unit it uses.
 *
 * This flows through the bridged HANDLERS path (like lights/locks): the platform registers the
 * accessory and calls refresh() on poll/rediscover.
 */
export class ThermostatAccessory extends C4Accessory {
  private readonly service: Service;
  private displayF = true;
  private curTempC = 20;
  private heatC = 20;
  private coolC = 24;
  private humidity = 0;
  private mode = 0; // HomeKit TargetHeatingCoolingState (0 Off, 1 Heat, 2 Cool, 3 Auto)
  private state = 0; // HomeKit CurrentHeatingCoolingState (0 Off, 1 Heat, 2 Cool)

  constructor(platform: Control4Platform, accessory: PlatformAccessory, item: C4Item) {
    super(platform, accessory, item);
    const C = platform.Characteristic;
    const S = platform.Service;
    this.service = accessory.getService(S.Thermostat) || accessory.addService(S.Thermostat, item.name);
    this.service.setCharacteristic(C.Name, item.name);

    this.service.getCharacteristic(C.CurrentTemperature).onGet(() => this.curTempC);
    this.service.getCharacteristic(C.TargetTemperature)
      .setProps({ minValue: 10, maxValue: 38, minStep: 0.5 })
      .onGet(() => this.clamp(this.targetC()))
      .onSet((v) => this.setTarget(v));
    this.service.getCharacteristic(C.CurrentHeatingCoolingState).onGet(() => this.state);
    this.service.getCharacteristic(C.TargetHeatingCoolingState).onGet(() => this.mode).onSet((v) => this.setMode(Number(v)));
    this.service.getCharacteristic(C.TemperatureDisplayUnits)
      .onGet(() => (this.displayF ? C.TemperatureDisplayUnits.FAHRENHEIT : C.TemperatureDisplayUnits.CELSIUS));
    this.service.getCharacteristic(C.HeatingThresholdTemperature)
      .setProps({ minValue: 10, maxValue: 38, minStep: 0.5 })
      .onGet(() => this.clamp(this.heatC)).onSet((v) => this.setHeat(Number(v)));
    this.service.getCharacteristic(C.CoolingThresholdTemperature)
      .setProps({ minValue: 10, maxValue: 38, minStep: 0.5 })
      .onGet(() => this.clamp(this.coolC)).onSet((v) => this.setCool(Number(v)));
    this.service.getCharacteristic(C.CurrentRelativeHumidity).onGet(() => this.humidity);
  }

  private toC(f: number): number { return (f - 32) * 5 / 9; }
  private toF(c: number): number { return c * 9 / 5 + 32; }
  private clamp(c: number): number { return Math.max(10, Math.min(38, c)); }
  private targetC(): number {
    return this.mode === 2 ? this.coolC : this.mode === 1 ? this.heatC : (this.heatC + this.coolC) / 2;
  }

  async refresh(): Promise<void> {
    const vars = await this.variables();
    const scale = String(this.pick(vars, ['SCALE']) ?? '').toUpperCase();
    this.displayF = scale.startsWith('F');

    const tC = this.pick(vars, ['TEMPERATURE_C']);
    const tF = this.pick(vars, ['TEMPERATURE_F', 'TEMPERATURE']);
    if (tC !== undefined) {
      this.curTempC = Number(tC);
    } else if (tF !== undefined) {
      this.curTempC = this.toC(Number(tF));
    }
    const hC = this.pick(vars, ['HEAT_SETPOINT_C']);
    const hF = this.pick(vars, ['HEAT_SETPOINT_F']);
    if (hC !== undefined) {
      this.heatC = Number(hC);
    } else if (hF !== undefined) {
      this.heatC = this.toC(Number(hF));
    }
    const cC = this.pick(vars, ['COOL_SETPOINT_C']);
    const cF = this.pick(vars, ['COOL_SETPOINT_F']);
    if (cC !== undefined) {
      this.coolC = Number(cC);
    } else if (cF !== undefined) {
      this.coolC = this.toC(Number(cF));
    }
    const hvacMode = String(this.pick(vars, ['HVAC_MODE']) ?? '').toLowerCase();
    this.mode = hvacMode.includes('auto') ? 3 : hvacMode.includes('heat') ? 1 : hvacMode.includes('cool') ? 2 : 0;
    const hvacState = String(this.pick(vars, ['HVAC_STATE']) ?? '').toLowerCase();
    this.state = hvacState.includes('heat') ? 1 : hvacState.includes('cool') ? 2 : 0;
    const hum = this.pick(vars, ['HUMIDITY']);
    if (hum !== undefined) {
      this.humidity = Math.max(0, Math.min(100, Math.round(Number(hum))));
    }

    const C = this.platform.Characteristic;
    this.service.updateCharacteristic(C.CurrentTemperature, this.curTempC);
    this.service.updateCharacteristic(C.TargetTemperature, this.clamp(this.targetC()));
    this.service.updateCharacteristic(C.CurrentHeatingCoolingState, this.state);
    this.service.updateCharacteristic(C.TargetHeatingCoolingState, this.mode);
    this.service.updateCharacteristic(C.HeatingThresholdTemperature, this.clamp(this.heatC));
    this.service.updateCharacteristic(C.CoolingThresholdTemperature, this.clamp(this.coolC));
    this.service.updateCharacteristic(C.TemperatureDisplayUnits, this.displayF ? C.TemperatureDisplayUnits.FAHRENHEIT : C.TemperatureDisplayUnits.CELSIUS);
    this.service.updateCharacteristic(C.CurrentRelativeHumidity, this.humidity);
  }

  private async setMode(m: number): Promise<void> {
    const name = m === 3 ? 'Auto' : m === 2 ? 'Cool' : m === 1 ? 'Heat' : 'Off';
    await this.platform.sendCommand(this.id, 'SET_MODE_HVAC', { MODE: name });
    this.mode = m;
  }

  private async setTarget(c: CharacteristicValue): Promise<void> {
    const t = Number(c);
    if (this.mode === 2) {
      await this.setCool(t);
    } else {
      await this.setHeat(t);
    }
  }

  private async setHeat(c: number): Promise<void> {
    this.heatC = c;
    await this.sendSetpoint('SET_SETPOINT_HEAT', c);
  }

  private async setCool(c: number): Promise<void> {
    this.coolC = c;
    await this.sendSetpoint('SET_SETPOINT_COOL', c);
  }

  private async sendSetpoint(cmd: string, c: number): Promise<void> {
    await this.platform.sendCommand(this.id, cmd, {
      CELSIUS: Math.round(c * 10) / 10,
      FAHRENHEIT: Math.round(this.toF(c)),
    });
  }
}

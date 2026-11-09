import { PlatformAccessory, Service, CharacteristicValue } from 'homebridge';
import { Control4Platform } from './platform';
import { C4Item } from './control4/director';

export interface RoomSource {
  /** Control4 device id used with SELECT_VIDEO_DEVICE. */
  id: number;
  name: string;
}

/**
 * A Control4 room exposed as a HomeKit Television. The ROOM — not the physical TV —
 * is the stateful unit: Control4 tracks POWER_STATE, CURRENT_VIDEO_DEVICE (the input),
 * CURRENT_VOLUME and IS_MUTED on the room regardless of whether the display is IR- or
 * IP-controlled. So power/input/volume all have real feedback, and the inputs are exactly
 * the room's Control4 sources.
 *
 * Television accessories must be published as EXTERNAL accessories (one HomeKit device
 * each); the platform does that and then calls refresh() on a poll.
 */
export class RoomTelevision {
  private readonly tv: Service;
  private readonly speaker: Service;
  private readonly roomId: number;
  private readonly inputs: RoomSource[];
  private readonly c4ByIdentifier = new Map<number, number>();
  private readonly identifierByC4 = new Map<number, number>();

  private cachedOn = false;
  private cachedVolume = 0;
  private cachedMuted = false;
  private cachedInputC4 = 0;
  private lastInputC4 = 0;

  constructor(
    private readonly platform: Control4Platform,
    public readonly accessory: PlatformAccessory,
    room: C4Item,
    inputs: RoomSource[],
  ) {
    this.roomId = room.id;
    this.inputs = inputs;
    const C = platform.Characteristic;
    const S = platform.Service;

    (accessory.getService(S.AccessoryInformation) || accessory.addService(S.AccessoryInformation))
      .setCharacteristic(C.Manufacturer, 'Control4')
      .setCharacteristic(C.Model, 'Control4 Room')
      .setCharacteristic(C.SerialNumber, `c4-room-${room.id}`);

    this.tv = accessory.getService(S.Television) || accessory.addService(S.Television);
    this.tv
      .setCharacteristic(C.ConfiguredName, room.name)
      .setCharacteristic(C.SleepDiscoveryMode, C.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);
    this.tv.getCharacteristic(C.Active)
      .onGet(() => (this.cachedOn ? C.Active.ACTIVE : C.Active.INACTIVE))
      .onSet((v) => this.setActive(v));
    this.tv.getCharacteristic(C.ActiveIdentifier)
      .onGet(() => this.identifierByC4.get(this.cachedInputC4) ?? 0)
      .onSet((v) => this.setInput(Number(v)));
    this.tv.getCharacteristic(C.RemoteKey).onSet((v) => this.remoteKey(Number(v)));

    inputs.forEach((src, i) => {
      const identifier = i + 1;
      this.c4ByIdentifier.set(identifier, src.id);
      this.identifierByC4.set(src.id, identifier);
      const input = accessory.getServiceById(S.InputSource, `in-${src.id}`)
        || accessory.addService(S.InputSource, src.name, `in-${src.id}`);
      input
        .setCharacteristic(C.Identifier, identifier)
        .setCharacteristic(C.ConfiguredName, src.name)
        .setCharacteristic(C.IsConfigured, C.IsConfigured.CONFIGURED)
        .setCharacteristic(C.InputSourceType, C.InputSourceType.HDMI)
        .setCharacteristic(C.CurrentVisibilityState, C.CurrentVisibilityState.SHOWN);
      this.tv.addLinkedService(input);
    });

    this.speaker = accessory.getService(S.TelevisionSpeaker) || accessory.addService(S.TelevisionSpeaker);
    this.speaker
      .setCharacteristic(C.Active, C.Active.ACTIVE)
      .setCharacteristic(C.VolumeControlType, C.VolumeControlType.ABSOLUTE);
    this.speaker.getCharacteristic(C.VolumeSelector).onSet((v) => this.volumeStep(Number(v)));
    this.speaker.getCharacteristic(C.Mute)
      .onGet(() => this.cachedMuted)
      .onSet((v) => this.setMute(!!v));
    this.speaker.getCharacteristic(C.Volume)
      .onGet(() => this.cachedVolume)
      .onSet((v) => this.setVolume(Number(v)));
    this.tv.addLinkedService(this.speaker);
  }

  /** Pull the room's live state into HomeKit. */
  async refresh(): Promise<void> {
    const vars = await this.platform.getVariables(this.roomId).catch(() => []);
    const m: Record<string, unknown> = {};
    for (const v of vars) {
      m[v.name] = v.value;
    }
    const C = this.platform.Characteristic;

    if (m.POWER_STATE !== undefined) {
      this.cachedOn = Number(m.POWER_STATE) > 0;
      this.tv.updateCharacteristic(C.Active, this.cachedOn ? C.Active.ACTIVE : C.Active.INACTIVE);
    }
    if (m.CURRENT_VOLUME !== undefined) {
      this.cachedVolume = Math.max(0, Math.min(100, Math.round(Number(m.CURRENT_VOLUME))));
      this.speaker.updateCharacteristic(C.Volume, this.cachedVolume);
    }
    if (m.IS_MUTED !== undefined) {
      this.cachedMuted = Number(m.IS_MUTED) > 0;
      this.speaker.updateCharacteristic(C.Mute, this.cachedMuted);
    }
    if (m.CURRENT_VIDEO_DEVICE !== undefined) {
      this.cachedInputC4 = Number(m.CURRENT_VIDEO_DEVICE);
      if (this.cachedInputC4 > 0) {
        this.lastInputC4 = this.cachedInputC4;
      }
      const id = this.identifierByC4.get(this.cachedInputC4);
      if (id) {
        this.tv.updateCharacteristic(C.ActiveIdentifier, id);
      }
    }
  }

  private async setActive(value: CharacteristicValue): Promise<void> {
    const on = Number(value) === this.platform.Characteristic.Active.ACTIVE;
    if (on) {
      // Control4 has no ROOM_ON; a room turns on by selecting a source.
      const target = this.lastInputC4 || this.inputs[0]?.id;
      if (target) {
        await this.platform.sendCommand(this.roomId, 'SELECT_VIDEO_DEVICE', { deviceid: target });
      }
    } else {
      await this.platform.sendCommand(this.roomId, 'ROOM_OFF', {});
    }
    this.cachedOn = on;
  }

  private async setInput(identifier: number): Promise<void> {
    const c4 = this.c4ByIdentifier.get(identifier);
    if (c4) {
      await this.platform.sendCommand(this.roomId, 'SELECT_VIDEO_DEVICE', { deviceid: c4 });
      this.cachedInputC4 = c4;
      this.lastInputC4 = c4;
      this.cachedOn = true;
    }
  }

  private async setVolume(level: number): Promise<void> {
    const l = Math.max(0, Math.min(100, Math.round(level)));
    await this.platform.sendCommand(this.roomId, 'SET_VOLUME_LEVEL', { LEVEL: l });
    this.cachedVolume = l;
  }

  private async volumeStep(selector: number): Promise<void> {
    // HAP VolumeSelector: 0 = INCREMENT, 1 = DECREMENT.
    await this.setVolume(this.cachedVolume + (selector === 0 ? 3 : -3));
  }

  private async setMute(mute: boolean): Promise<void> {
    await this.platform.sendCommand(this.roomId, mute ? 'MUTE_ON' : 'MUTE_OFF', {});
    this.cachedMuted = mute;
  }

  private async remoteKey(key: number): Promise<void> {
    const C = this.platform.Characteristic.RemoteKey;
    const map: Record<number, string> = {
      [C.ARROW_UP]: 'UP', [C.ARROW_DOWN]: 'DOWN', [C.ARROW_LEFT]: 'LEFT', [C.ARROW_RIGHT]: 'RIGHT',
      [C.SELECT]: 'ENTER', [C.BACK]: 'CANCEL', [C.EXIT]: 'CANCEL', [C.INFORMATION]: 'INFO',
      [C.PLAY_PAUSE]: 'PLAY',
    };
    const cmd = map[key];
    if (cmd) {
      // Transport/cursor isn't always a room command; best-effort and silent on failure.
      await this.platform.sendCommand(this.roomId, cmd, {}).catch(() => undefined);
    }
  }
}

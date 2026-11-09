import {
  API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { Control4Account } from './control4/account';
import { Control4Director, C4Item, C4Variable, UnauthorizedError } from './control4/director';
import { C4Accessory, LightAccessory, LockAccessory } from './accessories';
import { RoomTelevision, RoomVolume, RoomSource } from './television';
import { resolveCamera } from './cameraResolver';
import { C4CameraDelegate, attachCameraController } from './camera';
import { C4RecordingDelegate } from './cameraRecording';
import { SceneSwitch } from './scenes';

export interface Control4Config extends PlatformConfig {
  username?: string;
  password?: string;
  controllerIp?: string;
  controllerCommonName?: string;
  pollSeconds?: number;
  excludeRooms?: string[];
  /** Expose each room that has a TV as a HomeKit Television (default true). */
  exposeTvs?: boolean;
  /** Expose Control4 cameras as HomeKit cameras (default true). */
  exposeCameras?: boolean;
  /** HomeKit Secure Video: motion-triggered recording on the cameras (default true; needs iCloud+). */
  secureVideo?: boolean;
  /** Keep a continuous prebuffer so clips include seconds before the trigger (default false =
   *  on-demand, lighter on memory; true adds one persistent ffmpeg per camera). */
  cameraPrebuffer?: boolean;
  /** Minutes between automatic re-discoveries, so adds/removes/renames sync live (default 10). */
  rediscoverMinutes?: number;
  /** Add a HomeKit volume-slider tile per room with a TV (default true). */
  volumeSliders?: boolean;
  /** Expose Control4 Advanced Lighting scenes as HomeKit switches (default true). */
  exposeScenes?: boolean;
  /** Milliseconds for smooth dimming ramps (default 1000; 0 = instant). */
  dimRampMs?: number;
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
  private readonly televisions: RoomTelevision[] = [];
  private readonly volumeHandlers: RoomVolume[] = [];
  private readonly sceneHandlers: SceneSwitch[] = [];
  private advLightingAgentId?: number;
  private readonly cameraUuidsWithController = new Set<string>();
  private readonly tvByRoom = new Map<number, PlatformAccessory>();
  private firstSync = true;
  private rediscoverTimer?: NodeJS.Timeout;

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
    this.api.on('shutdown', () => {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
      }
      if (this.rediscoverTimer) {
        clearInterval(this.rediscoverTimer);
      }
    });
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

    await this.syncDevices();

    const period = Math.max(5, this.config.pollSeconds ?? 30) * 1000;
    this.pollTimer = setInterval(() => this.poll().catch((e) => this.log.debug('poll error:', e?.message || e)), period);

    // Re-read the project periodically so devices added/removed/renamed in Control4
    // appear or disappear in HomeKit without a Homebridge restart.
    const rediscover = Math.max(1, this.config.rediscoverMinutes ?? 10) * 60000;
    this.rediscoverTimer = setInterval(() => this.syncDevices().catch((e) => this.log.debug('re-discover error:', e?.message || e)), rediscover);
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

  private async syncDevices(): Promise<void> {
    const items = await this.withAuth(() => this.director!.getAllItems());
    const exclude = new Set((this.config.excludeRooms || []).map((r) => r.toLowerCase()));

    if (this.firstSync) {
      // Visibility: what proxies does this system have, and which do we not map yet?
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
    }

    // Rebuilt every sync so handlers always point at the current accessories.
    this.handlers.clear();

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
        this.cached.push(accessory);
      } else {
        accessory.context.item = it;
        accessory.displayName = it.name; // reflect a Control4 rename
      }
      const Handler = HANDLERS[String(it.proxy)];
      this.handlers.set(uuid, new Handler(this, accessory, it));
    }

    await this.discoverCameras(items, activeUuids);
    await this.discoverTelevisions(items, activeUuids);
    await this.discoverScenes(items, activeUuids);

    // Drop bridged accessories that no longer exist in the project (deleted in Control4).
    const stale = this.cached.filter((a) => !activeUuids.has(a.UUID));
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      for (const a of stale) {
        const i = this.cached.indexOf(a);
        if (i >= 0) {
          this.cached.splice(i, 1);
        }
        this.cameraUuidsWithController.delete(a.UUID);
      }
      this.log.info(`Control4: removed ${stale.length} device(s) no longer in the project.`);
    }

    this.log.info(`Control4: ${chosen.length} bridged device(s) (from ${items.length} items).`);
    await this.poll();

    this.firstSync = false;
  }

  /** Expose each room that has a TV as a HomeKit Television (external accessory). The ROOM
   *  holds the state (power/input/volume), so this works for IR- and IP-controlled TVs alike. */
  private async discoverTelevisions(items: C4Item[], activeUuids: Set<string>): Promise<void> {
    if (this.config.exposeTvs === false) {
      return;
    }
    const roomIdOf = (it: C4Item) => Number((it as { roomId?: number }).roomId ?? 0);
    const tvRoomIds = new Set(items.filter((it) => it.proxy === 'tv').map(roomIdOf).filter(Boolean));
    const rooms = items.filter((it) => it.proxy === 'roomdevice' && tvRoomIds.has(roomIdOf(it)));
    const desiredRoomIds = new Set(rooms.map((r) => roomIdOf(r) || r.id));

    // The Navigator's per-room ENABLED "watch" sources (authoritative), keyed by room id.
    const uic = await this.withAuth(() => this.director!.rawGet('/api/v1/agents/ui_configuration')).catch(() => ({}));
    const experiences = (uic as { experiences?: Array<{ type?: string; room_id?: number; sources?: { source?: Array<{ id?: number }> } }> }).experiences || [];
    const watchByRoom = new Map<number, number[]>();
    for (const exp of experiences) {
      if (exp?.type === 'watch') {
        const ids = (exp.sources?.source || [])
          .map((s) => Number(s.id))
          .filter((n) => Number.isFinite(n) && n > 0 && n < 1e9);
        watchByRoom.set(Number(exp.room_id), ids);
      }
    }
    const itemsById = new Map(items.map((it) => [it.id, it] as const));
    const srcProxies = new Set(['media_player', 'dvd', 'tuner', 'avswitch', 'receiver', 'tv', 'cable']);

    const toPublish: PlatformAccessory[] = [];
    for (const room of rooms) {
      const rid = roomIdOf(room) || room.id;

      // A bridged volume-slider tile per TV room (persistent; keep its uuid active each sync).
      if (this.config.volumeSliders !== false) {
        const vUuid = this.api.hap.uuid.generate(`c4:room-vol:${room.id}`);
        activeUuids.add(vUuid);
        let vAcc = this.cached.find((a) => a.UUID === vUuid);
        if (!vAcc) {
          vAcc = new this.api.platformAccessory(`${room.name} Volume`, vUuid);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [vAcc]);
          this.cached.push(vAcc);
        }
        if (!this.volumeHandlers.some((h) => h.accessory.UUID === vUuid)) {
          this.volumeHandlers.push(new RoomVolume(this, vAcc, room));
        }
      }

      if (this.tvByRoom.has(rid)) {
        continue; // TV already published; input/room changes take effect on next restart
      }

      // Inputs = only the sources the Navigator shows for this room (its watch list). Fall back to
      // the room's video_devices / local AV devices if the Navigator config doesn't cover it.
      let inputs: RoomSource[] = [];
      const watchIds = watchByRoom.get(rid) || [];
      if (watchIds.length) {
        inputs = watchIds.map((id) => ({ id, name: itemsById.get(id)?.name || `Source ${id}` }));
      } else {
        const vd = await this.withAuth(() => this.director!.rawGet(`/api/v1/locations/rooms/${rid}/video_devices`)).catch(() => ({}));
        const vis = (vd as { visible?: Array<{ id: number; name: string }> }).visible || [];
        inputs = vis.length
          ? vis.map((x) => ({ id: x.id, name: x.name }))
          : items.filter((it) => srcProxies.has(String(it.proxy)) && roomIdOf(it) === rid && it.id !== room.id).map((it) => ({ id: it.id, name: it.name }));
      }

      // If the room is linked to an on-screen navigator (OSD), expose "Control4" as a source.
      let hasOsd = false;
      const binds = await this.withAuth(() => this.director!.rawGet(`/api/v1/items/${room.id}/bindings`)).catch(() => []);
      const osd = (Array.isArray(binds) ? binds : []).find((b) =>
        (b as { bindingClass?: string }).bindingClass === 'ONSCREEN_SELECTION'
        && Array.isArray((b as { connections?: unknown[] }).connections)
        && (b as { connections: unknown[] }).connections.length > 0);
      if (osd) {
        const conn = (osd as { connections: Array<{ id?: number }> }).connections[0];
        const navId = Number(conn?.id);
        if (navId && !inputs.some((i) => i.id === navId)) {
          inputs.unshift({ id: navId, name: 'Control4' });
          hasOsd = true;
        }
      }

      if (!inputs.length) {
        inputs = [{ id: 0, name: 'Control4' }]; // placeholder so HomeKit accepts the accessory
      }

      const uuid = this.api.hap.uuid.generate(`c4:room-tv:${room.id}`);
      const accessory = new this.api.platformAccessory(room.name, uuid);
      accessory.category = this.api.hap.Categories.TELEVISION;
      this.televisions.push(new RoomTelevision(this, accessory, room, inputs));
      this.tvByRoom.set(rid, accessory);
      toPublish.push(accessory);
      this.log.info(`Control4: room TV "${room.name}" with ${inputs.length} input(s)${hasOsd ? ' (incl. Control4 OSD)' : ''}.`);
    }

    // Remove TVs whose room no longer has one (best-effort; externals fully clear on restart).
    for (const [rid, acc] of [...this.tvByRoom.entries()]) {
      if (!desiredRoomIds.has(rid)) {
        try {
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
        } catch {
          /* external accessories can't always be unregistered live */
        }
        this.tvByRoom.delete(rid);
        const idx = this.televisions.findIndex((t) => t.accessory.UUID === acc.UUID);
        if (idx >= 0) {
          this.televisions.splice(idx, 1);
        }
        this.log.info(`Control4: removed room TV (room ${rid}).`);
      }
    }

    if (toPublish.length) {
      this.api.publishExternalAccessories(PLUGIN_NAME, toPublish);
    }
  }

  /** Expose Control4 Advanced Lighting scenes as HomeKit switches. */
  private async discoverScenes(items: C4Item[], activeUuids: Set<string>): Promise<void> {
    if (this.config.exposeScenes === false) {
      return;
    }
    const agent = items.find((it) => it.proxy === 'control4_agent_adv_lighting');
    if (!agent) {
      return;
    }
    this.advLightingAgentId = agent.id;
    const scenes = await this.withAuth(() => this.director!.rawGet('/api/v1/agents/advanced_lighting')).catch(() => []);
    for (const sc of (Array.isArray(scenes) ? scenes : []) as Array<{ scene_id?: number; name?: string }>) {
      const sceneId = Number(sc.scene_id);
      if (!Number.isFinite(sceneId)) {
        continue;
      }
      const name = String(sc.name || `Scene ${sceneId}`);
      const uuid = this.api.hap.uuid.generate(`c4:scene:${sceneId}`);
      activeUuids.add(uuid);
      let acc = this.cached.find((a) => a.UUID === uuid);
      if (!acc) {
        acc = new this.api.platformAccessory(name, uuid);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
        this.cached.push(acc);
      } else {
        acc.displayName = name;
      }
      if (!this.sceneHandlers.some((h) => h.accessory.UUID === uuid)) {
        this.sceneHandlers.push(new SceneSwitch(this, acc, agent.id, sceneId, name));
      }
    }
    this.log.info(`Control4: ${this.sceneHandlers.length} lighting scene(s).`);
  }

  /** Expose Control4 cameras as HomeKit cameras. Stream/snapshot URLs are resolved
   *  token-only (GET_PROPERTIES → DVR address/creds); no DVR login needed. */
  private async discoverCameras(items: C4Item[], activeUuids: Set<string>): Promise<void> {
    if (this.config.exposeCameras === false) {
      return;
    }
    const cams = items.filter((it) => it.proxy === 'camera' || it.proxy === 'camera_v2');
    const camIds = new Set(cams.map((c) => c.id));
    const parents = new Set<number>();
    for (const c of cams) {
      const p = Number(c.parentId);
      if (camIds.has(p)) {
        parents.add(p); // this camera's parent is itself a camera → the parent is the DVR wrapper
      }
    }
    const leaves = cams.filter((c) => !parents.has(c.id));

    for (const cam of leaves) {
      const uuid = this.api.hap.uuid.generate(`c4:cam:${cam.id}`);
      activeUuids.add(uuid);
      const existing = this.cached.find((a) => a.UUID === uuid);
      if (existing && this.cameraUuidsWithController.has(uuid)) {
        existing.displayName = cam.name; // already wired; keep it and reflect any rename
        continue;
      }

      // New camera (or restored before its controller was attached): resolve + wire it up.
      const props = await this.withAuth(() => this.director!.rawGet(`/api/v1/items/${cam.id}/properties`)).catch(() => []);
      const list = Array.isArray(props) ? (props as Array<{ name?: string; value?: unknown }>) : [];
      const channel = Number(list.find((p) => p.name === 'Camera Number')?.value ?? 1);

      let resolved;
      try {
        resolved = await this.withAuth(() => resolveCamera(this.director!, cam, channel));
      } catch (e) {
        this.log.warn(`Control4: camera "${cam.name}" could not be resolved: ${(e as Error)?.message || e}`);
        continue;
      }

      const accessory = existing || new this.api.platformAccessory(cam.name, uuid);
      accessory.category = this.api.hap.Categories.CAMERA;
      (accessory.getService(this.Service.AccessoryInformation) || accessory.addService(this.Service.AccessoryInformation))
        .setCharacteristic(this.Characteristic.Manufacturer, 'Control4')
        .setCharacteristic(this.Characteristic.Model, 'Control4 Camera')
        .setCharacteristic(this.Characteristic.SerialNumber, `c4-cam-${cam.id}`);

      const delegate = new C4CameraDelegate({ hap: this.api.hap, log: this.log, displayName: cam.name, resolved });
      if (this.config.secureVideo === false) {
        attachCameraController(this.api, accessory, delegate);
      } else {
        // HomeKit Secure Video: add motion-triggered recording alongside live streaming.
        const recording = new C4RecordingDelegate({ hap: this.api.hap, log: this.log, displayName: cam.name, resolved, prebuffer: this.config.cameraPrebuffer === true });
        const options = {
          ...delegate.buildControllerOptions(),
          recording: { options: recording.buildRecordingOptions(), delegate: recording },
          sensors: { motion: true },
        };
        const controller = new this.api.hap.CameraController(options);
        delegate.controller = controller;
        (recording as unknown as { controller: unknown }).controller = controller;
        accessory.configureController(controller);
        // Motion trigger is driven by a linked Control4 motion sensor (see linkCameraMotion),
        // so the plugin stays device-agnostic — no DVR/vendor-specific code here.
      }
      this.cameraUuidsWithController.add(uuid);
      if (!existing) {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cached.push(accessory);
      }
      this.log.info(`Control4: camera "${cam.name}" (channel ${channel}) added.`);
    }
  }

  private async poll(): Promise<void> {
    for (const handler of this.handlers.values()) {
      await handler.refresh().catch((e) => this.log.debug('refresh error:', e?.message || e));
    }
    for (const tv of this.televisions) {
      await tv.refresh().catch((e) => this.log.debug('tv refresh error:', e?.message || e));
    }
    for (const vol of this.volumeHandlers) {
      await vol.refresh().catch((e) => this.log.debug('volume refresh error:', e?.message || e));
    }
    if (this.advLightingAgentId !== undefined && this.sceneHandlers.length) {
      const scenes = await this.withAuth(() => this.director!.rawGet('/api/v1/agents/advanced_lighting')).catch(() => []);
      const active = new Map<number, boolean>();
      for (const s of (Array.isArray(scenes) ? scenes : []) as Array<{ scene_id?: number; is_active?: boolean }>) {
        active.set(Number(s.scene_id), !!s.is_active);
      }
      for (const h of this.sceneHandlers) {
        const a = active.get(h.sceneId);
        if (a !== undefined) {
          h.update(a);
        }
      }
    }
  }
}

import {
  API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { Control4Account } from './control4/account';
import { Control4Director, C4Item, C4Variable, UnauthorizedError } from './control4/director';
import { C4Accessory, LightAccessory, LockAccessory } from './accessories';
import { RoomTelevision, RoomSource } from './television';
import { resolveCamera } from './cameraResolver';
import { C4CameraDelegate, attachCameraController } from './camera';

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
  /** Minutes between automatic re-discoveries, so adds/removes/renames sync live (default 10). */
  rediscoverMinutes?: number;
  /** Diagnostic: on startup, toggle this device once and log the command model that works. */
  controlTest?: string;
  /** Diagnostic: dump this item's detail/variables/properties/bindings to the log. */
  probe?: string;
  /** Diagnostic: log each room's Control4 video/audio sources (for TV mapping). */
  surveyRooms?: boolean;
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
    await this.discoverTelevisions(items);
    await this.poll();

    if (this.firstSync && this.config.controlTest) {
      await this.runControlTest(String(this.config.controlTest), chosen).catch((e) => this.log.error('control test error:', e?.message || e));
    }
    if (this.firstSync && this.config.probe) {
      await this.probeItem(String(this.config.probe), items).catch((e) => this.log.error('probe error:', e?.message || e));
    }
    if (this.firstSync && this.config.surveyRooms) {
      for (const r of items.filter((it) => it.proxy === 'roomdevice')) {
        const rid = (r as { roomId?: number }).roomId ?? r.id;
        const grab = async (kind: string): Promise<string[]> => {
          const d = await this.withAuth(() => this.director!.rawGet(`/api/v1/locations/rooms/${rid}/${kind}`)).catch(() => ({}));
          const vis = (d as { visible?: Array<{ id: number; name: string }> }).visible || [];
          return vis.map((x) => `${x.id}:${x.name}`);
        };
        const video = await grab('video_devices');
        const audio = await grab('audio_devices');
        if (video.length || audio.length) {
          this.log.info(`[survey] ${r.roomName} (room ${rid}): video=[${video.join(' | ')}] audio=[${audio.join(' | ')}]`);
        }
      }
      // AV devices + a sample TV's command/connection model (room-source lists were empty).
      const avProxies = new Set(['tv', 'receiver', 'avswitch', 'amplifier', 'tuner', 'dvd', 'media_player']);
      const av = items.filter((it) => avProxies.has(String(it.proxy)));
      for (const d of av.slice(0, 30)) {
        this.log.info(`[survey] AV ${d.proxy} #${d.id} "${d.name}" room="${d.roomName}"`);
      }
      const firstTv = items.find((it) => it.proxy === 'tv');
      if (firstTv) {
        const cmds = await this.withAuth(() => this.director!.rawGet(`/api/v1/items/${firstTv.id}/commands`)).catch(() => []);
        this.log.info(`[survey] TV #${firstTv.id} "${firstTv.name}" commands: ${JSON.stringify(cmds).slice(0, 2600)}`);
        const binds = await this.withAuth(() => this.director!.rawGet(`/api/v1/items/${firstTv.id}/bindings`)).catch(() => []);
        this.log.info(`[survey] TV #${firstTv.id} bindings: ${JSON.stringify(binds).slice(0, 2000)}`);
      }
      this.log.info('[survey] done');
    }

    this.firstSync = false;
  }

  /** Expose each room that has a TV as a HomeKit Television (external accessory). The ROOM
   *  holds the state (power/input/volume), so this works for IR- and IP-controlled TVs alike. */
  private async discoverTelevisions(items: C4Item[]): Promise<void> {
    if (this.config.exposeTvs === false) {
      return;
    }
    const roomIdOf = (it: C4Item) => Number((it as { roomId?: number }).roomId ?? 0);
    const tvRoomIds = new Set(items.filter((it) => it.proxy === 'tv').map(roomIdOf).filter(Boolean));
    const rooms = items.filter((it) => it.proxy === 'roomdevice' && tvRoomIds.has(roomIdOf(it)));
    const desiredRoomIds = new Set(rooms.map((r) => roomIdOf(r) || r.id));

    // Source proxies that can be a room's "watch" input.
    const srcProxies = new Set(['media_player', 'dvd', 'tuner', 'avswitch', 'receiver', 'tv', 'cable']);

    const toPublish: PlatformAccessory[] = [];
    for (const room of rooms) {
      const rid = roomIdOf(room) || room.id;
      if (this.tvByRoom.has(rid)) {
        continue; // already published; input/room changes take effect on next restart
      }

      // Inputs = the room's Control4 sources: prefer its video_devices list, else the AV source
      // devices located in the room. HomeKit rejects a Television with no inputs, so always keep ≥1.
      let inputs: RoomSource[] = [];
      const vd = await this.withAuth(() => this.director!.rawGet(`/api/v1/locations/rooms/${rid}/video_devices`)).catch(() => ({}));
      const vis = (vd as { visible?: Array<{ id: number; name: string }> }).visible || [];
      if (vis.length) {
        inputs = vis.map((x) => ({ id: x.id, name: x.name }));
      } else {
        inputs = items
          .filter((it) => srcProxies.has(String(it.proxy)) && roomIdOf(it) === rid && it.id !== room.id)
          .map((it) => ({ id: it.id, name: it.name }));
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
      this.log.info(`Control4: room TV "${room.name}" with ${inputs.length} input(s).`);
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
      attachCameraController(this.api, accessory, delegate);
      this.cameraUuidsWithController.add(uuid);
      if (!existing) {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cached.push(accessory);
      }
      this.log.info(`Control4: camera "${cam.name}" (channel ${channel}) added.`);
    }
  }

  /** One-shot diagnostic: dump an item's Director data so we can see where things like
   *  camera stream URLs live. Searches all items (not just the exposed ones). */
  private async probeItem(name: string, items: C4Item[]): Promise<void> {
    const key = name.toLowerCase();
    const item = /^\d+$/.test(name)
      ? items.find((it) => it.id === Number(name))
      : items.find((it) => String(it.name).toLowerCase() === key
        || `${it.roomName} ${it.name}`.toLowerCase() === key);
    if (!item) {
      this.log.warn(`[probe] "${name}" not found`);
      return;
    }
    this.log.info(`[probe] ${item.proxy} #${item.id} "${item.name}" room="${item.roomName}"`);
    this.log.info(`[probe] item: ${JSON.stringify(item).slice(0, 1800)}`);
    const vars = await this.getVariables(item.id).catch(() => []);
    this.log.info(`[probe] variables: ${JSON.stringify(vars).slice(0, 2500)}`);
    for (const sub of ['properties', 'bindings', 'network', 'commands']) {
      const data = await this.withAuth(() => this.director!.rawGet(`/api/v1/items/${item.id}/${sub}`))
        .catch((e: unknown) => ({ error: (e as Error)?.message }));
      this.log.info(`[probe] ${sub}: ${JSON.stringify(data).slice(0, 1800)}`);
    }

    // For a room, find the source list + select command that drive HomeKit TV inputs.
    if (item.proxy === 'roomdevice') {
      const rid = (item as { roomId?: number }).roomId ?? item.id;
      const roomPaths = [
        `/api/v1/locations/rooms/${rid}`,
        `/api/v1/locations/rooms/${rid}/devices`,
        `/api/v1/locations/rooms/${rid}/sources`,
        `/api/v1/locations/rooms/${rid}/video_devices`,
        `/api/v1/locations/rooms/${rid}/audio_devices`,
        `/api/v1/locations/rooms/${rid}/deviceswithcapability`,
      ];
      for (const p of roomPaths) {
        const data = await this.withAuth(() => this.director!.rawGet(p)).catch((e: unknown) => ({ error: (e as Error)?.message }));
        this.log.info(`[probe] ${p}: ${JSON.stringify(data).slice(0, 1400)}`);
      }
      const cmds = await this.withAuth(() => this.director!.rawGet(`/api/v1/items/${item.id}/commands`)).catch(() => []);
      this.log.info(`[probe] FULL commands: ${JSON.stringify(cmds).slice(0, 4500)}`);
    }

    // Hunt for the Director-provided, device-agnostic camera stream/snapshot URL.
    const id = item.id;
    const candidates = [
      `/api/v1/items/${id}/snapshot`, `/api/v1/items/${id}/snapshot.jpg`,
      `/api/v1/items/${id}/mjpeg`, `/api/v1/items/${id}/stream`,
      `/api/v1/items/${id}/image`, `/api/v1/items/${id}/camera`,
      `/api/v1/items/${id}/live`, `/api/v1/items/${id}/video`,
      `/api/v1/cameras`, `/api/v1/cameras/${id}`,
      `/api/v1/items/${id}/snapshoturl`, `/api/v1/items/${id}/streamurl`,
    ];
    for (const p of candidates) {
      const r = await this.director!.probePath(p).catch((e: unknown) => ({ code: -1, type: '', len: 0, preview: (e as Error)?.message || '' }));
      if (r.code !== 404 && r.code !== 401) {
        this.log.info(`[probe] GET ${p} -> ${r.code} ${r.type} len=${r.len}${(r as any).location ? ' loc=' + (r as any).location : ''} ${r.preview.replace(/\s+/g, ' ')}`);
      }
    }

    // Token-only synchronous proxy commands: the reply may carry the stream/snapshot URL.
    if (item.proxy === 'camera' || item.proxy === 'camera_v2') {
      for (const cmd of ['GET_SETUP', 'GET_STREAM_URL', 'GET_SNAPSHOT_URL', 'GET_MJPEG_URL', 'GET_H264_URL', 'GET_URLS', 'GET_CAMERA_INFO', 'GET_PROPERTIES']) {
        const r = await this.withAuth(() => this.director!.sendCommandSync(id, cmd, {})).catch((e: unknown) => ({ error: (e as Error)?.message }));
        const s = typeof r === 'string' ? r : JSON.stringify(r);
        this.log.info(`[probe] SYNC ${cmd} -> ${(s || '').slice(0, 2600)}`);
      }
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
    for (const tv of this.televisions) {
      await tv.refresh().catch((e) => this.log.debug('tv refresh error:', e?.message || e));
    }
  }
}

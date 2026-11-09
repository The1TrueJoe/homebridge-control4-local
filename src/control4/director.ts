import * as https from 'https';

/**
 * Local client for a Control4 controller's Director REST API
 * (https://<controller-ip>/api/v1/...). All traffic stays on the LAN.
 *
 * The controller serves a self-signed certificate, so TLS verification is
 * disabled for this one host (an unavoidable part of talking to Director;
 * the connection is still encrypted).
 */

export interface C4Item {
  id: number;
  name: string;
  type?: number;
  /** The proxy/driver protocol, e.g. "light", "relaysingle", "thermostatV2". */
  proxy?: string;
  /** Room the item lives in, when Director reports it. */
  roomName?: string;
  parentId?: number;
  // Director returns many more fields; keep the raw object for mapping.
  [k: string]: unknown;
}

export interface C4Variable {
  name: string;
  value: unknown;
}

export class Control4Director {
  private readonly agent: https.Agent;

  constructor(
    private readonly ip: string,
    private token: string,
  ) {
    this.agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
  }

  /** Swap in a freshly minted director token (called after a cloud refresh). */
  setToken(token: string): void {
    this.token = token;
  }

  private request(method: string, path: string, body?: unknown): Promise<string> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const options: https.RequestOptions = {
      host: this.ip,
      port: 443,
      path,
      method,
      agent: this.agent,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Accept': 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 15000,
    };
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const code = res.statusCode || 0;
          if (code === 401 || code === 403) {
            reject(new UnauthorizedError(`Director ${method} ${path} -> HTTP ${code}`));
          } else if (code < 200 || code >= 300) {
            reject(new Error(`Director ${method} ${path} -> HTTP ${code}: ${text.slice(0, 200)}`));
          } else {
            resolve(text);
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error(`Director ${method} ${path} timed out`)));
      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }

  private async getJson(path: string): Promise<any> {
    const text = await this.request('GET', path);
    return text ? JSON.parse(text) : null;
  }

  /** Every item Director knows about. */
  async getAllItems(): Promise<C4Item[]> {
    const data = await this.getJson('/api/v1/items');
    return Array.isArray(data) ? data : [];
  }

  /** Diagnostic helper: GET any Director path and return parsed JSON. */
  async rawGet(path: string): Promise<unknown> {
    return this.getJson(path);
  }

  /** Diagnostic: GET a path and report status/content-type/preview without throwing,
   *  so we can tell an image/stream endpoint from a 404 (used to locate camera URLs). */
  probePath(path: string): Promise<{ code: number; type: string; len: number; preview: string; location?: string }> {
    const options: https.RequestOptions = {
      host: this.ip, port: 443, path, method: 'GET', agent: this.agent,
      headers: { 'Authorization': `Bearer ${this.token}` }, timeout: 8000,
    };
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        const chunks: Buffer[] = [];
        let len = 0;
        res.on('data', (c) => { len += c.length; if (chunks.length < 3) chunks.push(c); });
        res.on('end', () => resolve({
          code: res.statusCode || 0,
          type: String(res.headers['content-type'] || ''),
          len,
          location: res.headers.location ? String(res.headers.location) : undefined,
          preview: Buffer.concat(chunks).toString('utf8').slice(0, 220),
        }));
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end();
    });
  }

  async getItemVariables(id: number): Promise<C4Variable[]> {
    const data = await this.getJson(`/api/v1/items/${id}/variables`);
    const arr: any[] = Array.isArray(data) ? data : [];
    return arr.map((v) => ({ name: String(v.varName ?? v.name), value: v.value }));
  }

  async getVariable(id: number, varName: string): Promise<unknown> {
    const data = await this.getJson(`/api/v1/items/${id}/variables?varnames=${encodeURIComponent(varName)}`);
    const arr: any[] = Array.isArray(data) ? data : [];
    return arr.length ? arr[0].value : undefined;
  }

  /** Fire a command at an item, e.g. sendCommand(42, 'SET_LEVEL', { LEVEL: 100 }). */
  async sendCommand(id: number, command: string, params: Record<string, unknown> = {}, isAsync = true): Promise<void> {
    await this.request('POST', `/api/v1/items/${id}/commands`, {
      async: isAsync,
      command,
      tParams: params,
    });
  }

  /** Synchronous command (async:false) that returns the proxy's reply body — the
   *  bearer-token equivalent of c4soap SendToDevice, used to ask a proxy for data
   *  such as a camera's stream/snapshot URL. */
  async sendCommandSync(id: number, command: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const text = await this.request('POST', `/api/v1/items/${id}/commands`, {
      async: false,
      command,
      tParams: params,
    });
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}

/** Thrown when Director rejects the bearer token, so callers can refresh and retry. */
export class UnauthorizedError extends Error {}

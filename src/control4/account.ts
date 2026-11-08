import { CLOUD } from '../settings';

/**
 * Talks to the Control4 cloud only to turn an account username/password into a
 * short-lived (≈24 h) Director bearer token for one controller. The token is
 * then used entirely locally against the controller on the LAN; the cloud is
 * not contacted again until the token needs refreshing.
 *
 * This mirrors the flow the official Control4 apps and the pyControl4 library use.
 */

export interface ControllerInfo {
  /** e.g. "Living-EA1-000FFF1AFCA9"; the id the authorization endpoint wants. */
  commonName: string;
  name: string;
  href: string;
}

export interface DirectorToken {
  token: string;
  /** Seconds the token is valid for (typically 86400). */
  validSeconds: number;
  /** Epoch ms at which we should refresh (a little before real expiry). */
  refreshAt: number;
}

async function postJson(url: string, body: unknown, bearer?: string): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (bearer) {
    headers['Authorization'] = `Bearer ${bearer}`;
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`POST ${url} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : {};
}

async function getJson(url: string, bearer: string): Promise<any> {
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${bearer}` } });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GET ${url} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : {};
}

export class Control4Account {
  private accountToken?: string;

  constructor(private readonly username: string, private readonly password: string) {}

  /** Logs into the cloud and caches the account bearer token. */
  async login(): Promise<void> {
    const body = {
      clientInfo: {
        device: {
          deviceName: 'homebridge-control4',
          deviceUUID: '0000000000000000',
          make: 'homebridge-control4',
          model: 'homebridge-control4',
          os: 'Android',
          osVersion: '10',
        },
        userInfo: {
          applicationKey: CLOUD.APPLICATION_KEY,
          password: this.password,
          userName: this.username,
        },
      },
    };
    const data = await postJson(CLOUD.AUTHENTICATION, body);
    const token = data?.authToken?.token;
    if (!token) {
      throw new Error('Control4 cloud login returned no auth token (check username/password)');
    }
    this.accountToken = token;
  }

  /** Lists the controllers on the account. Logs in first if needed. */
  async getControllers(): Promise<ControllerInfo[]> {
    if (!this.accountToken) {
      await this.login();
    }
    const data = await getJson(CLOUD.ACCOUNTS, this.accountToken!);
    const raw = data?.account;
    const list: any[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return list.map((c) => ({
      commonName: c.controllerCommonName,
      name: c.name,
      href: c.href,
    })).filter((c) => !!c.commonName);
  }

  /** Requests a Director bearer token for one controller (by common name). */
  async getDirectorToken(commonName: string): Promise<DirectorToken> {
    if (!this.accountToken) {
      await this.login();
    }
    const body = { serviceInfo: { commonName, services: 'director' } };
    let data: any;
    try {
      data = await postJson(CLOUD.AUTHORIZATION, body, this.accountToken);
    } catch (e) {
      // The account token may have expired; log in once more and retry.
      await this.login();
      data = await postJson(CLOUD.AUTHORIZATION, body, this.accountToken);
    }
    const token = data?.authToken?.token;
    const validSeconds = Number(data?.authToken?.validSeconds) || 86400;
    if (!token) {
      throw new Error(`No director token returned for ${commonName}`);
    }
    // Refresh at 90% of the lifetime so a request never rides on an expiring token.
    return { token, validSeconds, refreshAt: Date.now() + validSeconds * 900 };
  }
}

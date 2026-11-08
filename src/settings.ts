/** The name under which this platform is registered with Homebridge (must match config.schema.json pluginAlias). */
export const PLATFORM_NAME = 'Control4';

/** Must match the package.json "name". */
export const PLUGIN_NAME = 'homebridge-control4';

/** Control4 cloud endpoints, from the pyControl4 reference implementation. */
export const CLOUD = {
  AUTHENTICATION: 'https://apis.control4.com/authentication/v1/rest',
  ACCOUNTS: 'https://apis.control4.com/account/v3/rest/accounts',
  AUTHORIZATION: 'https://apis.control4.com/authentication/v1/rest/authorization',
  /** Public application key the Control4 apps use; required in the auth payload. */
  APPLICATION_KEY: '78f6791373d61bea49fdb9fb8897f1f3af193f11',
};

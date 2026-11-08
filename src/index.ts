import { API } from 'homebridge';
import { PLATFORM_NAME } from './settings';
import { Control4Platform } from './platform';

export = (api: API) => {
  api.registerPlatform(PLATFORM_NAME, Control4Platform);
};

import { API } from 'homebridge';
import { PhynPlatform } from './platform.js';
import { PLATFORM_NAME } from './settings.js';

export default (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, PhynPlatform);
};

import { route } from '../core/route.js';
import { HttpError } from '../core/errors.js';
import { directoryConfig, testConnection } from '../directory/index.js';

// E31#2: the administrator checks the directory settings: does it answer, does the service account sign in, does the base exist.
export const routes = [
  route({
    method: 'POST', path: '/api/settings/directory/test', permission: 'settings.manage', summary: 'Test the connection to the directory with the current settings (signs nobody in)',
    handler: async ({ pool }) => {
      const cfg = await directoryConfig(pool);
      if (!cfg) throw new HttpError(409, 'no_directory', 'No directory is configured (directory.url is empty): local accounts only.');
      return { url: cfg.url, ...(await testConnection(cfg)) };
    },
  }),
];

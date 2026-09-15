import { ensureIncidentStorage } from '../incidents/storage.js';

import { automationModels } from './models.js';
import { encryptionConfig } from './security.js';

export const ensureAutomationStorage = async () => {
  encryptionConfig();
  await ensureIncidentStorage();
  await Promise.all(automationModels.map((model) => model.init()));
};

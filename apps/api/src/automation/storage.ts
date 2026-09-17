import { ensureIncidentStorage } from '../incidents/storage.js';
import { oncallModels } from '../oncall/models.js';

import { automationModels } from './models.js';
import { encryptionConfig } from './security.js';

export const ensureAutomationStorage = async () => {
  encryptionConfig();
  await ensureIncidentStorage();
  await Promise.all([...automationModels, ...oncallModels].map((model) => model.init()));
};

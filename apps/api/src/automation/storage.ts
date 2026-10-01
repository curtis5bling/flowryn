import { ensureIncidentStorage } from '../incidents/storage.js';
import { oncallModels } from '../oncall/models.js';
import { reliabilityModels } from '../reliability/models.js';
import { statusModels } from '../status/models.js';
import { subscriberLookupKey } from '../status/service.js';

import { automationModels } from './models.js';
import { encryptionConfig } from './security.js';

export const ensureAutomationStorage = async () => {
  encryptionConfig();
  subscriberLookupKey();
  await ensureIncidentStorage();
  await Promise.all([...automationModels, ...oncallModels, ...statusModels, ...reliabilityModels].map((model) => model.init()));
};

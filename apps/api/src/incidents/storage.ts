import mongoose from 'mongoose';

import { IncidentCounterModel, IncidentModel } from '../models/Incident.js';
import { IncidentEventModel } from '../models/IncidentEvent.js';
import { NotificationModel } from '../models/Notification.js';

export const ensureIncidentStorage = async () => {
  const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') {
    console.error(JSON.stringify({ service: 'incidents', event: 'transaction_topology_required' }));
    throw new Error('Incident management requires a MongoDB replica set or sharded cluster');
  }
  // The operation receipt and number indexes must exist before serving writes.
  await Promise.all([
    IncidentModel.init(),
    IncidentCounterModel.init(),
    IncidentEventModel.init(),
    NotificationModel.init(),
  ]);
};

import 'dotenv/config';

import { createServer } from 'node:http';

import mongoose from 'mongoose';

import { createApp } from './app.js';
import { createRealtimeGateway } from './realtime/gateway.js';

const port = Number(process.env.API_PORT ?? 4000);
const app = createApp();
const server = createServer(app);
const allowedOrigins = (process.env.SOCKET_ALLOWED_ORIGINS ?? 'http://localhost:5173').split(',').map((origin) => origin.trim()).filter(Boolean);
createRealtimeGateway(server, allowedOrigins);

await mongoose.connect(process.env.MONGODB_URI ?? 'mongodb://localhost:27017/flowryn');
server.listen(port, () => console.log(`Flowryn API listening on http://localhost:${port}`));

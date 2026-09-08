import 'dotenv/config';

import mongoose from 'mongoose';

import { createApp } from './app.js';

const port = Number(process.env.API_PORT ?? 4000);
const app = createApp();

await mongoose.connect(process.env.MONGODB_URI ?? 'mongodb://localhost:27017/flowryn');
app.listen(port, () => console.log(`Flowryn API listening on http://localhost:${port}`));
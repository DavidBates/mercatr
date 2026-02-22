import 'dotenv/config';
import fs from 'fs';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { auth } from './auth.js';
import exploreRouter from './routes/explore.js';
import bridgeRouter from './routes/bridge.js';
import themeRouter from './routes/theme.js';
import xspfRouter from './routes/xspf.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../../public');
const manifestPath = path.resolve(__dirname, '../../prompts/voices/manifest.json');
const voicesManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

const app = express();
const port = process.env.PORT ?? 3000;

app.use(auth);
app.use(express.json());

app.get('/api/voices', (_, res) => res.json(voicesManifest));

app.use(express.static(publicDir));

app.use('/api/explore', exploreRouter);
app.use('/api/bridge', bridgeRouter);
app.use('/api/theme', themeRouter);
app.use('/api/xspf', xspfRouter);

app.listen(port, () => {
  process.stderr.write(`Mercatr server running on http://localhost:${port}\n`);
});

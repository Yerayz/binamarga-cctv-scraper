import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { Catalog, fetchLimited } from './catalog.js';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { resourceUrl, rewritePlaylist } from './streams.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function createApp({ catalog, store, engine, password = '', publicUrl = '', secureCookie = false }) {
  const app = express(), sessions = new Map(), attempts = new Map();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff'); res.set('Referrer-Policy', 'same-origin');
    if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method)) {
      const origin = req.get('origin');
      const allowed = publicUrl ? new URL(publicUrl).origin : `${req.protocol}://${req.get('host')}`;
      if ((origin && origin !== allowed) || req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Request must come from this app' });
    }
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  app.get('/api/auth', (req, res) => res.json({ required: Boolean(password) }));
  const cookieOptions = { httpOnly: true, sameSite: 'strict', secure: secureCookie, maxAge: 12 * 60 * 60 * 1000, path: '/' };
  app.post('/api/login', (req, res) => {
    if (!password) return res.json({ ok: true });
    const key = req.socket.remoteAddress, time = Date.now();
    const attempt = attempts.get(key) || { count: 0, until: time + 60000 };
    if (attempt.until < time) { attempt.count = 0; attempt.until = time + 60000; }
    if (attempt.count >= 10) return res.status(429).json({ error: 'Too many attempts; wait one minute' });
    attempt.count++; attempts.set(key, attempt);
    const digest = value => createHash('sha256').update(value).digest();
    if (typeof req.body?.password !== 'string' || !timingSafeEqual(digest(req.body.password), digest(password))) return res.status(401).json({ error: 'Incorrect password' });
    for (const [token, expiry] of sessions) if (expiry < time) sessions.delete(token);
    if (sessions.size > 1000) sessions.delete(sessions.keys().next().value);
    const token = randomBytes(32).toString('hex'); sessions.set(token, time + cookieOptions.maxAge);
    attempts.delete(key); res.cookie('tolwatch_session', token, cookieOptions); res.json({ ok: true });
  });
  const tokenFrom = req => req.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith('tolwatch_session='))?.slice(17);
  app.post('/api/logout', (req, res) => { sessions.delete(tokenFrom(req)); res.clearCookie('tolwatch_session', { path: '/', secure: secureCookie, sameSite: 'strict' }); res.json({ ok: true }); });
  app.use('/api', (req, res, next) => {
    if (password && (sessions.get(tokenFrom(req)) || 0) < Date.now()) return res.status(401).json({ error: 'Sign in to access TolWatch' });
    res.set('Cache-Control', 'no-store'); next();
  });
  app.get('/api/health', async (req, res) => res.json({ ffmpeg: engine.ready && engine.probeReady, ffprobe: engine.probeReady, minDuration: 10, maxDuration: 86400, active: engine.active.size, maxActive: engine.maxActive, node: process.version, storage: await engine.storage() }));
  app.get('/api/roads', async (req, res) => res.json(await catalog.roads(req.query.refresh === '1')));
  app.get('/api/roads/:roadId/cameras', async (req, res) => res.json(await catalog.cameras(req.params.roadId, req.query.refresh === '1')));
  app.get('/api/roads/:roadId/cameras/:cameraId/stream', async (req, res) => {
    const { camera, sourceUrl } = await catalog.resolve(req.params.roadId, req.params.cameraId);
    if (Object.keys(req.query).some(key => key !== 'url') || (req.query.url !== undefined && typeof req.query.url !== 'string')) return res.status(400).json({ error: 'Invalid stream resource' });
    let target;
    try { target = resourceUrl(camera.url, req.query.url || camera.url); } catch (error) { return res.status(400).json({ error: error.message }); }
    const { data, type } = await fetchLimited(target, { limit: new URL(target).pathname.endsWith('.m3u8') ? 1024 * 1024 : 32 * 1024 * 1024, referer: sourceUrl });
    if (new URL(target).pathname.endsWith('.m3u8') || /mpegurl/i.test(type)) {
      const text = data.toString('utf8').replace(/^\uFEFF/, '');
      if (!text.startsWith('#EXTM3U')) throw new Error('Source returned an invalid playlist');
      res.type('application/vnd.apple.mpegurl').send(rewritePlaylist(text, target, camera.url, req.path));
    } else res.type(type || 'video/mp2t').send(data);
  });
  app.get('/api/recordings', (req, res) => {
    let recordings = store.list('records').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (req.query.search) recordings = recordings.filter(j => `${j.cameraName} ${j.roadName}`.toLowerCase().includes(String(req.query.search).toLowerCase()));
    for (const key of ['mode', 'status']) if (req.query[key]) recordings = recordings.filter(j => j[key] === req.query[key]);
    if (req.query.date) recordings = recordings.filter(j => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(j.createdAt)) === req.query.date);
    const total = recordings.length, page = Math.max(1, Number.parseInt(req.query.page || '1', 10) || 1), limit = 50;
    res.json({ recordings: recordings.slice((page - 1) * limit, page * limit), total, page, pages: Math.max(1, Math.ceil(total / limit)), active: engine.active.size });
  });
  app.post('/api/recordings', async (req, res) => res.status(202).json(await engine.start(req.body.roadId, req.body.cameraId, req.body.duration)));
  app.get('/api/recordings/:id/download', (req, res, next) => {
    const job = store.get('records', req.params.id);
    if (!job || job.status !== 'completed' || path.basename(job.filename) !== job.filename) return res.status(404).json({ error: 'Recording not found' });
    res.download(path.join(engine.directory, job.filename), job.filename, error => { if (error) next(error); });
  });
  app.delete('/api/recordings/:id', async (req, res) => { await engine.deleteRecording(req.params.id); res.json({ ok: true }); });
  app.get('/api/tasks', (req, res) => res.json({ tasks: store.list('tasks'), events: store.events() }));
  app.post('/api/tasks', async (req, res) => res.status(201).json(await engine.saveTask(req.body)));
  app.put('/api/tasks/:id', async (req, res) => res.json(await engine.saveTask(req.body, req.params.id)));
  app.patch('/api/tasks/:id', async (req, res) => res.json(await engine.enableTask(req.params.id, req.body.enabled)));
  app.post('/api/tasks/:id/run', async (req, res) => {
    const task = store.get('tasks', req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.status(202).json(await engine.runTask(task));
  });
  app.delete('/api/tasks/:id', async (req, res) => { await engine.enableTask(req.params.id, false); store.delete('tasks', req.params.id); res.json({ ok: true }); });
  app.get('/hls.min.js', (req, res) => res.sendFile(path.join(root, 'node_modules/hls.js/dist/hls.min.js')));
  app.use(express.static(path.join(root, 'static'), { dotfiles: 'deny', index: 'index.html' }));
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    console.error(error.message);
    res.status(error.status || (error.code === 'ENOENT' ? 404 : 502)).json({ error: error.message || 'Request failed' });
  });
  return app;
}

async function main() {
  const host = process.env.HOST || '127.0.0.1', password = process.env.ADMIN_PASSWORD || '';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !password) throw new Error('Set ADMIN_PASSWORD before exposing the hosted app');
  const directory = path.resolve(process.env.RECORDINGS_DIR || path.join(root, 'recordings'));
  const store = new Store(path.resolve(process.env.DATA_DIR || path.join(root, 'data')), directory);
  const catalog = new Catalog();
  const maxActive = Number(process.env.MAX_ACTIVE_RECORDINGS || 2), reserve = Number(process.env.MIN_FREE_MB || 512);
  if (!Number.isInteger(maxActive) || maxActive < 1 || !Number.isFinite(reserve) || reserve < 0) throw new Error('Invalid recording capacity or disk reserve');
  const engine = new Engine({ store, catalog, directory, ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg', ffprobe: process.env.FFPROBE_PATH || 'ffprobe', maxActive, minFreeBytes: reserve * 1024 * 1024 });
  await engine.init();
  const app = createApp({ catalog, store, engine, password, publicUrl: process.env.PUBLIC_URL || '', secureCookie: process.env.COOKIE_SECURE === 'true' });
  const port = Number(process.env.PORT || process.env.SERVER_PORT || 8765);
  const server = app.listen(port, host, () => console.log(`TolWatch ready on ${host}:${port}; clips: ${directory}`));
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return; stopping = true;
    console.log('Stopping captures and finalizing files...');
    server.close(); await engine.shutdown(); store.close(); process.exit(0);
  };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exit(1); });

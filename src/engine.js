import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, stat, statfs, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { CronExpressionParser } from 'cron-parser';
import { highestVariant } from './streams.js';
import { USER_AGENT } from './catalog.js';

const exec = promisify(execFile), now = () => new Date().toISOString();
const id = () => randomUUID().replaceAll('-', '');
const slug = value => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48).replace(/^-|-$/g, '') || 'camera';
export function nextRun(cron, timezone, from = new Date()) {
  return CronExpressionParser.parse(cron, { tz: timezone, currentDate: from }).next().toISOString();
}
export class Engine {
  constructor({ store, catalog, directory, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', maxActive = 2, minFreeBytes = 512 * 1024 * 1024 }) {
    Object.assign(this, { store, catalog, directory, ffmpeg, ffprobe, maxActive, minFreeBytes });
    this.active = new Map(); this.stopping = false; this.ticking = false; this.ready = false; this.probeReady = false;
  }
  async init() {
    await mkdir(this.directory, { recursive: true });
    this.ready = await exec(this.ffmpeg, ['-version']).then(() => true, () => false);
    this.probeReady = await exec(this.ffprobe, ['-version']).then(() => true, () => false);
    for (const job of this.store.list('records').filter(j => ['queued', 'recording'].includes(j.status))) {
      const partial = path.join(this.directory, job.filename + '.part.mp4');
      try {
        if ((await stat(path.join(this.directory, job.filename))).size) await this.finish(job);
        else throw new Error('Empty output');
      } catch {
        // A gracefully finalized partial can still be salvaged after a metadata interruption.
        try { await this.probe(partial); await rename(partial, path.join(this.directory, job.filename)); await this.finish(job); }
        catch { this.update(job.id, { status: 'failed', finishedAt: now(), error: 'Interrupted by server restart' }); }
      }
    }
    // Each continuous session persists its camera identity beside its segment manifest.
    for (const file of (await readdir(this.directory)).filter(f => /^session-[a-f0-9]{32}\.json$/.test(f))) {
      try {
        const session = JSON.parse(await readFile(path.join(this.directory, file), 'utf8'));
        await this.ingest(session);
        await this.cleanupSession(session);
      } catch (error) { console.error('Session recovery:', error.message); }
    }
    for (const task of this.store.list('tasks')) {
      task.status = task.enabled ? 'waiting' : 'paused';
      task.retryAt = null;
      if (task.mode === 'scheduled' && task.enabled && task.nextRun && Date.parse(task.nextRun) < Date.now()) {
        this.store.event(task.id, 'Missed runs during downtime skipped; only live footage is available', 'skipped');
        task.nextRun = nextRun(task.cron, task.timezone);
      }
      this.store.save('tasks', task);
    }
    this.timer = setInterval(() => this.tick().catch(e => console.error(e)), 1000);
    this.timer.unref();
  }
  update(jobId, changes) { return this.store.save('records', { ...this.store.get('records', jobId), ...changes }); }
  async storage() {
    const fs = await statfs(this.directory);
    return { freeBytes: Number(fs.bavail) * Number(fs.bsize), totalBytes: Number(fs.blocks) * Number(fs.bsize), recordingBytes: this.store.list('records').reduce((sum, j) => sum + (j.bytes || 0), 0), minFreeBytes: this.minFreeBytes };
  }
  async probe(file) {
    const { stdout } = await exec(this.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name:format=duration', '-of', 'json', file], { timeout: 20000, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout), video = result.streams?.[0];
    if (!video?.width || !video?.height) throw new Error('Output has no readable video');
    return { width: video.width, height: video.height, codec: video.codec_name, actualDuration: Number(result.format?.duration || 0) };
  }
  async finish(job) {
    const file = path.join(this.directory, job.filename), metadata = await this.probe(file);
    this.store.save('records', { ...job, ...metadata, bytes: (await stat(file)).size, status: 'completed', finishedAt: now(), error: null });
  }
  async preflight() {
    if (this.stopping) throw new Error('Server is stopping');
    if (!this.ready || !this.probeReady) throw new Error('FFmpeg and FFprobe must both be installed');
    if (this.active.size >= this.maxActive) throw new Error(`Recording capacity reached (${this.maxActive})`);
    if ((await this.storage()).freeBytes < this.minFreeBytes) throw new Error('Insufficient free disk space; delete clips or increase storage');
  }
  validateDuration(duration) {
    if (!Number.isInteger(duration) || duration < 10 || duration > 86400) throw Object.assign(new Error('Duration must be 10–86400 seconds'), { status: 400 });
  }
  async start(roadId, cameraId, duration, task = null) {
    this.validateDuration(duration);
    await this.preflight();
    if (this.active.size >= this.maxActive) throw new Error(`Recording capacity reached (${this.maxActive})`);
    const key = `${roadId}/${cameraId}`;
    if ([...this.active.values()].some(run => run.key === key)) throw new Error('This camera is already recording');
    // Reserve before discovery/network I/O, preventing overlapping requests and oversubscription.
    const runId = id(), run = { key, taskId: task?.id, process: null, stopped: false };
    this.active.set(runId, run);
    try {
      const { road, camera, sourceUrl } = await this.catalog.resolve(roadId, cameraId, task?.cameraName, Boolean(task));
      run.key = `${roadId}/${camera.id}`;
      if ([...this.active.entries()].some(([otherId, other]) => otherId !== runId && other.key === run.key)) throw new Error('This camera is already recording');
      const stream = await highestVariant(camera.url, sourceUrl);
      if (this.stopping || run.stopped) throw new Error('Recording cancelled');
      const stem = `${slug(road.name)}_${slug(camera.name)}_${new Date().toISOString().replace(/[:.]/g, '-')}_${runId.slice(0, 8)}`;
      const job = { id: runId, roadId, roadName: road.name, cameraId: camera.id, cameraName: camera.name, duration, filename: `${stem}.mp4`, status: 'recording', createdAt: now(), startedAt: now(), finishedAt: null, bytes: 0, error: null, mode: task?.mode || 'manual', taskId: task?.id || null };
      const input = ['-hide_banner', '-loglevel', 'error', '-user_agent', USER_AGENT, '-referer', sourceUrl, '-rw_timeout', '15000000', '-i', stream, '-map', '0:v:0', '-an', '-c:v', 'copy'];
      let args, session;
      if (task?.mode === 'continuous') {
        session = { ...job, sessionId: runId, prefix: `session-${runId}`, seen: [] };
        const { writeFile } = await import('node:fs/promises');
        await writeFile(path.join(this.directory, `${session.prefix}.json`), JSON.stringify(session));
        args = [...input, '-f', 'segment', '-segment_time', String(duration), '-reset_timestamps', '1', '-segment_format', 'mp4', '-segment_format_options', 'movflags=+faststart', '-segment_list', path.join(this.directory, `${session.prefix}.csv`), '-segment_list_type', 'csv', '-y', path.join(this.directory, `${session.prefix}-%06d.part.mp4`)];
      } else {
        this.store.save('records', job);
        args = [...input, '-t', String(duration), '-movflags', '+faststart', '-y', path.join(this.directory, job.filename + '.part.mp4')];
      }
      const child = spawn(this.ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
      run.process = child; let stderr = '', timer, ingestBusy = false;
      child.stdin.on('error', () => {});
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
      const completion = new Promise(resolve => {
        let settled = false;
        const done = async (code, error) => {
          if (settled) return; settled = true; clearInterval(timer); clearTimeout(run.timeout); clearTimeout(run.killTimer);
          while (ingestBusy) await new Promise(r => setTimeout(r, 50));
          try {
            if (session) { await this.ingest(session); await this.cleanupSession(session); }
            else {
              if (code !== 0 && !run.stopped) throw new Error(error?.message || stderr.trim().split('\n').at(-1) || 'Camera returned no video');
              await rename(path.join(this.directory, job.filename + '.part.mp4'), path.join(this.directory, job.filename));
              await this.finish(job);
            }
          } catch (e) {
            if (!session) this.update(runId, { status: 'failed', finishedAt: now(), error: e.message.slice(-400) });
            else this.store.event(task.id, `Segment finalization: ${e.message}`, 'failed');
          } finally {
            this.active.delete(runId);
            if (task) {
              const current = this.store.get('tasks', task.id);
              if (current) {
                const failed = session ? !run.stopped : this.store.get('records', runId)?.status === 'failed';
                current.status = current.enabled ? (failed ? 'retrying' : 'waiting') : 'paused';
                current.failures = failed ? (current.failures || 0) + 1 : 0;
                current.retryAt = session && current.enabled ? new Date(Date.now() + Math.min(300000, 5000 * 2 ** Math.min(current.failures, 6))).toISOString() : null;
                this.store.save('tasks', current);
                this.store.event(task.id, run.stopped ? 'Capture stopped' : failed ? (stderr.trim().slice(-400) || 'Feed interrupted; retry scheduled') : 'Clip completed', failed ? 'failed' : 'completed');
              }
            }
            resolve();
          }
        };
        child.once('error', error => done(null, error)); child.once('close', code => done(code));
      });
      run.completion = completion;
      if (session) timer = setInterval(async () => {
        if (ingestBusy) return; ingestBusy = true;
        try { await this.ingest(session); if ((await this.storage()).freeBytes < this.minFreeBytes) { this.store.event(task.id, 'Disk reserve reached; capture paused until space is available', 'failed'); this.stopRun(run); } }
        catch (error) { console.error('Segment ingest:', error.message); } finally { ingestBusy = false; }
      }, 2000);
      else run.timeout = setTimeout(() => { stderr += '\nCapture timed out'; child.kill('SIGKILL'); }, (duration + 90) * 1000);
      if (task) { const current = this.store.get('tasks', task.id); if (current) this.store.save('tasks', { ...current, status: 'recording', lastRun: now() }); this.store.event(task.id, 'Capture started', 'recording'); }
      return job;
    } catch (error) { this.active.delete(runId); throw error; }
  }
  async ingest(session) {
    let csv; try { csv = await readFile(path.join(this.directory, `${session.prefix}.csv`), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const line of csv.trim().split('\n').filter(Boolean)) {
      const [raw, start, end] = line.split(','), filename = path.basename(raw.replace(/^"|"$/g, ''));
      if (!new RegExp(`^${session.prefix}-\\d{6}\\.part\\.mp4$`).test(filename)) continue;
      const segmentId = `${session.sessionId}${filename.match(/-(\d{6})\.part/)[1]}`;
      if (this.store.get('records', segmentId)?.status === 'completed') continue;
      const finalName = `${slug(session.roadName)}_${slug(session.cameraName)}_${segmentId}.mp4`;
      const job = { ...session, id: segmentId, filename: finalName, duration: Number(end) - Number(start), createdAt: new Date(Date.parse(session.startedAt) + Number(start) * 1000).toISOString() };
      delete job.seen; delete job.prefix; delete job.sessionId;
      try {
        try { await rename(path.join(this.directory, filename), path.join(this.directory, finalName)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        await this.finish(job);
      } catch (error) { throw new Error(`Could not finalize ${filename}: ${error.message}`); }
    }
  }
  async cleanupSession(session) {
    for (const extension of ['csv', 'json']) await unlink(path.join(this.directory, `${session.prefix}.${extension}`)).catch(() => {});
  }
  stopRun(run) {
    run.stopped = true;
    if (run.process && run.process.exitCode === null) {
      run.process.stdin.write('q\n');
      run.killTimer = setTimeout(() => run.process.kill('SIGKILL'), 15000);
    }
  }
  async saveTask(data, taskId) {
    if (!data || typeof data.roadId !== 'string' || typeof data.cameraId !== 'string') throw Object.assign(new Error('Select a valid road and camera'), { status: 400 });
    if (!['scheduled', 'continuous'].includes(data.mode)) throw Object.assign(new Error('Choose scheduled or continuous'), { status: 400 });
    this.validateDuration(data.duration);
    const timezone = data.timezone || 'Asia/Jakarta';
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw Object.assign(new Error('Invalid timezone'), { status: 400 }); }
    if (data.mode === 'scheduled' && (!/^\S+(\s+\S+){4}$/.test(data.cron || ''))) throw Object.assign(new Error('Use a five-field cron expression'), { status: 400 });
    let next = null;
    try { if (data.mode === 'scheduled') next = nextRun(data.cron, timezone); } catch (error) { throw Object.assign(new Error(`Invalid cron expression: ${error.message}`), { status: 400 }); }
    const existing = taskId ? this.store.get('tasks', taskId) : null;
    if (taskId && !existing) throw Object.assign(new Error('Task not found'), { status: 404 });
    if (taskId && [...this.active.values()].some(run => run.taskId === taskId)) throw Object.assign(new Error('Pause this task before editing'), { status: 409 });
    const { road, camera } = await this.catalog.resolve(data.roadId, data.cameraId);
    if (data.mode === 'continuous' && this.store.list('tasks').some(t => t.id !== taskId && t.mode === 'continuous' && t.roadId === road.id && t.cameraName === camera.name)) throw Object.assign(new Error('A continuous archive task already exists for this camera'), { status: 409 });
    const task = { id: taskId || id(), name: String(data.name || camera.name).slice(0, 100), roadId: road.id, roadName: road.name, cameraId: camera.id, cameraName: camera.name, mode: data.mode, duration: data.duration, cron: data.mode === 'scheduled' ? data.cron : null, timezone, enabled: data.enabled !== false, nextRun: next, createdAt: existing?.createdAt || now(), status: data.enabled === false ? 'paused' : 'waiting', failures: 0 };
    return this.store.save('tasks', task);
  }
  async enableTask(taskId, enabled) {
    if (typeof enabled !== 'boolean') throw Object.assign(new Error('enabled must be boolean'), { status: 400 });
    const task = this.store.get('tasks', taskId);
    if (!task) throw Object.assign(new Error('Task not found'), { status: 404 });
    task.enabled = enabled; task.status = enabled ? 'waiting' : 'paused'; task.retryAt = null;
    if (enabled && task.mode === 'scheduled') task.nextRun = nextRun(task.cron, task.timezone);
    this.store.save('tasks', task);
    if (!enabled) {
      const runs = [...this.active.values()].filter(run => run.taskId === taskId);
      runs.forEach(run => this.stopRun(run)); await Promise.all(runs.map(run => run.completion));
    }
    return this.store.get('tasks', taskId);
  }
  async runTask(task) {
    if ([...this.active.values()].some(run => run.taskId === task.id)) throw new Error('Task already running');
    return this.start(task.roadId, task.cameraId, task.duration, task);
  }
  async tick() {
    if (this.stopping || this.ticking) return;
    this.ticking = true;
    try {
      for (const task of this.store.list('tasks').filter(t => t.enabled)) {
        if ([...this.active.values()].some(run => run.taskId === task.id)) {
          if (task.mode === 'scheduled' && Date.parse(task.nextRun) <= Date.now()) { task.nextRun = nextRun(task.cron, task.timezone); this.store.save('tasks', task); this.store.event(task.id, 'Scheduled run skipped because previous capture is still active', 'skipped'); }
          continue;
        }
        if (task.mode === 'scheduled' ? Date.parse(task.nextRun) > Date.now() : task.retryAt && Date.parse(task.retryAt) > Date.now()) continue;
        if (task.mode === 'scheduled') { task.nextRun = nextRun(task.cron, task.timezone); this.store.save('tasks', task); }
        try { await this.runTask(task); }
        catch (error) {
          const current = this.store.get('tasks', task.id);
          if (!current) continue;
          current.status = 'retrying'; current.retryAt = new Date(Date.now() + 30000).toISOString();
          this.store.save('tasks', current); this.store.event(task.id, error.message, 'skipped');
        }
      }
    } finally { this.ticking = false; }
  }
  async deleteRecording(jobId) {
    const job = this.store.get('records', jobId);
    if (!job) throw Object.assign(new Error('Recording not found'), { status: 404 });
    if (['recording', 'queued'].includes(job.status)) throw Object.assign(new Error('Recording is active'), { status: 409 });
    await unlink(path.join(this.directory, job.filename)).catch(e => { if (e.code !== 'ENOENT') throw e; });
    await unlink(path.join(this.directory, `${jobId}.json`)).catch(() => {});
    await unlink(path.join(this.directory, job.filename + '.part.mp4')).catch(() => {});
    this.store.delete('records', jobId);
  }
  async shutdown() {
    this.stopping = true; clearInterval(this.timer);
    const runs = [...this.active.values()]; runs.forEach(run => this.stopRun(run));
    await Promise.all(runs.map(run => run.completion));
    while (this.ticking || this.active.size) await new Promise(r => setTimeout(r, 100));
  }
}

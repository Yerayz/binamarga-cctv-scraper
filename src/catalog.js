import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import ipaddr from 'ipaddr.js';

export const SOURCE = 'https://binamarga.pu.go.id/contents/cctv_tol';
export const USER_AGENT = 'Mozilla/5.0 (compatible; TolWatch/2.0; CCTV viewer)';
export function publicUrl(value) {
  try {
    const u = new URL(value), host = u.hostname.replace(/^\[|\]$/g, '');
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash) return false;
    if (ipaddr.isValid(host)) return ipaddr.process(host).range() === 'unicast';
    return host.includes('.') && !/(^|\.)(localhost|local|internal|test)$/.test(host);
  } catch { return false; }
}
export async function fetchLimited(url, { limit = 5 * 1024 * 1024, referer = SOURCE } = {}) {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Referer: referer }, redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
  const parts = []; let size = 0;
  for await (const part of response.body) {
    size += part.length;
    if (size > limit) throw new Error('Source response exceeds size limit');
    parts.push(part);
  }
  return { data: Buffer.concat(parts), type: response.headers.get('content-type') || '' };
}
const clean = value => value.replace(/\s+/g, ' ').trim();
export function parseRoads(html, source = SOURCE) {
  const $ = cheerio.load(html), roads = [], seen = new Set();
  $('.bpjn-box').each((_, element) => {
    const card = $(element); let id;
    card.find('a[href]').each((_, link) => {
      try {
        const url = new URL($(link).attr('href'), source);
        const slug = url.searchParams.get('id_ruas');
        if (url.origin === new URL(source).origin && /\/contents\/cctv_tol\/?$/.test(url.pathname) && /^[a-z0-9][a-z0-9-]*$/.test(slug || '')) id = slug;
      } catch { /* Ignore malformed publisher links. */ }
    });
    const name = clean(card.find('h1').first().text());
    if (id && name && !seen.has(id)) {
      roads.push({ id, name, listed: Number(card.find('.text-orange').text().match(/\d+/)?.[0] || 0) }); seen.add(id);
    }
  });
  return roads;
}
export function parseCameras(html, roadId) {
  const $ = cheerio.load(html), cameras = [], seen = new Set(), ids = new Set();
  $('.card-cctv').each((_, element) => {
    const card = $(element), name = clean(card.find('h5').first().text());
    const url = card.find('video, source').toArray().map(el => ($(el).attr('src') || '').trim()).find(publicUrl);
    const key = `${name.toLowerCase()}|${url}`;
    if (!name || !url || seen.has(key)) return;
    let id = card.find('video').first().attr('id') || '';
    if (!/^my_video_\d+$/.test(id) || ids.has(id)) id = createHash('sha256').update(roadId + name + url).digest('hex').slice(0, 16);
    cameras.push({ id, name, url }); seen.add(key); ids.add(id);
  });
  return cameras;
}
export class Catalog {
  constructor({ fetchPage = async url => (await fetchLimited(url)).data.toString('utf8'), cacheMs = 300000 } = {}) {
    this.fetchPage = fetchPage; this.cacheMs = cacheMs; this.cache = new Map(); this.pending = new Map();
  }
  async get(key, url, parser, refresh) {
    const cached = this.cache.get(key);
    if (!refresh && cached && Date.now() - cached.fetchedAt < this.cacheMs) return cached;
    if (this.pending.has(key)) return this.pending.get(key);
    const work = (async () => {
      const items = parser(await this.fetchPage(url));
      if (key === 'roads' && !items.length) throw new Error('No roads found on Bina Marga');
      const result = { [key === 'roads' ? 'roads' : 'cameras']: items, fetchedAt: Date.now() };
      this.cache.set(key, result); return result;
    })();
    this.pending.set(key, work);
    try { return await work; } finally { this.pending.delete(key); }
  }
  roads(refresh = false) { return this.get('roads', SOURCE, parseRoads, refresh); }
  async cameras(roadId, refresh = false) {
    const road = (await this.roads()).roads.find(r => r.id === roadId);
    if (!road) throw Object.assign(new Error('Road not found'), { status: 404 });
    const sourceUrl = `${SOURCE}?id_ruas=${roadId}`;
    return { ...await this.get(`cameras:${roadId}`, sourceUrl, html => parseCameras(html, roadId), refresh), road, sourceUrl };
  }
  async resolve(roadId, cameraId, expectedName, refresh = false) {
    const page = await this.cameras(roadId, refresh);
    let camera = page.cameras.find(c => c.id === cameraId);
    if (expectedName && camera?.name !== expectedName) camera = page.cameras.find(c => c.name === expectedName);
    if (!camera) throw Object.assign(new Error('Camera not found; refresh the listing'), { status: 404 });
    return { ...page, camera };
  }
}

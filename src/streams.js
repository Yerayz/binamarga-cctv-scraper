import { fetchLimited } from './catalog.js';

export function resourceUrl(base, candidate) {
  const original = new URL(base);
  const raw = decodeURIComponent(candidate.split('?')[0]);
  if (raw.includes('\\') || /(^|\/)\.{1,2}(\/|$)/.test(raw)) throw new Error('Resource is outside this camera stream');
  const target = new URL(candidate, base);
  const directory = decodeURIComponent(original.pathname).replace(/[^/]*$/, '');
  if (target.origin !== original.origin || target.username || target.password || target.hash || !decodeURIComponent(target.pathname).startsWith(directory)) throw new Error('Resource is outside this camera stream');
  return target.href;
}
export function rewritePlaylist(text, current, base, prefix) {
  const proxy = value => `${prefix}?url=${encodeURIComponent(resourceUrl(base, resourceUrl(current, value)))}`;
  return text.split(/\r?\n/).map(line => line.startsWith('#') ? line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${proxy(uri)}"`) : line.trim() ? proxy(line.trim()) : line).join('\n');
}
export async function highestVariant(base, referer) {
  let current = base;
  // Ordinary media playlists need no change. Master variants remain inside the published stream.
  for (let depth = 0; depth < 4; depth++) {
    if (!new URL(current).pathname.toLowerCase().endsWith('.m3u8')) return current;
    const { data } = await fetchLimited(current, { limit: 1024 * 1024, referer });
    const lines = data.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/), variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
      const resolution = lines[i].match(/RESOLUTION=(\d+)x(\d+)/), bandwidth = Number(lines[i].match(/(?:^|,)BANDWIDTH=(\d+)/)?.[1] || 0);
      let j = i + 1; while (j < lines.length && (!lines[j].trim() || lines[j].startsWith('#'))) j++;
      if (lines[j]) variants.push({ url: resourceUrl(base, resourceUrl(current, lines[j].trim())), pixels: resolution ? Number(resolution[1]) * Number(resolution[2]) : 0, bandwidth });
    }
    if (!variants.length) return current;
    variants.sort((a, b) => b.pixels - a.pixels || b.bandwidth - a.bandwidth); current = variants[0].url;
  }
  throw new Error('Too many nested master playlists');
}

import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ytDlp = process.env.YT_DLP || join(process.cwd(), 'bin', 'yt-dlp');
const ffmpeg = process.env.FFMPEG || join(process.cwd(), 'bin', 'ffmpeg');
const coverLimit = 2 * 1024 * 1024;
const bodyLimit = 3 * 1024 * 1024;
const downloadLimit = 20 * 60;
const downloadFilter = `!is_live & duration > 0 & duration <= ${downloadLimit}`;
const extractArgs = [
  '--ignore-config', '--no-plugin-dirs', '--no-playlist', '--no-cache-dir', '--no-progress',
  '--js-runtimes', `node:${process.execPath}`, '--socket-timeout', '12', '--retries', '1'
];
const mp3Args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'];
const noStore = { 'Cache-Control': 'no-store' };
const metadataCache = new Map();
let active = 0;

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function videoId(value) {
  let url;
  try { if (typeof value === 'string') url = new URL(value); } catch { }
  if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new RequestError(400, 'Paste a valid YouTube video link.');
  }
  let id;
  if (url.hostname === 'youtu.be') id = url.pathname.split('/')[1];
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(url.hostname)) {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else id = /^\/(?:shorts|live|embed)\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  }
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) throw new RequestError(400, 'Use a link to one YouTube video or song.');
  return id;
}

const videoUrl = id => `https://www.youtube.com/watch?v=${id}`;
const thumbnailUrl = id => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

function tag(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 180).toWellFormed() : '';
}

function toolOutput(error) {
  return `${error.stderr || ''} ${error.stdout || ''}`;
}

function youtubeFailure(error) {
  const detail = toolOutput(error);
  if (/not a bot|HTTP Error 429|too many requests|rate.limit/i.test(detail)) return 'blocked';
  if (/HTTP Error 403/i.test(detail)) return 'forbidden';
  if (/HTTP Error (500|502|503|504)|temporary failure|connection (?:reset|refused)/i.test(detail)) return 'temporary';
  return null;
}

function errorMessage(error) {
  const detail = toolOutput(error);
  if (error.code === 'ENOENT' || error.code === 'EACCES') return 'The converter tools are unavailable. Check the Vercel build logs.';
  if (error.killed) return 'The conversion timed out. Try a shorter video.';
  if (/not pass filter|larger than max-filesize/i.test(detail)) return 'Choose a public, finished video up to 20 minutes long.';
  if (/private video|video (?:is )?unavailable|not available|members.only|age.restricted|confirm your age/i.test(detail)) return 'This video is unavailable. Try a public video that plays without signing in.';
  return 'Could not process this video. Try another public YouTube link.';
}

async function lookupPublicDetails(id, signal) {
  const endpoint = new URL('https://www.youtube.com/oembed');
  endpoint.search = new URLSearchParams({ url: videoUrl(id), format: 'json' });
  const response = await fetch(endpoint, {
    redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(7000)])
  });
  if (!response.ok || !response.body) return null;
  const info = JSON.parse((await readLimited(response.body, 32_768)).toString('utf8'));
  const title = tag(info.title);
  if (!title) return null;
  return { title, artist: tag(info.author_name), album: '', duration: null, cover: thumbnailUrl(id), metadataOnly: true };
}

async function inspect(id, signal) {
  const cached = metadataCache.get(id);
  if (cached?.expires > Date.now()) return cached.track;
  let stdout;
  try {
    ({ stdout } = await exec(ytDlp, [...extractArgs, '--skip-download', '--print',
      '%(.{track,title,artist,uploader,channel,album,duration,is_live})j', '--', videoUrl(id)],
    { timeout: 40_000, signal, windowsHide: true }));
  } catch (error) {
    if (!youtubeFailure(error)) throw error;
    const details = await lookupPublicDetails(id, signal).catch(() => null);
    if (details) return details;
    throw error;
  }
  const info = JSON.parse(stdout);
  if (info.is_live || !(info.duration > 0 && info.duration <= downloadLimit)) {
    throw new RequestError(400, 'Choose a public, finished video up to 20 minutes long.');
  }
  const track = {
    title: tag(info.track || info.title), artist: tag(info.artist || info.uploader || info.channel),
    album: tag(info.album), duration: info.duration, cover: thumbnailUrl(id)
  };
  if (metadataCache.size >= 128) metadataCache.delete(metadataCache.keys().next().value);
  metadataCache.set(id, { track, expires: Date.now() + 5 * 60_000 });
  return track;
}

async function readLimited(stream, limit) {
  const reader = stream.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks);
      size += value.length;
      if (size > limit) throw new RequestError(413, 'The uploaded file is too large.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function prepareCover(dir, id, data, signal) {
  if (!data.includeCover) return false;
  let bytes;
  const custom = typeof data.cover === 'string' && data.cover.length > 0;
  if (custom) {
    bytes = Buffer.from(data.cover, 'base64');
  } else {
    try {
      const thumb = await fetch(thumbnailUrl(id), {
        redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)])
      });
      if (!thumb.ok || !thumb.body) return false;
      bytes = await readLimited(thumb.body, coverLimit);
    } catch {
      return false;
    }
  }
  const png = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  const jpeg = bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
  if (bytes.length > coverLimit || (!png && !jpeg)) {
    if (!custom) return false;
    throw new RequestError(400, 'Choose a JPG or PNG cover up to 2 MB.');
  }
  const input = png ? 'upload.png' : 'upload.jpg';
  await writeFile(join(dir, input), bytes);
  try {
    await exec(ffmpeg, [...mp3Args, '-max_pixels', '20000000', '-f', 'image2', '-pattern_type', 'none', '-i', input,
      '-frames:v', '1', '-vf', 'scale=1200:1200:force_original_aspect_ratio=decrease', '-update', '1', 'cover.jpg'],
    { cwd: dir, timeout: 10_000, signal, windowsHide: true });
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EACCES') throw error;
    if (custom) throw new RequestError(400, 'This image could not be used. Try a different JPG or PNG.');
    return false;
  }
}

function removeDir(dir) {
  return rm(dir, { recursive: true, force: true }).catch(error => console.error('Temporary file cleanup:', error.message));
}

async function downloadAudio(dir, id, signal) {
  const args = [...extractArgs, '--break-match-filters', downloadFilter, '--max-filesize', '60M',
    '-f', 'bestaudio[protocol=https]/bestaudio', '--fixup', 'never'];
  const deadline = Date.now() + 105_000;
  let prefix = 'source';
  try {
    await exec(ytDlp, [...args, '-o', `${prefix}.%(ext)s`, '--', videoUrl(id)],
      { cwd: dir, timeout: 105_000, signal, windowsHide: true });
  } catch (error) {
    const remaining = deadline - Date.now();
    if (youtubeFailure(error) !== 'forbidden' || remaining < 8_000 || signal.aborted) throw error;
    prefix = 'retry';
    await exec(ytDlp, [...args, '--force-ipv4', '-o', `${prefix}.%(ext)s`, '--', videoUrl(id)],
      { cwd: dir, timeout: remaining, signal, windowsHide: true });
  }
  return (await readdir(dir)).find(name => name.startsWith(`${prefix}.`) && /\.(?:m4a|mp4|webm|ogg|opus|aac|mp3)$/.test(name));
}

async function convert(id, data, signal) {
  const title = tag(data.title);
  if (!title) throw new RequestError(400, 'Enter a track title.');
  let dir = await mkdtemp(join(tmpdir(), 'musiko-vercel-'));
  try {
    const cover = await prepareCover(dir, id, data, signal);
    const source = await downloadAudio(dir, id, signal);
    if (!source) throw new RequestError(422, 'No downloadable audio was found within the 60 MB source limit.');
    const args = [...mp3Args, '-i', source];
    if (cover) args.push('-i', 'cover.jpg');
    args.push('-map', '0:a:0', '-t', String(downloadLimit), '-map_metadata', '-1', '-c:a', 'libmp3lame', '-q:a', '2', '-id3v2_version', '3');
    if (cover) args.push('-map', '1:v:0', '-c:v', 'copy', '-disposition:v:0', 'attached_pic',
      '-metadata:s:v:0', 'title=Album cover', '-metadata:s:v:0', 'comment=Cover (front)');
    args.push('-metadata', `title=${title}`, '-metadata', `artist=${tag(data.artist)}`, '-metadata', `album=${tag(data.album)}`, 'export.mp3');
    await exec(ffmpeg, args, { cwd: dir, timeout: 35_000, signal, windowsHide: true });

    const filename = title.replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '') || 'track';
    const encoded = encodeURIComponent(`${filename}.mp3`).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16)}`);
    const exportedDir = dir;
    const stream = createReadStream(join(dir, 'export.mp3'));
    stream.once('close', () => { void removeDir(exportedDir); });
    signal.addEventListener('abort', () => stream.destroy(), { once: true });
    dir = undefined;
    return new Response(Readable.toWeb(stream), { headers: {
      ...noStore, 'Content-Type': 'audio/mpeg',
      'Content-Disposition': `attachment; filename="track.mp3"; filename*=UTF-8''${encoded}`
    } });
  } finally {
    if (dir) await removeDir(dir);
  }
}

export default {
  async fetch(request) {
    try {
      if (request.method !== 'POST') throw new RequestError(405, 'Use the converter page to start a request.');
      if (request.headers.get('sec-fetch-site') === 'cross-site') throw new RequestError(403, 'Open the converter to use it.');
      if (request.headers.get('content-type')?.split(';')[0] !== 'application/json' || !request.body) {
        throw new RequestError(415, 'Expected a JSON request.');
      }
      if (Number(request.headers.get('content-length')) > bodyLimit) throw new RequestError(413, 'The uploaded file is too large.');
      const raw = await readLimited(request.body, bodyLimit);
      let data;
      try { data = JSON.parse(raw.toString('utf8')); } catch { throw new RequestError(400, 'The request could not be read.'); }
      if (!data || !['inspect', 'convert'].includes(data.action)) throw new RequestError(400, 'Choose a converter action.');
      const id = videoId(data.url);
      if (active >= 2) throw new RequestError(429, 'The converter is busy. Try again in a moment.');
      active++;
      try {
        if (data.action === 'inspect') return Response.json(await inspect(id, request.signal), { headers: noStore });
        return await convert(id, data, request.signal);
      } finally {
        active--;
      }
    } catch (error) {
      if (error instanceof RequestError) return Response.json({ error: error.message }, { status: error.status, headers: noStore });
      console.error('Conversion failed:', String(error.stderr || error.message).slice(0, 500));
      const failure = youtubeFailure(error);
      if (failure === 'blocked' || failure === 'forbidden') {
        return Response.json({ code: 'YOUTUBE_REJECTED', error: 'YouTube is blocking direct conversion from this server. You can still tag an MP3 under “Use an MP3 file.”' }, { status: 502, headers: noStore });
      }
      if (failure === 'temporary') {
        return Response.json({ code: 'YOUTUBE_TEMPORARY', error: 'YouTube did not respond. Try again or choose an MP3 file.' }, { status: 502, headers: noStore });
      }
      return Response.json({ error: errorMessage(error) }, { status: 502, headers: noStore });
    }
  }
};

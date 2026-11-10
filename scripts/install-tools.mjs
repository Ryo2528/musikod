import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const tools = resolve('bin');
const ffmpegName = 'ffmpeg-n8.1.3-34-ga35157abb9-linux64-lgpl-8.1';
const ffmpegUrl = `https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/autobuild-2026-11-09-12-42/${ffmpegName}.tar.xz`;
const ytDlpUrl = 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp_linux';
const scratch = await mkdtemp(join(tmpdir(), 'musiko-build-'));

async function download(url, path, checksum) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new Error(`Tool download failed (${response.status}): ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path));
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== checksum) throw new Error(`Tool checksum mismatch: ${url}`);
}

try {
  await mkdir(tools, { recursive: true });
  const archive = join(scratch, 'ffmpeg.tar.xz');
  const downloader = join(scratch, 'yt-dlp');
  const downloads = await Promise.allSettled([
    download(ytDlpUrl, downloader, '767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795'),
    download(ffmpegUrl, archive, '70c3029eaa46cb83746ed5a218bbffbdc4fc3719e4080010af3a9690ff4e65f6')
  ]);
  for (const result of downloads) if (result.status === 'rejected') throw result.reason;

  execFileSync('tar', ['-xf', archive, '-C', tools, '--strip-components=2', `${ffmpegName}/bin/ffmpeg`], { stdio: 'inherit' });
  await rename(downloader, join(tools, 'yt-dlp')).catch(async error => {
    if (error.code !== 'EXDEV') throw error;
    await pipeline(createReadStream(downloader), createWriteStream(join(tools, 'yt-dlp')));
  });
  const ffmpeg = join(tools, 'ffmpeg');
  const ytDlp = join(tools, 'yt-dlp');
  await Promise.all([chmod(ffmpeg, 0o755), chmod(ytDlp, 0o755)]);
  const size = (await stat(ffmpeg)).size + (await stat(ytDlp)).size;
  if (size > 220_000_000) throw new Error('Converter binaries are too large for the Vercel bundle.');
  if (process.platform === 'linux' && process.arch === 'x64') {
    execFileSync(ytDlp, ['--version'], { stdio: 'inherit' });
    const encoders = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    if (!encoders.includes('libmp3lame')) throw new Error('FFmpeg build does not have the MP3 encoder.');
  }
  console.log(`Prepared Vercel converter tools (${Math.round(size / 1_000_000)} MB).`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}

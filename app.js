import { readMp3, writeMp3 } from './mp3-tags.js';

const prepareForm = document.querySelector('#prepare-form');
const exportForm = document.querySelector('#export-form');
const urlField = document.querySelector('#video-url');
const prepareButton = document.querySelector('#prepare');
const downloadButton = document.querySelector('#download');
const prepareStatus = document.querySelector('#prepare-status');
const exportStatus = document.querySelector('#export-status');
const tags = document.querySelector('#tags');
const title = document.querySelector('#title');
const artist = document.querySelector('#artist');
const album = document.querySelector('#album');
const duration = document.querySelector('#duration');
const artwork = document.querySelector('#artwork');
const coverFile = document.querySelector('#cover-file');
const includeCover = document.querySelector('#include-cover');
const fileMode = document.querySelector('#file-mode');
const sourceFile = document.querySelector('#source-file');
const fileStatus = document.querySelector('#file-status');
let track;
let coverPreview;

function status(element, message, error = false) {
  element.classList.toggle('error', error);
  element.textContent = message;
}

function setBusy(active) {
  prepareButton.disabled = active;
  downloadButton.disabled = active;
  urlField.readOnly = active;
  sourceFile.disabled = active;
}

async function post(payload, statusElement) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch('/api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (response.ok) return response;
    const body = await response.json().catch(() => ({}));
    const rejected = response.status === 502 && body.error?.startsWith('YouTube rejected');
    if (rejected && attempt === 0) {
      status(statusElement, 'YouTube rejected the request. Retrying once…');
      await new Promise(resolve => setTimeout(resolve, 1500));
      continue;
    }
    if (rejected) throw new Error('YouTube is blocking direct conversion right now. You can still tag an MP3 under “Use an MP3 file.”');
    throw new Error(body.error || 'The converter could not complete the request.');
  }
}

function refreshArtwork() {
  if (coverPreview) URL.revokeObjectURL(coverPreview);
  const file = coverFile.files[0];
  coverPreview = file ? URL.createObjectURL(file) : null;
  const cover = includeCover.checked && (coverPreview || track?.cover);
  if (cover) artwork.src = cover;
  else artwork.removeAttribute('src');
  artwork.hidden = !cover;
}

function showTrack() {
  title.value = track?.title || '';
  artist.value = track?.artist || '';
  album.value = track?.album || '';
  const seconds = Math.floor(track?.duration || 0);
  duration.textContent = seconds ? `MP3 · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : 'MP3';
  coverFile.value = '';
  includeCover.checked = Boolean(track?.cover);
  refreshArtwork();
  tags.disabled = !track;
}

prepareForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (prepareButton.disabled) return;
  setBusy(true);
  track = null;
  sourceFile.value = '';
  status(fileStatus, '');
  showTrack();
  status(exportStatus, 'Track details will appear once the video is found.');
  status(prepareStatus, 'Looking up the video and its track details…');
  try {
    const url = urlField.value.trim();
    const response = await post({ action: 'inspect', url }, prepareStatus);
    track = { ...await response.json(), url };
    showTrack();
    status(prepareStatus, 'Track ready. Review the details before downloading.');
    status(exportStatus, 'Your edits will be saved inside the MP3.');
    title.focus();
  } catch (error) {
    fileMode.open = true;
    status(prepareStatus, error.message, true);
    status(exportStatus, 'Prepare a video or choose an MP3 file to edit its tags.');
  } finally {
    setBusy(false);
  }
});

sourceFile.addEventListener('change', async () => {
  const file = sourceFile.files[0];
  if (!file || sourceFile.disabled) return;
  setBusy(true);
  try {
    const audio = await readMp3(file);
    if (track) track = { ...track, audio };
    else {
      track = { audio, title: file.name.replace(/\.mp3$/i, '').slice(0, 180) };
      showTrack();
    }
    status(fileStatus, `Selected ${file.name}`);
    status(exportStatus, 'Edit the tags and download a new copy.');
    title.focus();
  } catch (error) {
    status(fileStatus, error.message, true);
  } finally {
    sourceFile.value = '';
    setBusy(false);
  }
});

coverFile.addEventListener('change', () => {
  const file = coverFile.files[0];
  if (file && (!['image/jpeg', 'image/png'].includes(file.type) || file.size > 2 * 1024 * 1024)) {
    coverFile.value = '';
    status(exportStatus, 'Choose a JPG or PNG image up to 2 MB.', true);
  } else if (file) {
    includeCover.checked = true;
    status(exportStatus, 'Custom cover selected.');
  }
  refreshArtwork();
});
includeCover.addEventListener('change', refreshArtwork);

function encodeCover(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(reader.result.split(',')[1]));
    reader.addEventListener('error', () => reject(new Error('Could not read the cover image.')));
    reader.readAsDataURL(file);
  });
}

function saveMp3(blob, filename) {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
}

async function browserCover(file) {
  if (file || !includeCover.checked || !track.cover) return file;
  try {
    const response = await fetch(track.cover, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error();
    return await response.blob();
  } catch {
    throw new Error('Could not load the video cover. Choose an image or uncheck “Embed cover in MP3.”');
  }
}

exportForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!track || downloadButton.disabled) return;
  setBusy(true);
  status(exportStatus, track.audio ? 'Writing your track details…' : 'Converting audio and writing your track details. This can take a minute…');
  try {
    const file = includeCover.checked && coverFile.files[0];
    const data = {
      title: title.value.trim(),
      artist: artist.value,
      album: album.value
    };
    if (!data.title) throw new Error('Enter a track title.');
    if (track.audio) {
      const base = data.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '') || 'track';
      saveMp3(await writeMp3(track.audio, data, await browserCover(file)), `${base}.mp3`);
    } else {
      const response = await post({
        ...data, action: 'convert', url: track.url, includeCover: includeCover.checked,
        cover: file ? await encodeCover(file) : null
      }, exportStatus);
      const filename = response.headers.get('Content-Disposition')?.split("filename*=UTF-8''")[1];
      saveMp3(await response.blob(), filename ? decodeURIComponent(filename) : 'track.mp3');
    }
    status(exportStatus, 'MP3 downloaded.');
  } catch (error) {
    if (!track.audio) fileMode.open = true;
    status(exportStatus, error.message, true);
  } finally {
    setBusy(false);
  }
});

const ascii = new TextEncoder();

function tagSize(bytes, offset) {
  const size = bytes.subarray(offset, offset + 4);
  if (size.some(byte => byte > 127)) throw new Error('This MP3 has an invalid tag header.');
  return size.reduce((total, byte) => (total << 7) | byte, 0);
}

export async function readMp3(file) {
  let start = 0;
  let end = file.size;
  // Skip existing ID3v2 tags, including the optional ID3v2.4 footer.
  for (let tags = 0; tags < 8; tags++) {
    const header = new Uint8Array(await file.slice(start, start + 10).arrayBuffer());
    if (header.length < 10) throw new Error('Choose a valid MP3 audio file.');
    if (header[0] !== 73 || header[1] !== 68 || header[2] !== 51) break;
    const footer = header[3] === 4 && (header[5] & 16) ? 10 : 0;
    start += 10 + tagSize(header, 6) + footer;
  }
  const frame = new Uint8Array(await file.slice(start, start + 4).arrayBuffer());
  const validFrame = frame.length === 4 && frame[0] === 0xff && (frame[1] & 0xe0) === 0xe0
    && (frame[1] & 0x18) !== 8 && (frame[1] & 6) === 2 && (frame[2] & 0xf0) !== 0xf0
    && (frame[2] & 12) !== 12;
  if (!validFrame) throw new Error('Choose a valid MP3 audio file.');

  if (end - start >= 128) {
    const tail = new Uint8Array(await file.slice(end - 128, end - 125).arrayBuffer());
    if (tail[0] === 84 && tail[1] === 65 && tail[2] === 71) end -= 128;
  }
  return file.slice(start, end, 'audio/mpeg');
}

function frameHeader(id, size) {
  const bytes = new Uint8Array(10);
  bytes.set(ascii.encode(id));
  new DataView(bytes.buffer).setUint32(4, size);
  return bytes;
}

function textBytes(value) {
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!text) return null;
  const bytes = new Uint8Array(3 + text.length * 2);
  bytes.set([1, 0xff, 0xfe]); // UTF-16 little endian with a byte-order mark.
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < text.length; index++) view.setUint16(3 + index * 2, text.charCodeAt(index), true);
  return bytes;
}

export async function writeMp3(audio, metadata, cover) {
  const frames = [];
  for (const [id, value] of [['TIT2', metadata.title], ['TPE1', metadata.artist], ['TALB', metadata.album]]) {
    const body = textBytes(value);
    if (body) frames.push(frameHeader(id, body.length), body);
  }
  if (cover) {
    const signature = new Uint8Array(await cover.slice(0, 8).arrayBuffer());
    const jpg = signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff;
    const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => signature[i] === byte);
    if (cover.size > 2 * 1024 * 1024 || (!jpg && !png)) throw new Error('Choose a JPG or PNG cover up to 2 MB.');
    const mime = ascii.encode(jpg ? 'image/jpeg' : 'image/png');
    const prefix = new Uint8Array(mime.length + 4);
    prefix.set(mime, 1);
    prefix[mime.length + 2] = 3; // Front cover.
    frames.push(frameHeader('APIC', prefix.length + cover.size), prefix, cover);
  }
  const size = frames.reduce((total, part) => total + (part.size ?? part.byteLength), 0);
  const header = new Uint8Array([73, 68, 51, 3, 0, 0, (size >>> 21) & 127, (size >>> 14) & 127, (size >>> 7) & 127, size & 127]);
  return new Blob([header, ...frames, audio], { type: 'audio/mpeg' });
}

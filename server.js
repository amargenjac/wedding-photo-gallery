const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const archiver = require('archiver');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let sharp = null;
try {
  sharp = require('sharp');
} catch (err) {
  console.warn('Thumbnails are off:', err.message);
}

const PORT = Number(process.env.PORT) || 8787;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const STORAGE = path.join(ROOT, 'storage');
const PHOTOS = path.join(STORAGE, 'photos');
const THUMBS = path.join(STORAGE, 'thumbs');
const META = path.join(STORAGE, 'photos.json');
const SETTINGS = path.join(STORAGE, 'settings.json');
const QR_PATH = path.join(STORAGE, 'qr-code.png');
const QR_META = path.join(STORAGE, 'qr.json');

const DEFAULT_SETTINGS = {
  title: 'Edis & Nina',
  subtitle: 'Dodajte svoje fotografije sa vjenčanja.',
  publicUrl: ''
};

const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif'
};

const BIN = path.join(ROOT, 'bin');
const MAX_ALBUM_BYTES = 8 * 1024 * 1024 * 1024;

for (const dir of [STORAGE, PHOTOS, THUMBS, BIN]) {
  fs.mkdirSync(dir, { recursive: true });
}

let tunnelUrl = '';
let tunnelState = 'connecting';
let tunnelProcess = null;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function readSettings() {
  const saved = readJson(SETTINGS, {});
  const fromFile = typeof saved.publicUrl === 'string' ? saved.publicUrl.trim() : '';
  const fromEnv = typeof process.env.PUBLIC_URL === 'string' ? process.env.PUBLIC_URL.trim() : '';
  return {
    title: typeof saved.title === 'string' && saved.title.trim() ? saved.title.trim() : DEFAULT_SETTINGS.title,
    subtitle: typeof saved.subtitle === 'string' ? saved.subtitle.trim() : DEFAULT_SETTINGS.subtitle,
    publicUrl: fromEnv || fromFile
  };
}

function readPhotos() {
  const items = readJson(META, []);
  return Array.isArray(items) ? items : [];
}

let metaChain = Promise.resolve();
function withPhotos(mutator) {
  const run = metaChain.then(() => {
    const items = readPhotos();
    const next = mutator(items) || items;
    writeJson(META, next);
    return next;
  });
  metaChain = run.then(() => undefined, (err) => {
    console.error(err);
  });
  return run;
}

function isVirtualAdapter(name) {
  return /virtual|vmware|vbox|hyper-v|vethernet|wsl|docker|loopback|bluetooth|tailscale|zerotier|npcap/i.test(name);
}

function lanAddresses() {
  const found = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    if (isVirtualAdapter(name)) continue;
    for (const net of entries || []) {
      const v4 = net.family === 'IPv4' || net.family === 4;
      if (!v4 || net.internal || net.address.startsWith('169.254.')) continue;
      found.push(net.address);
    }
  }
  const rank = (ip) => {
    if (ip.startsWith('192.168.')) return 0;
    if (ip.startsWith('10.')) return 1;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return 2;
    return 3;
  };
  return [...new Set(found)].sort((a, b) => rank(a) - rank(b));
}

function preferredLan() {
  return lanAddresses()[0] || '127.0.0.1';
}

function albumUrl() {
  const { publicUrl } = readSettings();
  if (publicUrl) return `${publicUrl.replace(/\/$/, '')}/`;
  if (tunnelUrl) return `${tunnelUrl.replace(/\/$/, '')}/`;
  return `http://${preferredLan()}:${PORT}/`;
}

function accessMode() {
  if (readSettings().publicUrl || tunnelUrl) return 'public';
  return 'wifi';
}

function cleanName(value) {
  return String(value || '').replace(/[\u0000-\u001F]/g, '').trim().slice(0, 80);
}

function cleanOriginalName(value) {
  const base = path.basename(String(value || 'photo'));
  const cleaned = base.replace(/[^\w.\- ()[\]]+/g, '_').slice(0, 120);
  return cleaned || 'photo';
}

function extFor(file) {
  if (MIME_EXT[file.mimetype]) return MIME_EXT[file.mimetype];
  const match = String(file.originalname || '').toLowerCase().match(/\.(jpe?g|png|webp|gif|heic|heif)$/);
  if (!match) return '.jpg';
  return match[1] === 'jpeg' ? '.jpg' : `.${match[1]}`;
}

function isImage(file) {
  if (MIME_EXT[file.mimetype]) return true;
  return /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.originalname || '');
}

function contained(root, name) {
  if (!name || path.basename(name) !== name) return null;
  const rootResolved = path.resolve(root);
  const full = path.resolve(root, name);
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) return null;
  return full;
}

function photoFilePath(name) {
  if (!/^[a-f0-9]{16}\.(jpg|png|webp|gif|heic|heif)$/.test(name || '')) return null;
  return contained(PHOTOS, name);
}

function thumbFilePath(name) {
  if (!/^[a-f0-9]{16}\.jpg$/.test(name || '')) return null;
  return contained(THUMBS, name);
}

function toPublicPhoto(photo) {
  const file = photoFilePath(photo.file);
  if (!file || !fs.existsSync(file)) return null;
  const thumb = photo.thumb && thumbFilePath(photo.thumb) && fs.existsSync(thumbFilePath(photo.thumb));
  return {
    id: photo.id,
    guestName: photo.guestName || '',
    originalName: photo.originalName || 'photo',
    uploadedAt: photo.uploadedAt,
    url: `/media/${path.basename(file)}`,
    thumbUrl: thumb ? `/thumbs/${path.basename(photo.thumb)}` : `/media/${path.basename(file)}`
  };
}

function albumPayload() {
  const settings = readSettings();
  const photos = readPhotos()
    .slice()
    .sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)))
    .map(toPublicPhoto)
    .filter(Boolean);
  return {
    title: settings.title,
    subtitle: settings.subtitle,
    photos
  };
}

function hostPayload() {
  const settings = readSettings();
  const qr = readJson(QR_META, {});
  const addresses = lanAddresses();
  return {
    ...albumPayload(),
    publicUrl: settings.publicUrl,
    albumUrl: albumUrl(),
    addresses,
    access: accessMode(),
    linkStatus: tunnelState,
    phoneReady: accessMode() === 'public' || addresses.length > 0,
    qrUpdatedAt: qr.updatedAt || '',
    qrFile: 'storage/qr-code.png'
  };
}

async function writeQr() {
  const url = albumUrl();
  await QRCode.toFile(QR_PATH, url, {
    errorCorrectionLevel: 'H',
    width: 800,
    margin: 2,
    color: { dark: '#241c16', light: '#fffdf8' }
  });
  const record = {
    url,
    file: 'qr-code.png',
    updatedAt: new Date().toISOString()
  };
  writeJson(QR_META, record);
  return record;
}

function normalizeSettings(body) {
  const current = readSettings();
  const title = cleanName(body.title ?? current.title) || DEFAULT_SETTINGS.title;
  const subtitle = String(body.subtitle ?? current.subtitle).replace(/[\u0000-\u001F]/g, '').trim().slice(0, 160);
  let publicUrl = String(body.publicUrl ?? '').trim();
  if (publicUrl) {
    let parsed;
    try {
      parsed = new URL(publicUrl);
    } catch {
      const err = new Error('Unesite cijeli link koji počinje sa http:// ili https://.');
      err.status = 400;
      throw err;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      const err = new Error('Link mora počinjati sa http:// ili https://.');
      err.status = 400;
      throw err;
    }
    const pathname = parsed.pathname.replace(/\/$/, '');
    publicUrl = parsed.origin + (pathname ? pathname : '');
  }
  return { title, subtitle, publicUrl };
}

async function makeThumb(src, dest) {
  if (!sharp) return false;
  try {
    await sharp(src)
      .rotate()
      .resize({ width: 960, height: 960, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 78 })
      .toFile(dest);
    return true;
  } catch (err) {
    console.warn('No thumbnail for', path.basename(src), '-', err.message);
    try { fs.unlinkSync(dest); } catch { /* no partial thumb */ }
    return false;
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, PHOTOS),
    filename: (req, file, cb) => {
      const id = crypto.randomBytes(8).toString('hex');
      file.storedId = id;
      cb(null, `${id}${extFor(file)}`);
    }
  }),
  limits: { fileSize: 40 * 1024 * 1024, files: 30 },
  fileFilter: (req, file, cb) => {
    if (isImage(file)) cb(null, true);
    else cb(new Error('Mogu se dodati samo fotografije.'));
  }
});

function slug(value) {
  const text = String(value || 'guest')
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return text || 'guest';
}

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '32kb' }));

app.get('/api/album', (req, res) => {
  res.json(albumPayload());
});

app.get('/api/host', (req, res) => {
  res.json(hostPayload());
});

app.put('/api/settings', async (req, res, next) => {
  try {
    const nextSettings = normalizeSettings(req.body || {});
    writeJson(SETTINGS, nextSettings);
    await writeQr();
    res.json(hostPayload());
  } catch (err) {
    next(err);
  }
});

app.post('/api/upload', upload.array('photos', 30), async (req, res, next) => {
  const files = req.files || [];
  try {
    if (!files.length) {
      res.status(400).json({ error: 'Izaberite barem jednu fotografiju.' });
      return;
    }
    const incoming = files.reduce((sum, file) => sum + file.size, 0);
    const used = readPhotos().reduce((sum, photo) => sum + (Number(photo.bytes) || 0), 0);
    if (used + incoming > MAX_ALBUM_BYTES) {
      for (const file of files) {
        try { fs.unlinkSync(file.path); } catch { /* already gone */ }
      }
      res.status(400).json({ error: 'Album je pun.' });
      return;
    }
    const guestName = cleanName(req.body.guestName);
    const added = [];
    for (const file of files) {
      const id = file.storedId;
      const thumbName = `${id}.jpg`;
      const thumbPath = path.join(THUMBS, thumbName);
      const hasThumb = await makeThumb(file.path, thumbPath);
      added.push({
        id,
        file: file.filename,
        thumb: hasThumb ? thumbName : null,
        originalName: cleanOriginalName(file.originalname),
        guestName,
        bytes: file.size,
        mime: file.mimetype,
        uploadedAt: new Date().toISOString()
      });
    }
    await withPhotos((items) => items.concat(added));
    console.log(`Saved ${added.length} photo${added.length === 1 ? '' : 's'} from ${guestName || 'a guest'}`);
    res.status(201).json({ added: added.length, ...albumPayload() });
  } catch (err) {
    for (const file of files) {
      try { fs.unlinkSync(file.path); } catch { /* already gone */ }
      if (file.storedId) {
        try { fs.unlinkSync(path.join(THUMBS, `${file.storedId}.jpg`)); } catch { /* no thumb */ }
      }
    }
    next(err);
  }
});

app.get('/api/download', (req, res) => {
  const photos = readPhotos().filter((photo) => photoFilePath(photo.file));
  if (!photos.length) {
    res.status(404).json({ error: 'Još nema fotografija za preuzimanje.' });
    return;
  }
  res.attachment('wedding-photos.zip');
  const archive = archiver('zip', { zlib: { level: 1 } });
  archive.on('error', (err) => {
    console.error(err);
    if (!res.headersSent) res.status(500).end();
    else res.end();
  });
  archive.pipe(res);
  for (const photo of photos) {
    const full = photoFilePath(photo.file);
    const when = String(photo.uploadedAt || '').slice(0, 10);
    const ext = path.extname(photo.file);
    archive.file(full, { name: `${when}_${slug(photo.guestName)}_${photo.id}${ext}` });
  }
  archive.finalize();
});

app.get('/qr-code.png', (req, res) => {
  if (!fs.existsSync(QR_PATH)) {
    res.status(404).end();
    return;
  }
  res.set('Cache-Control', 'no-store');
  res.type('png');
  res.sendFile(QR_PATH);
});

app.use('/media', express.static(PHOTOS, {
  index: false,
  dotfiles: 'deny',
  fallthrough: false,
  maxAge: '30d'
}));
app.use('/thumbs', express.static(THUMBS, {
  index: false,
  dotfiles: 'deny',
  fallthrough: false,
  maxAge: '30d'
}));

app.get('/host', (req, res) => {
  res.sendFile(path.join(PUBLIC, 'host.html'));
});

app.use(express.static(PUBLIC, { index: 'index.html', dotfiles: 'ignore' }));

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Nije pronađeno.' });
});

app.use((err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    res.status(400).json({ error: 'Svaka fotografija mora biti manja od 40 MB.' });
    return;
  }
  if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
    res.status(400).json({ error: 'Možete dodati najviše 30 fotografija odjednom.' });
    return;
  }
  if (err.status && err.status < 500) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err.message === 'Mogu se dodati samo fotografije.') {
    res.status(400).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Nešto je pošlo po zlu pri čuvanju.' });
});

function cloudflaredAsset() {
  if (process.arch === 'arm64') return 'cloudflared-windows-arm64.exe';
  return 'cloudflared-windows-amd64.exe';
}

function bundledCloudflared() {
  return path.join(BIN, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
}

async function ensureCloudflared() {
  const bundled = bundledCloudflared();
  if (fs.existsSync(bundled)) return bundled;
  if (process.platform !== 'win32') return 'cloudflared';
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${cloudflaredAsset()}`;
  console.log('Downloading the public link tool. This happens once.');
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Could not download the public link tool (${res.status}).`);
  const partial = `${bundled}.download`;
  fs.writeFileSync(partial, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(partial, bundled);
  return bundled;
}

function startPublicLink() {
  if (readSettings().publicUrl) {
    tunnelState = 'up';
    return;
  }
  tunnelState = 'connecting';
  ensureCloudflared()
    .then((bin) => {
      const child = spawn(bin, [
        'tunnel',
        '--url', `http://127.0.0.1:${PORT}`,
        '--no-autoupdate',
        '--protocol', 'http2'
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      tunnelProcess = child;
      let settled = false;
      let log = '';
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        tunnelState = 'failed';
        console.error('The public link did not come up. Guests on this Wi-Fi can still upload.');
      }, 45000);
      const watch = (chunk) => {
        log = (log + chunk.toString()).slice(-2500);
        const match = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (!match || match[0] === tunnelUrl) return;
        settled = true;
        clearTimeout(timer);
        tunnelUrl = match[0];
        tunnelState = 'up';
        writeQr()
          .then(() => {
            console.log(`  Public upload page: ${albumUrl()}`);
            console.log('  Guests can be on any network. Leave this computer on.');
          })
          .catch((err) => console.error('Could not update the QR code.', err));
      };
      child.stdout.on('data', watch);
      child.stderr.on('data', watch);
      child.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
        }
        tunnelState = 'failed';
        tunnelUrl = '';
        console.error('Public link failed:', err.message);
      });
      child.on('exit', (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          tunnelState = 'failed';
          console.error('Public link failed to start.');
          if (log.trim()) console.error(log.trim());
          return;
        }
        if (tunnelState === 'up') {
          tunnelState = 'failed';
          tunnelUrl = '';
          writeQr().catch(() => {});
          console.error(`The public link stopped (${code}). Restart the album to open a new one.`);
        }
      });
    })
    .catch((err) => {
      tunnelState = 'failed';
      console.error(err.message);
    });
}

function stopPublicLink() {
  if (tunnelProcess && !tunnelProcess.killed) tunnelProcess.kill();
}

process.on('SIGINT', () => {
  stopPublicLink();
  process.exit(0);
});
process.on('SIGTERM', () => {
  stopPublicLink();
  process.exit(0);
});

writeQr()
  .then(() => {
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log('');
      console.log('Wedding photo album is running');
      console.log(`  On this computer:  http://localhost:${PORT}`);
      console.log(`  QR code page:      http://localhost:${PORT}/host`);
      console.log(`  QR image saved:    ${QR_PATH}`);
      console.log(`  Photos saved in:   ${PHOTOS}`);
      if (readSettings().publicUrl) {
        console.log(`  Phone upload page: ${albumUrl()}`);
        console.log('  Guests can be on any network. Leave this computer on.');
      } else {
        console.log('  Opening a public link so phones do not need this Wi-Fi...');
        startPublicLink();
      }
      console.log('');
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. Close the other app, or start with a different port: set PORT=8790 && npm start`);
        process.exit(1);
      }
      throw err;
    });
  })
  .catch((err) => {
    console.error('Could not create the QR code.', err);
    process.exit(1);
  });

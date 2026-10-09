const page = document.body.dataset.page;
const titleEl = document.getElementById('title');
const subtitleEl = document.getElementById('subtitle');
const grid = document.getElementById('grid');
const empty = document.getElementById('empty');
const countEl = document.getElementById('count');
const lightbox = document.getElementById('lightbox');
const lightImg = document.getElementById('light-img');
const lightCap = document.getElementById('light-cap');
const statusEl = document.getElementById('status');

let photos = [];
let lastKey = '';
let openId = null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function setStatus(text, kind) {
  if (!statusEl) return;
  statusEl.textContent = text || '';
  statusEl.className = 'status' + (kind ? ` ${kind}` : '');
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

function caption(photo) {
  const who = photo.guestName || 'Gost';
  const d = new Date(photo.uploadedAt);
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${who} · ${d.getDate()}. ${MONTHS[d.getMonth()]} ${d.getHours()}:${minutes}`;
}

function photoCount(n, accusative) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  const one = mod10 === 1 && mod100 !== 11;
  const few = mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14);
  if (accusative && one) return `${n} fotografiju`;
  if (one || !few) return `${n} fotografija`;
  return `${n} fotografije`;
}

function renderPhotos(next) {
  const key = next.map((photo) => photo.id).join(',');
  photos = next;
  const changed = key !== lastKey;
  lastKey = key;
  if (countEl) {
    countEl.textContent = photos.length === 0 ? '' : photoCount(photos.length);
  }
  if (empty) empty.hidden = photos.length > 0;
  if (!changed) return;

  grid.replaceChildren();
  for (const photo of photos) {
    const wrap = el('div', 'tile-wrap');
    const button = el('button', 'tile');
    button.type = 'button';
    button.setAttribute('aria-label', caption(photo));
    const img = document.createElement('img');
    img.src = photo.thumbUrl;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => {
      img.replaceWith(el('span', 'unpreview', 'Pregled nije dostupan'));
    });
    button.append(img);
    button.addEventListener('click', () => openLightbox(photo.id));
    wrap.append(button);
    grid.append(wrap);
  }

  if (!lightbox.hidden) {
    if (!photos.some((photo) => photo.id === openId)) closeLightbox();
    else showImage();
  }
}

function applyAlbum(data) {
  if (titleEl) titleEl.textContent = data.title || 'Edis & Nina';
  if (subtitleEl) subtitleEl.textContent = data.subtitle || '';
  document.title = page === 'host'
    ? `${data.title || 'Edis & Nina'} · QR kod`
    : (data.title || 'Edis & Nina');
  renderPhotos(data.photos || []);
}

function openLightbox(id) {
  openId = id;
  lightbox.hidden = false;
  showImage();
}

function closeLightbox() {
  lightbox.hidden = true;
  openId = null;
  lightImg.removeAttribute('src');
}

function showImage() {
  const photo = photos.find((item) => item.id === openId);
  if (!photo) return;
  lightImg.src = photo.url;
  lightImg.alt = caption(photo);
  lightCap.textContent = caption(photo);
}

function step(delta) {
  const index = photos.findIndex((photo) => photo.id === openId);
  if (index < 0 || !photos.length) return;
  const next = photos[(index + delta + photos.length) % photos.length];
  openId = next.id;
  showImage();
}

document.getElementById('close').addEventListener('click', closeLightbox);
document.getElementById('prev').addEventListener('click', () => step(-1));
document.getElementById('next').addEventListener('click', () => step(1));
lightbox.addEventListener('click', (event) => {
  if (event.target === lightbox) closeLightbox();
});

let touchX = 0;
lightbox.addEventListener('touchstart', (event) => {
  touchX = event.changedTouches[0].clientX;
}, { passive: true });
lightbox.addEventListener('touchend', (event) => {
  const dx = event.changedTouches[0].clientX - touchX;
  if (Math.abs(dx) < 40) return;
  step(dx > 0 ? -1 : 1);
}, { passive: true });

document.addEventListener('keydown', (event) => {
  if (lightbox.hidden) return;
  if (event.key === 'Escape') closeLightbox();
  if (event.key === 'ArrowLeft') step(-1);
  if (event.key === 'ArrowRight') step(1);
});

async function refreshAlbum() {
  const res = await fetch('/api/album');
  if (!res.ok) return;
  applyAlbum(await res.json());
}

if (page === 'guest') {
  const guestName = document.getElementById('guest-name');
  const files = document.getElementById('files');
  const camera = document.getElementById('camera');
  const drop = document.getElementById('drop');
  const picks = document.getElementById('picks');
  const uploadBtn = document.getElementById('upload');
  const bar = document.getElementById('bar');
  const barFill = document.getElementById('bar-fill');
  let queue = [];
  let sending = false;

  const savedName = sessionStorage.getItem('guestName');
  if (savedName) guestName.value = savedName;
  guestName.addEventListener('input', () => {
    sessionStorage.setItem('guestName', guestName.value);
  });

  function renderPicks() {
    picks.hidden = queue.length === 0;
    picks.replaceChildren();
    queue.forEach((item) => {
      const li = el('li', 'pick');
      const img = document.createElement('img');
      img.src = item.url;
      img.alt = '';
      const remove = el('button', 'pick-x', 'Ukloni');
      remove.type = 'button';
      remove.addEventListener('click', () => {
        URL.revokeObjectURL(item.url);
        queue = queue.filter((entry) => entry !== item);
        renderPicks();
      });
      li.append(img, remove);
      picks.append(li);
    });
    uploadBtn.disabled = queue.length === 0 || sending;
    if (!queue.length) uploadBtn.textContent = 'Dodajte u album';
    else uploadBtn.textContent = `Dodajte ${photoCount(Math.min(queue.length, 30), true)}`;
  }

  function addFiles(list) {
    const images = [...list].filter((file) => file.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.name));
    if (!images.length) {
      setStatus('To nisu fotografije.', 'error');
      return;
    }
    for (const file of images) {
      queue.push({ file, url: URL.createObjectURL(file) });
    }
    if (queue.length > 30) {
      setStatus('Ovaj put će biti dodato samo prvih 30 fotografija.', 'error');
    } else {
      setStatus('');
    }
    renderPicks();
  }

  files.addEventListener('change', () => {
    addFiles(files.files);
    files.value = '';
  });
  camera.addEventListener('change', () => {
    addFiles(camera.files);
    camera.value = '';
  });
  drop.addEventListener('dragover', (event) => {
    event.preventDefault();
    drop.classList.add('hot');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('hot'));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('hot');
    addFiles(event.dataTransfer.files);
  });

  async function compress(file) {
    const type = file.type || '';
    if (type === 'image/gif' || /\.gif$/i.test(file.name)) return file;
    if (file.size < 900000 && (type === 'image/jpeg' || /\.jpe?g$/i.test(file.name))) return file;
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(bitmap, 0, 0, width, height);
      if (bitmap.close) bitmap.close();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
      if (!blob || (scale === 1 && blob.size >= file.size)) return file;
      const base = file.name.replace(/\.[^.]+$/, '') || 'photo';
      return new File([blob], `${base}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
    } catch {
      return file;
    }
  }

  uploadBtn.addEventListener('click', async () => {
    if (!queue.length || sending) return;
    sending = true;
    uploadBtn.disabled = true;
    const batch = queue.slice(0, 30);
    const prepared = [];
    try {
      for (let i = 0; i < batch.length; i += 1) {
        setStatus(`Priprema ${i + 1} od ${batch.length}…`);
        prepared.push(await compress(batch[i].file));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } catch {
      sending = false;
      renderPicks();
      setStatus('Fotografije nije moguće pripremiti.', 'error');
      return;
    }

    const body = new FormData();
    body.append('guestName', guestName.value.trim());
    for (const file of prepared) body.append('photos', file);

    bar.hidden = false;
    barFill.style.width = '0%';
    setStatus('Šalje se…');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const pct = Math.round((event.loaded / event.total) * 100);
      barFill.style.width = `${pct}%`;
      setStatus(`Šalje se… ${pct}%`);
    };
    xhr.onerror = () => {
      sending = false;
      bar.hidden = true;
      renderPicks();
      setStatus('Slanje nije uspjelo. Ostanite na ovoj mreži i pokušajte ponovo.', 'error');
    };
    xhr.onload = () => {
      sending = false;
      bar.hidden = true;
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* not json */ }
      if (xhr.status < 200 || xhr.status >= 300) {
        renderPicks();
        setStatus(data.error || 'Slanje nije uspjelo.', 'error');
        return;
      }
      for (const item of batch) URL.revokeObjectURL(item.url);
      queue = queue.slice(batch.length);
      renderPicks();
      applyAlbum(data);
      const n = data.added || batch.length;
      const mod10 = n % 10;
      const mod100 = n % 100;
      const one = mod10 === 1 && mod100 !== 11;
      const few = mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14);
      const added = one
        ? `Dodana je ${photoCount(n)}.`
        : few
          ? `Dodane su ${photoCount(n)}.`
          : `Dodano je ${photoCount(n)}.`;
      setStatus(added, 'ok');
    };
    xhr.send(body);
  });

  refreshAlbum();
  setInterval(refreshAlbum, 5000);
}

let formReady = false;
let qrVersion = '';

function applyHost(data) {
  applyAlbum(data);
  const url = document.getElementById('qr-url');
  const reach = document.getElementById('reach');
  const qr = document.getElementById('qr');
  const addresses = document.getElementById('addresses');
  const publicUrl = document.getElementById('public-url');
  const titleInput = document.getElementById('album-title');
  const subtitleInput = document.getElementById('album-subtitle');
  const zip = document.getElementById('download-zip');

  if (url) url.textContent = data.albumUrl || '';
  if (reach) {
    if (data.access === 'public' && data.publicUrl) {
      reach.textContent = 'QR kod otvara link koji ste sačuvali. Gosti mogu biti na bilo kojoj mreži.';
    } else if (data.access === 'public') {
      reach.textContent = 'Gosti mogu dodavati fotografije sa bilo koje mreže. Ostavite ovaj računar uključen.';
    } else if (data.linkStatus === 'connecting') {
      reach.textContent = 'Otvara se javni link kako bi gosti mogli dodavati fotografije sa bilo koje mreže.';
    } else if (!data.phoneReady) {
      reach.textContent = 'Ovaj računar nema mrežnu adresu, a javni link još nije spreman.';
    } else {
      reach.textContent = 'Javni link se nije pokrenuo. Gosti moraju biti na istoj Wi-Fi mreži kao ovaj računar.';
    }
  }
  if (!formReady && titleInput) {
    titleInput.value = data.title || '';
    subtitleInput.value = data.subtitle || '';
    publicUrl.value = data.publicUrl || '';
    formReady = true;
  }
  if (qr && data.qrUpdatedAt && data.qrUpdatedAt !== qrVersion) {
    qrVersion = data.qrUpdatedAt;
    qr.src = `/qr-code.png?v=${encodeURIComponent(qrVersion)}`;
  }
  if (addresses && publicUrl && data.access === 'public') {
    if (addresses.dataset.ips !== '') {
      addresses.dataset.ips = '';
      addresses.replaceChildren();
    }
  } else if (addresses && publicUrl) {
    const addressKey = (data.addresses || []).join(',');
    if (addresses.dataset.ips !== addressKey) {
      addresses.dataset.ips = addressKey;
      addresses.replaceChildren();
      for (const ip of data.addresses || []) {
        const chip = el('button', 'chip', ip);
        chip.type = 'button';
        chip.addEventListener('click', () => {
          publicUrl.value = `http://${ip}:${location.port || '8787'}`;
        });
        addresses.append(chip);
      }
    }
  }
  if (zip) {
    zip.setAttribute('aria-disabled', photos.length ? 'false' : 'true');
    zip.style.opacity = photos.length ? '' : '0.45';
  }
}

async function refreshHost() {
  const res = await fetch('/api/host');
  if (!res.ok) return;
  applyHost(await res.json());
}

if (page === 'host') {
  const form = document.getElementById('settings');
  const zip = document.getElementById('download-zip');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setStatus('Čuva se…');
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: document.getElementById('album-title').value,
        subtitle: document.getElementById('album-subtitle').value,
        publicUrl: document.getElementById('public-url').value
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(data.error || 'QR kod nije moguće osvježiti.', 'error');
      return;
    }
    qrVersion = '';
    applyHost(data);
    setStatus('QR kod je osvježen.', 'ok');
  });

  document.getElementById('use-lan').addEventListener('click', () => {
    document.getElementById('public-url').value = '';
    form.requestSubmit();
  });

  document.getElementById('print').addEventListener('click', () => window.print());

  zip.addEventListener('click', (event) => {
    if (!photos.length) {
      event.preventDefault();
      setStatus('Još nema fotografija za preuzimanje.', 'error');
    }
  });

  refreshHost();
  setInterval(refreshHost, 5000);
}

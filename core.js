// Core: the replaceable part of the loader (docs/PROTOCOL.md, section 6). It owns the whole user
// interface, including its style sheet, so that a newer core received over QR can change anything
// except the trusted keys. Shared modules are imported from boot.base, never by relative URL,
// because a stored core runs from a blob: URL.
export const VERSION = 0; // stamped by tools/build.mjs

const CSS = `
:root { --fg: #33ff66; --dim: #1a9c40; --bg: #050805; --hi: #b6ffc9; }
:root[data-theme=amber] { --fg: #ffb000; --dim: #a36f00; --bg: #080602; --hi: #ffe2a3; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; overflow: hidden; background: var(--bg); color: var(--fg); }
body { font: 14px/1.35 ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace; text-transform: uppercase;
  text-shadow: 0 0 4px color-mix(in srgb, var(--fg) 60%, transparent); -webkit-user-select: none; user-select: none; }
#cam, #marks, #tint, #lines { position: fixed; inset: 0; width: 100%; height: 100%; pointer-events: none; }
#cam { object-fit: cover; filter: grayscale(1) contrast(1.3) brightness(.7); }
#tint { background: var(--fg); mix-blend-mode: multiply; }
#lines { background: repeating-linear-gradient(transparent 0 2px, rgba(0,0,0,.28) 2px 3px); z-index: 30; }
#term { position: fixed; left: 0; right: 0; bottom: 0; padding: 10px max(12px, env(safe-area-inset-right)) max(12px, env(safe-area-inset-bottom)) max(12px, env(safe-area-inset-left));
  background: color-mix(in srgb, var(--bg) 88%, transparent); border-top: 2px solid var(--fg); }
#log { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 9.5em; overflow: hidden; font: inherit; }
#status { margin: 6px 0; white-space: pre; overflow: hidden; color: var(--hi); }
#status::after { content: "\\2588"; animation: blink 1s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0; } }
.row { display: flex; flex-wrap: wrap; gap: 8px; }
button { font: inherit; text-transform: inherit; color: var(--fg); background: var(--bg); border: 2px solid var(--fg); padding: 6px 10px; cursor: pointer; text-shadow: inherit; }
button:active, button:focus-visible { background: var(--fg); color: var(--bg); outline: none; }
button b { text-decoration: underline; font-weight: inherit; }
.layer { position: fixed; inset: 0; z-index: 10; background: var(--bg); overflow: auto; padding: max(14px, env(safe-area-inset-top)) 14px max(14px, env(safe-area-inset-bottom)); }
.box { max-width: 560px; margin: 0 auto; border: 2px double var(--fg); padding: 14px; }
.box h2 { font: inherit; color: var(--hi); margin-bottom: 8px; }
.box p { margin-bottom: 12px; overflow-wrap: anywhere; }
#dlg { z-index: 20; background: color-mix(in srgb, var(--bg) 75%, transparent); display: grid; place-items: center; }
#dlg .box { width: 100%; background: var(--bg); }
table { width: 100%; border-collapse: collapse; margin: 8px 0 14px; }
td { padding: 6px 4px; vertical-align: top; border-bottom: 1px dashed var(--dim); overflow-wrap: anywhere; }
td:last-child { text-align: right; white-space: nowrap; }
td button { padding: 2px 6px; margin: 2px 0 2px 4px; }
.dim { color: var(--dim); }
#tx { z-index: 40; display: flex; flex-direction: column; align-items: center; gap: 10px; }
#codes { flex: 1; width: 100%; display: grid; gap: 12px; place-content: center; }
#codes canvas { image-rendering: pixelated; background: #fff; border: 2px solid var(--fg); }
#tx .st { color: var(--hi); white-space: pre-wrap; text-align: center; }
#app { z-index: 15; padding: 0; } #app iframe { width: 100%; height: 100%; border: 0; background: #000; }
#app > button { position: fixed; top: max(10px, env(safe-area-inset-top)); right: 10px; z-index: 1; }
.media { max-width: 100%; max-height: 50vh; display: block; margin: 0 auto 12px; border: 2px solid var(--fg); }
.hidden { display: none !important; }
@media (prefers-reduced-motion: reduce) { #status::after { animation: none; } }
@media (prefers-contrast: more) { #lines { display: none; } body { text-shadow: none; } }
`;

const HTML = `
<video id="cam" playsinline muted autoplay></video><div id="tint"></div><canvas id="marks"></canvas>
<div id="term" role="status" aria-live="polite">
  <pre id="log"></pre><div id="status">READY. POINT AT A QR STREAM </div>
  <div class="row"><button id="b-lib"><b>L</b>IBRARY</button><button id="b-open"><b>O</b>PEN GIF/VIDEO</button><button id="b-send"><b>S</b>END FILE</button></div>
</div>
<div id="dlg" class="layer hidden" role="dialog" aria-modal="true"><div class="box"><h2></h2><p></p><div class="row"></div></div></div>
<div id="lib" class="layer hidden"></div>
<div id="tx" class="layer hidden"><div id="codes"></div><div class="st"></div><div class="row"></div></div>
<div id="lines"></div>
<input id="f-open" type="file" accept="image/gif,video/*" hidden><input id="f-send" type="file" hidden>`;

const DENSITY = [300, 700, 1200, 2000]; // bytes per code
const PREVIEW = /^(image\/(png|jpeg|gif|webp|avif)|video\/|audio\/)/; // never SVG or HTML
const kb = n => n < 1024 ? n + ' B' : (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const pref = (k, v) => { try { if (v === undefined) return JSON.parse(localStorage.getItem('qrb.' + k)); localStorage.setItem('qrb.' + k, JSON.stringify(v)); } catch {} };

export async function start(boot) {
  const { db, base } = boot;
  const F = await import(base + 'fountain.js'), G = await import(base + 'gif.js');
  const logEl = document.getElementById('log'), bootLog = logEl?.textContent ?? '';
  document.head.insertAdjacentHTML('beforeend', `<style>${CSS}</style>`);
  document.body.innerHTML = HTML;
  document.documentElement.dataset.theme = pref('theme') ?? 'green';
  const $ = id => document.getElementById(id);
  const lines = bootLog.split('\n').filter(Boolean);
  const log = s => { lines.push(s); lines.splice(0, lines.length - 40); const el = $('log'); el.textContent = lines.join('\n'); el.scrollTop = el.scrollHeight; };
  const status = s => { $('status').textContent = s + ' '; };
  boot.log = log;
  log(`QR BOOTSTRAP CORE ${VERSION} (${boot.source.toUpperCase()})`);
  log(`PROTOCOL ${F.PROTOCOL}`);
  log(boot.keys.length ? `TRUSTED KEY ${boot.keys.map(k => k.slice(0, 8)).join(' ')}` : 'NO TRUSTED KEY: CODE WILL BE REFUSED');

  // ---- Dialogs (Y/N on a keyboard) -------------------------------------------------
  let dialog = Promise.resolve();
  const ask = (title, text, yes = 'YES', no = 'NO', html = '') => dialog = dialog.then(() => new Promise(done => {
    const d = $('dlg');
    d.querySelector('h2').textContent = title;
    d.querySelector('p').innerHTML = esc(text) + html;
    const row = d.querySelector('.row');
    row.innerHTML = (no ? `<button data-v="0">[<b>${no[0]}</b>]${esc(no.slice(1))}</button>` : '') + `<button data-v="1">[<b>${yes[0]}</b>]${esc(yes.slice(1))}</button>`;
    const finish = v => { d.classList.add('hidden'); removeEventListener('keydown', key); done(v); };
    const key = e => {
      const k = e.key.toUpperCase();
      if (k === yes[0] || k === 'ENTER') finish(true);
      else if ((no && k === no[0]) || k === 'ESCAPE') finish(false);
    };
    row.onclick = e => { const b = e.target.closest('button'); if (b) finish(b.dataset.v === '1'); };
    addEventListener('keydown', key);
    d.classList.remove('hidden');
    row.lastElementChild.focus();
  }));

  // Hands a file to the user: the share sheet where there is one (Save to Files, AirDrop), else a download.
  const save = async file => {
    if (!await ask('FILE READY', `${file.name}  ${kb(file.size)}`, 'SAVE', 'CANCEL')) return;
    if (navigator.canShare?.({ files: [file] })) {
      try { return await navigator.share({ files: [file] }); } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: file.name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  };

  // ---- Decoding worker, camera and video sources ---------------------------------
  const worker = new Worker(base + 'decode-worker.js', { type: 'module' });
  const streams = new Map(); // stream id -> { t0, b }
  let source = null, busy = 0, seen = [], video = $('cam'), camStream = null, paused = false;
  worker.onmessage = ({ data: m }) => {
    if (m.ready) log('DECODER READY');
    if (m.failed) log('DECODER ERROR: ' + m.failed);
    if (m.codes) { if (m.image) busy--; seen.push(...m.codes.map(() => performance.now())); mark(m.codes); }
    if (m.done) log(`GIF: ${m.frames} FRAMES READ`);
    if (m.event) onEvent(m.event).catch(e => log('ERROR: ' + e.message));
  };
  worker.postMessage({ keys: boot.keys });

  function pump() {
    const v = source;
    if (!v) return;
    if (!paused && busy < 2 && v.readyState >= 2 && v.videoWidth) {
      busy++;
      createImageBitmap(v).then(image => worker.postMessage({ image }, [image]), () => busy--);
    }
    v.requestVideoFrameCallback ? v.requestVideoFrameCallback(pump) : requestAnimationFrame(pump);
  }

  async function startCamera() {
    if (camStream) return;
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } } });
      video.srcObject = camStream;
      await video.play();
      const s = camStream.getVideoTracks()[0].getSettings();
      log(`CAMERA ${s.width ?? video.videoWidth}X${s.height ?? video.videoHeight} ${Math.round(s.frameRate ?? 0) || ''} FPS`);
      source = video;
      pump();
    } catch (e) {
      camStream = null;
      log('CAMERA UNAVAILABLE: ' + (e.name === 'NotAllowedError' ? 'PERMISSION DENIED' : e.message) + '. USE OPEN GIF/VIDEO');
    }
  }
  function stopCamera() {
    camStream?.getTracks().forEach(t => t.stop());
    camStream = null;
    video.srcObject = null;
    if (source === video) source = null;
  }

  // Outlines found codes on the viewfinder (video pixels mapped through object-fit: cover).
  const marks = $('marks'), mctx = marks.getContext('2d');
  let fade;
  function mark(codes) {
    if (source !== video || !video.videoWidth) return;
    [marks.width, marks.height] = [innerWidth, innerHeight];
    const k = Math.max(innerWidth / video.videoWidth, innerHeight / video.videoHeight);
    const ox = (innerWidth - video.videoWidth * k) / 2, oy = (innerHeight - video.videoHeight * k) / 2;
    mctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--fg');
    mctx.lineWidth = 3;
    for (const { box: b } of codes) b && mctx.strokeRect(ox + b.x * k, oy + b.y * k, b.width * k, b.height * k);
    clearTimeout(fade);
    fade = setTimeout(() => mctx.clearRect(0, 0, marks.width, marks.height), 250);
  }

  // ---- Receiving ------------------------------------------------------------------
  async function onEvent(e) {
    const sid = e.id.slice(0, 8), now = performance.now();
    if (!streams.has(e.id)) { streams.set(e.id, { t0: now }); log(`RX ${sid}: ${e.n} BLOCKS, ${kb(e.len)}`); }
    if (e.error) { status(`RX ${sid} REJECTED`); return log(`RX ${sid} REJECTED: ${e.error.toUpperCase()}`); }
    const b = Math.ceil(e.len / e.n), secs = Math.max(0.5, (now - streams.get(e.id).t0) / 1000), rate = e.rank * b / secs;
    seen = seen.filter(t => now - t < 1000);
    const bar = '▓'.repeat(Math.round(e.rank / e.n * 16)).padEnd(16, '░');
    status(`RX ${sid} [${bar}] ${Math.floor(e.rank / e.n * 100)}%  ${kb(rate)}/S  ${seen.length} CODES/S  ETA ${Math.ceil((e.n - e.rank + 2) * b / Math.max(rate, 1))}S`);
    if (!e.opened && !e.file) return;
    log(`RX ${sid} COMPLETE: ${kb(e.len)} IN ${secs.toFixed(1)} S (${kb(e.len / secs)}/S)`);
    if (e.file) return receivedFile(e);
    return receivedCode(e);
  }

  async function receivedCode({ id: sid, container, opened: o }) {
    const top = (await db.get('v:' + o.id)) ?? 0;
    if (o.version < top) return log(`REFUSED "${o.id}" V${o.version}: OLDER THAN V${top}`);
    if ((await db.get('ok:' + o.id)) !== o.signer) {
      const what = o.id === 'loader' ? `UPDATE THE LOADER TO V${o.version}?` : `RUN "${o.id}" V${o.version}?`;
      if (!await ask(what, `${o.type} signed by ${o.signer}. It will be kept in the library.`)) {
        worker.postMessage({ hold: sid, ms: 30_000 });
        return log(`CANCELLED "${o.id}"`);
      }
      await db.put('ok:' + o.id, o.signer);
    }
    await db.put('v:' + o.id, Math.max(top, o.version));
    const prev = await db.get('app:' + o.id);
    if (!prev || prev.version <= o.version) {
      await db.put('app:' + o.id, { id: o.id, type: o.type, version: o.version, signer: o.signer, container, size: container.length, time: Date.now() });
    }
    if (o.id !== 'loader') return run(o);
    if (o.version <= boot.version) return log(`LOADER V${o.version} STORED; RUNNING V${boot.version} IS NOT OLDER`);
    log(`LOADER V${o.version} STORED`);
    if (await ask('LOADER UPDATED', `Version ${o.version} starts on the next launch. If it fails, version ${boot.version} comes back.`, 'RESTART', 'LATER')) location.reload();
  }

  async function receivedFile({ id: sid, container, file }) {
    const blob = new File([file.bytes], file.name, { type: file.mime }), url = URL.createObjectURL(blob);
    const kind = PREVIEW.test(file.mime) ? file.mime.split('/')[0] : '';
    const media = kind === 'image' ? `<img class="media" src="${url}" alt="">` : kind ? `<${kind} class="media" src="${url}" controls playsinline></${kind}>` : '';
    log(`FILE "${file.name}" ${kb(file.bytes.length)} ${file.mime}`);
    if (await ask(`FILE "${file.name}"`, `${file.mime}, ${kb(file.bytes.length)}. Keep it in the library to send it on?`, 'KEEP', 'NO', media)) {
      await db.put('file:' + sid, { id: sid, name: file.name, mime: file.mime, size: file.bytes.length, container, time: Date.now() });
      log(`KEPT "${file.name}"`);
    }
    URL.revokeObjectURL(url);
    await save(blob);
  }

  // ---- Running signed code ----------------------------------------------------------
  const modules = new Map();
  async function run({ type, id, payload }) {
    const text = new TextDecoder().decode(payload);
    if (type === 'json') { modules.set(id, JSON.parse(text)); return log(`LOADED "${id}"`); }
    if (type === 'html') { // opaque origin: no access to this page's storage, cache or keys
      paused = true;
      const app = document.createElement('div'), frame = document.createElement('iframe'), close = document.createElement('button');
      app.id = 'app';
      app.className = 'layer';
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.title = id;
      frame.srcdoc = text;
      close.textContent = '[X]';
      close.setAttribute('aria-label', 'Close ' + id);
      close.onclick = () => { app.remove(); paused = false; };
      app.append(frame, close);
      document.body.append(app);
      frame.focus();
      return log(`RUN "${id}"`);
    }
    if (type !== 'mjs') throw new Error('unknown type ' + type);
    const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
    try {
      const mod = await import(url);
      modules.set(id, mod);
      await mod.init?.({ id, modules, log, startScanner: startCamera, stopScanner: stopCamera });
      log(`RUN "${id}"`);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // ---- Library ------------------------------------------------------------------------
  async function loaderContainer() {
    const s = await db.get('app:loader');
    if (s?.version === boot.version) return s.container;
    try {
      const r = await fetch(base + 'core.bin');
      if (r.ok) return new Uint8Array(await r.arrayBuffer());
    } catch {}
    return null;
  }

  async function library() {
    const apps = (await db.list('app:')).filter(a => a.id !== 'loader'), files = await db.list('file:');
    const lc = await loaderContainer(), el = $('lib');
    const row = (name, what, key, open, send) => `<tr><td>${esc(name)}<br><span class="dim">${esc(what)}</span></td><td>` +
      (open ? `<button data-a="open" data-k="${key}">${open}</button>` : '') +
      (send ? `<button data-a="tx" data-k="${key}">TX</button><button data-a="gif" data-k="${key}">GIF</button>` : '') +
      (key !== 'loader' ? `<button data-a="del" data-k="${key}">DEL</button>` : '') + '</td></tr>';
    el.innerHTML = `<div class="box"><h2>DIR</h2><table>` +
      row('LOADER', `MJS V${boot.version} ${boot.source}${boot.bad.length ? ', FAILED: ' + boot.bad.join(' ') : ''}`, 'loader', '', !!lc) +
      apps.map(a => row(a.id, `${a.type} V${a.version} ${kb(a.size)}`, 'app:' + a.id, 'RUN', true)).join('') +
      files.map(f => row(f.name, `${f.mime} ${kb(f.size)}`, 'file:' + f.id, 'SAVE', true)).join('') +
      `</table><p class="dim">${apps.length + files.length + 1} ENTRIES</p><div class="row">` +
      `<button data-a="send"><b>S</b>END FILE</button><button data-a="theme">${pref('theme') === 'amber' ? 'GREEN' : 'AMBER'}</button>` +
      `<button data-a="reset">RESET LOADER</button><button data-a="close">[<b>X</b>] CLOSE</button></div></div>`;
    el.classList.remove('hidden');
    el.onclick = async e => {
      const b = e.target.closest('button');
      if (!b) return;
      const k = b.dataset.k, a = b.dataset.a, rec = k && k !== 'loader' ? await db.get(k) : null;
      const container = k === 'loader' ? lc : rec?.container, name = k === 'loader' ? 'loader' : k.startsWith('file:') ? rec?.name : rec?.id;
      if (a === 'close') el.classList.add('hidden');
      else if (a === 'theme') { pref('theme', pref('theme') === 'amber' ? 'green' : 'amber'); document.documentElement.dataset.theme = pref('theme'); library(); }
      else if (a === 'reset') { if (await ask('RESET LOADER?', 'Forget the stored loader and start the bundled one.', 'RESET', 'NO')) boot.reset(); }
      else if (a === 'send') $('f-send').click();
      else if (a === 'del') { if (await ask(`DELETE "${name}"?`, 'It is removed from this device.', 'DELETE', 'NO')) { await db.del(k); library(); } }
      else if (a === 'tx') { el.classList.add('hidden'); transmit(container, name); }
      else if (a === 'gif') exportGif(container, name);
      else if (a === 'open' && k.startsWith('app:')) { el.classList.add('hidden'); run(await F.open(rec.container, await Promise.all(boot.keys.map(F.loadKey)))); }
      else if (a === 'open') { const f = await F.openFile(rec.container); save(new File([f.bytes], f.name, { type: f.mime })); }
    };
  }

  // ---- Transmitting: an endless stream of codes on screen ---------------------------
  const tx = pref('tx') ?? { density: 1, codes: 1, fps: 15 }; // defaults measured by test/bench.mjs
  const blockFor = len => Math.max(DENSITY[tx.density], Math.ceil(len / F.MAX_N));

  async function transmit(container, name) {
    const el = $('tx'), codesEl = $('codes');
    let enc = await F.encoder(container, blockFor(container.length)), seed = crypto.getRandomValues(new Uint32Array(1))[0] >>> 1, lock, raf, last = 0, cvs = [];
    paused = true;
    stopCamera();
    try { lock = await navigator.wakeLock?.request('screen'); } catch {}
    const layout = () => {
      const land = innerWidth > innerHeight, cols = tx.codes === 1 ? 1 : land || tx.codes === 4 ? 2 : 1, rows = Math.ceil(tx.codes / cols);
      const size = Math.floor(Math.min((innerWidth - 40) / cols, (innerHeight - 170) / rows) - 12);
      codesEl.style.gridTemplateColumns = `repeat(${cols}, ${size}px)`;
      codesEl.innerHTML = '';
      cvs = Array.from({ length: tx.codes }, () => codesEl.appendChild(Object.assign(document.createElement('canvas'), { style: `width:${size}px;height:${size}px` })));
    };
    // Each cycle opens with a film-leader countdown: QR codes of this page's #scan address, which a
    // phone without the loader can open with its camera app before the data frames begin.
    const url = location.href.replace(/#.*$/, '') + '#scan', COUNT = 5, leader = G.renderIntro(url, [5, 4, 3, 2, 1], 400);
    let t0 = performance.now();
    const info = digit => {
      el.querySelector('.st').textContent = `TX "${name}"  ${kb(container.length)} IN ${enc.n} BLOCKS OF ${kb(enc.b)}\n` +
        (digit ? `COUNTDOWN ${digit}: SCAN WITH A CAMERA APP TO OPEN THE LOADER` : `${tx.fps} FPS x ${tx.codes} CODES = ${kb(tx.fps * tx.codes * enc.b)}/S  SEED ${seed}`);
    };
    const paint = (c, px, side) => {
      if (c.width !== side) c.width = c.height = side;
      const g = c.getContext('2d'), id = g.createImageData(side, side);
      px.forEach((v, p) => { id.data.fill(v ? 0 : 255, p * 4, p * 4 + 3); id.data[p * 4 + 3] = 255; });
      g.putImageData(id, 0, 0);
    };
    const draw = t => {
      raf = requestAnimationFrame(draw);
      if (t - last < 1000 / tx.fps - 4) return;
      last = t;
      const data = Math.max(6, Math.ceil((enc.n * 1.5 + 8) / (tx.codes * tx.fps))); // seconds of data per cycle
      let at = Math.max(0, (t - t0) / 1000); // the first frame can be stamped just before t0
      if (at >= COUNT + data) { t0 = t; at = 0; }
      if (at < COUNT) {
        const digit = COUNT - Math.floor(at);
        cvs.forEach(c => paint(c, leader[COUNT - digit], 400));
        return info(digit);
      }
      const img = G.renderFrames(cvs.map(() => enc.frame(seed++)), { scale: 1, ecc: 'L' });
      cvs.forEach((c, i) => paint(c, img.frames[i], img.width));
      info();
    };
    const set = async (k, v) => {
      tx[k] = v;
      pref('tx', tx);
      if (k === 'density') enc = await F.encoder(container, blockFor(container.length));
      layout();
    };
    const close = () => {
      cancelAnimationFrame(raf);
      removeEventListener('keydown', keys);
      removeEventListener('resize', layout);
      lock?.release();
      el.classList.add('hidden');
      paused = false;
      startCamera();
    };
    const keys = e => ({ ArrowUp: () => set('fps', Math.min(30, tx.fps + 1)), ArrowDown: () => set('fps', Math.max(2, tx.fps - 1)),
      d: () => set('density', (tx.density + 1) % DENSITY.length), c: () => set('codes', [1, 2, 4][([1, 2, 4].indexOf(tx.codes) + 1) % 3]), Escape: close, x: close })[e.key]?.();
    el.querySelector('.row').innerHTML = '<button data-k="ArrowDown">FPS-</button><button data-k="ArrowUp">FPS+</button>' +
      '<button data-k="d"><b>D</b>ENSITY</button><button data-k="c"><b>C</b>ODES</button><button data-k="x">[<b>X</b>]</button>';
    el.querySelector('.row').onclick = e => { const b = e.target.closest('button'); if (b) keys({ key: b.dataset.k }); };
    addEventListener('keydown', keys);
    addEventListener('resize', layout);
    el.classList.remove('hidden');
    layout();
    raf = requestAnimationFrame(draw);
    log(`TX "${name}" ${enc.id.slice(0, 8)}`);
  }

  async function exportGif(container, name) {
    const enc = await F.encoder(container, blockFor(container.length)), count = Math.ceil(enc.n * 1.5) + 8;
    status(`GIF "${name}": RENDERING ${count} FRAMES`);
    await new Promise(r => setTimeout(r, 30));
    const img = G.renderFrames(Array.from({ length: count }, (_, i) => enc.frame(i + 1)), { scale: 4, ecc: 'L' });
    const gif = G.encodeGif(img, { delay: Math.round(100 / Math.min(tx.fps, 10)) });
    status(`GIF "${name}": ${kb(gif.length)}`);
    await save(new File([gif], `${name.replace(/\.[^.]*$/, '') || 'stream'}.gif`, { type: 'image/gif' }));
  }

  // ---- Files in and out ---------------------------------------------------------------
  $('f-open').onchange = async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    log(`OPEN "${f.name}" ${kb(f.size)}`);
    if (f.type === 'image/gif' || /\.gif$/i.test(f.name)) return worker.postMessage({ gif: new Uint8Array(await f.arrayBuffer()) });
    const v = Object.assign(document.createElement('video'), { muted: true, playsInline: true, src: URL.createObjectURL(f) });
    v.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none';
    document.body.append(v); // frame callbacks need a video in the document
    stopCamera();
    source = v;
    v.onended = () => { log(`"${f.name}" ENDED`); URL.revokeObjectURL(v.src); v.remove(); source = null; startCamera(); };
    await v.play();
    pump();
  };

  $('f-send').onchange = async e => {
    let f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (/^image\/(jpeg|png|webp|heic|heif)$/.test(f.type) && f.size > 400_000 &&
        await ask('REDUCE IMAGE?', `${f.name} is ${kb(f.size)}. A JPEG of at most 1600 pixels a side sends in a fraction of the time.`, 'REDUCE', 'KEEP')) {
      const bmp = await createImageBitmap(f), k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const c = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
      f = new File([blob], f.name.replace(/\.[^.]*$/, '') + '.jpg', { type: 'image/jpeg' });
    }
    const container = await F.packFile(f.name, f.type, new Uint8Array(await f.arrayBuffer()));
    if (container.length > F.MAX_LEN) return ask('TOO LARGE', `${f.name} is ${kb(container.length)} after compression; the limit is ${kb(F.MAX_LEN)}.`, 'OK', '');
    const id = await F.streamId(container);
    await db.put('file:' + id, { id, name: f.name, mime: f.type, size: f.size, container, time: Date.now() });
    $('lib').classList.add('hidden');
    transmit(container, f.name);
  };

  $('b-lib').onclick = library;
  $('b-open').onclick = () => $('f-open').click();
  $('b-send').onclick = () => $('f-send').click();
  addEventListener('keydown', e => {
    if (!$('dlg').classList.contains('hidden') || !$('tx').classList.contains('hidden') || e.target.tagName === 'IFRAME') return;
    const k = e.key.toLowerCase();
    if (k === 'l') library();
    else if (k === 'o') $('f-open').click();
    else if (k === 's') $('f-send').click();
    else if (k === 'x' || k === 'escape') $('lib').classList.add('hidden');
  });

  // Landing: `#scan` (the countdown frames of a GIF, and the installed app) starts the scanner.
  // A plain visit shows the loader's own stream, so anyone at the site can pass it on.
  // Any other fragment is taken as one frame.
  const scan = location.hash === '#scan';
  if (location.hash.length > 1 && !scan) {
    let frag = location.hash.slice(1);
    try { frag = decodeURIComponent(frag); } catch {}
    worker.postMessage({ text: frag });
  }
  const own = scan ? null : await loaderContainer();
  if (own) transmit(own, 'loader'); // closing it starts the scanner
  else startCamera(); // not awaited: start() must finish even while the permission prompt is open
  Object.assign(window, { qrboot: { modules, boot, worker, run, transmit, library } });
}

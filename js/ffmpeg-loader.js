/* ---------- ffmpeg.wasm loader (shared) ----------------------------------------
   Shared helper for every tool that transcodes audio/video in the browser
   (audio-converter, video-converter). Same role as otNormalizeImage() in
   common.js: include this file, call otFFmpeg(), and the page pays nothing until
   the first conversion — ~9 MB (brotli) / 32 MB (raw) of wasm is fetched lazily.

   Include AFTER common.js:   <script src="../../js/ffmpeg-loader.js"></script>
   (the page helpers at the bottom use common.js's escHtml() and otFmtSize())

   Usage:
     const ff = await otFFmpeg({ onLoadProgress: e => bar.value = e.allReceived / e.allExpected });
     const blob = await ff.run({
       file:    inputFile,                               // any File/Blob (never copied into the wasm heap)
       args:    ['-i', '{input}', '-c:a', 'libmp3lame', '-b:a', '192k', 'out.mp3'],
       outName: 'out.mp3',
       onProgress: ({ ratio, time }) => …,               // ratio 0..1 (best effort), time = µs of output
       onLog:      ({ type, message }) => …,             // ffmpeg's own stderr/stdout lines
       signal:     abortController.signal,               // abort → worker killed, reloaded for the next run
     });

   How it works (and the four gotchas that shaped it):
   • Everything is pinned to EXACT upstream versions and fetched from jsdelivr, then
     turned into blob: URLs — a Worker cannot be constructed from a cross-origin URL
     and the core is `import()`ed from inside that worker, so both must be same-origin
     blobs. The UMD @ffmpeg/ffmpeg builds its worker from the CDN unless classWorkerURL
     is given, so we must supply one.
   • Every byte that runs is INTEGRITY-CHECKED against a hash recorded here: the UMD
     <script> carries SRI (`integrity` + `crossorigin`), and the worker sources, core
     and wasm are SHA-256'd after download and refused on a mismatch — a blob: URL has
     no SRI of its own, so this is the only check those three ever get. The hashes
     are of the RAW (decoded) files; recompute all of them when bumping a version
     (`openssl dgst -sha256`, and `openssl dgst -sha384 -binary | base64` for the
     script). A CDN that serves a different byte — compromised, or a "helpful" rewrite —
     fails here with words, not as ffmpeg silently running someone else's code.
   • Neither shipped worker file works as a blob on its own: the UMD chunk
     (814.ffmpeg.js) has its `import(coreURL)` compiled by webpack into an empty
     require-context ("Cannot find module 'blob:…'" for ANY core URL — verified),
     and the ESM worker.js has relative `import "./const.js"` lines a blob cannot
     resolve. So _otFFStitchWorker() fetches the three tiny ESM sources
     (const.js + errors.js + worker.js, ~6 KB) and joins them into one module: drop
     the `import` lines, strip the `export` keyword. Deterministic on pinned files;
     re-check it when bumping OT_FFMPEG_VER.ffmpeg.
   • The worker is always created with {type:"module"}, so the ESM core is the one
     to fetch (its `export default createFFmpegCore` is what the worker imports).
     The UMD core would only work from a classic worker.
   • @ffmpeg/util's toBlobURL(url, mime, progress=true) throws "Failed to complete
     download" on jsdelivr: the wasm is served brotli-compressed, so Content-Length
     (9 289 992) never equals the decoded bytes read (32 232 419). otFFmpegToBlobURL()
     below is the same technique with a tolerant length check, and this file has no
     dependency on @ffmpeg/util at all.
   • Single-thread core only (@ffmpeg/core, not core-mt): no SharedArrayBuffer, so no
     COOP/COEP headers are needed and nothing in lib/nginx.sh has to change.
   • Input is mounted with WORKERFS — the wasm reads the File lazily through
     FileReaderSync, so a 1 GB input does not cost 1 GB of wasm heap. Only the OUTPUT
     lives in the (MEMFS) heap; it is read back once and deleted.
   • ffmpeg.wasm cannot interrupt a running exec; the only stop is terminate(), which
     kills the worker and every mount with it. run() does that on abort and kicks off
     a reload from the cached blobs so the next run does not re-download anything.
   • Runs are serialised — one ffmpeg process per page; a second run() waits.
   • The worker rejects with a STRING (`e.toString()`), not an Error, so run() wraps it —
     and a wasm trap ("RuntimeError: memory access out of bounds", "Aborted(…)") leaves
     the instance dead while `.loaded` still reads true. run() detects that, marks the
     error `trap = true` and restarts the worker from the cached blobs, so the next
     run() is healthy. Seen live with libopus in core 0.12.10 (see the audio converter). */

const OT_FFMPEG_VER = { ffmpeg: '0.12.15', core: '0.12.10' };   // bump BOTH deliberately; run the probe again
const OT_FFMPEG_CDN = 'https://cdn.jsdelivr.net/npm';

/* `bytes` is the DECODED size of the pinned file, used only to drive a progress
   bar when the CDN's Content-Length is the compressed size. It is a hint, never a
   check — a wrong number skews the bar, it cannot break the load.
   `sri` / `sha256` ARE checks (see header). Computed 2026-09-18 from the pinned files. */
const OT_FFMPEG_ASSETS = {
  lib:    { url: `${OT_FFMPEG_CDN}/@ffmpeg/ffmpeg@${OT_FFMPEG_VER.ffmpeg}/dist/umd/ffmpeg.js`,      mime: 'text/javascript',  bytes: 4420,
            sri: 'sha384-6gtICseWoSfROfflbGSkg1kwPTH+2SxMvyn0e3THJbNoyPxx5tzNk4EXfLIHD2iD' },
  worker: { urls: ['const.js', 'errors.js', 'worker.js'].map(f => `${OT_FFMPEG_CDN}/@ffmpeg/ffmpeg@${OT_FFMPEG_VER.ffmpeg}/dist/esm/${f}`),
            sha256: ['9e3bc9dd84781c81daf459e2c46eeec815edac35089832681d9a9a0f383060d0',    // const.js
                     '619310d7ef5fe5fefa0a31927db862b7c291713cfef4d71753fa8aafd18f4db6',    // errors.js
                     'feff0ac937ea225e997e1fae997a74f8b8d572423a526da59eb56624b1f3cde7'],   // worker.js
            mime: 'text/javascript', bytes: 6433 },                                                 // stitched, see _otFFStitchWorker
  core:   { url: `${OT_FFMPEG_CDN}/@ffmpeg/core@${OT_FFMPEG_VER.core}/dist/esm/ffmpeg-core.js`,     mime: 'text/javascript',  bytes: 111804,
            sha256: '67a48f11645f85439f3fde4f2119042c16b374b910206b7a7a24f342e28dcae3' },
  wasm:   { url: `${OT_FFMPEG_CDN}/@ffmpeg/core@${OT_FFMPEG_VER.core}/dist/esm/ffmpeg-core.wasm`,   mime: 'application/wasm', bytes: 32232419,
            sha256: '9f57947a5bd530d8f00c5b3f2cb2a3492faa7e5d823315342d6a8656d0a6b7b7' },
};

const OT_FFMPEG_IN_DIR = '/in';          // WORKERFS mount point; the input is /in/<name>
const OT_FFMPEG_TRAP_RE = /RuntimeError|out of bounds|unreachable|Aborted\(|table index|null function|memory access/i;
const OT_FFMPEG_LOG_TAIL = 40;           // stderr lines kept for the error message on a non-zero exit

/* Output MIME by extension — only containers the wasm build can actually MUX
   (verified against `-formats` for the pinned core; see docs of the two converters). */
const OT_FFMPEG_MIME = {
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', aiff: 'audio/aiff', aif: 'audio/aiff',
  wma: 'audio/x-ms-wma', ac3: 'audio/ac3',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', ts: 'video/mp2t', ogv: 'video/ogg',
  flv: 'video/x-flv', '3gp': 'video/3gpp', mpg: 'video/mpeg', mpeg: 'video/mpeg', wmv: 'video/x-ms-wmv',
  gif: 'image/gif', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
};

let _otFF          = null;   // FFmpeg instance (kept across runs; recreated only after terminate())
let _otFFHandle    = null;   // the object otFFmpeg() resolves to
let _otFFBlobs     = null;   // { worker, core, wasm } blob: URLs — cached so a reload never re-downloads
let _otFFReady     = null;   // Promise for the current load/reload; null = nothing in flight or done
let _otFFQueue     = Promise.resolve();
const _otFFLoadCbs = new Set();   // onLoadProgress callbacks of everyone waiting on the first load

function otFFmpegSupported() {
  return typeof WebAssembly === 'object' && typeof Worker === 'function'
    && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
}

function otFFmpegMime(name) {
  const ext = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return (ext && OT_FFMPEG_MIME[ext[1]]) || 'application/octet-stream';
}

function _otFFAbortError(msg) {
  return new DOMException(msg || 'Conversion cancelled', 'AbortError');
}

/* SHA-256 of a BufferSource as lowercase hex. Needs crypto.subtle, which every
   secure context has (https, localhost, file:) — and a page that is NOT in one
   cannot be protected anyway, so it fails closed with words rather than skipping. */
async function _otFFSha256(buf) {
  if (!(globalThis.crypto && crypto.subtle && crypto.subtle.digest)) {
    throw new Error('Cannot verify the ffmpeg engine here: this page is not in a secure context (needs https)');
  }
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  let hex = '';
  for (const b of d) hex += (b < 16 ? '0' : '') + b.toString(16);
  return hex;
}
async function _otFFVerify(buf, expected, url) {
  const got = await _otFFSha256(buf);
  if (got !== expected) throw new Error(`ffmpeg engine file failed its integrity check (${url.replace(/^.*\//, '')}); refusing to run it`);
}

/* fetch → Blob → blob: URL, reporting decoded bytes as they arrive.
   `total` is the response's Content-Length ONLY when the body is not
   content-encoded (else -1), so a caller can trust it when it is positive.
   The blob: URL is minted only after the bytes match asset.sha256. */
async function otFFmpegToBlobURL(asset, onChunk) {
  const resp = await fetch(asset.url);
  if (!resp.ok) throw new Error(`ffmpeg download failed: HTTP ${resp.status} for ${asset.url}`);
  const encoded = !!resp.headers.get('content-encoding');
  const total = encoded ? -1 : parseInt(resp.headers.get('content-length') || '-1', 10);
  const chunks = [];
  let received = 0;
  if (resp.body && typeof resp.body.getReader === 'function') {
    const reader = resp.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (onChunk) onChunk(received, total);
    }
  } else {                                           // very old engines: no streaming, one jump
    const buf = await resp.arrayBuffer();
    chunks.push(new Uint8Array(buf));
    received = buf.byteLength;
    if (onChunk) onChunk(received, total);
  }
  if (total > 0 && received !== total) {
    throw new Error(`ffmpeg download truncated: ${received} of ${total} bytes for ${asset.url}`);
  }
  const blob = new Blob(chunks, { type: asset.mime });
  chunks.length = 0;                                          // the Blob owns the bytes now
  await _otFFVerify(await blob.arrayBuffer(), asset.sha256, asset.url);   // one transient copy (32 MB for the wasm)
  return URL.createObjectURL(blob);
}

/* The @ffmpeg/ffmpeg UMD library is a plain page script (exposes window.FFmpegWASM);
   a cross-origin <script> is fine, it is only the Worker that must be same-origin.
   SRI on it: a mismatch fires `error` (never `load`), so it reads as a load failure. */
function _otFFLoadLib() {
  if (window.FFmpegWASM && window.FFmpegWASM.FFmpeg) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = OT_FFMPEG_ASSETS.lib.url;
    s.integrity = OT_FFMPEG_ASSETS.lib.sri;
    s.crossOrigin = 'anonymous';
    s.onload  = () => (window.FFmpegWASM ? resolve() : reject(new Error('ffmpeg library loaded but window.FFmpegWASM is missing')));
    s.onerror = () => reject(new Error('Could not load the ffmpeg library (network error, or the file failed its integrity check)'));
    document.head.appendChild(s);
  });
}

function _otFFEmitLoad(e) {
  for (const cb of _otFFLoadCbs) { try { cb(e); } catch (_) { /* a listener must not break the load */ } }
}

/* const.js + errors.js + worker.js → one self-contained ES module blob (see header).
   Resolves to [blobURL, bytes]. Refuses to build a worker that still has an
   `import`/`export` it cannot honour, so a changed upstream fails loudly here rather
   than as a mystery "Cannot find module" from inside the worker. */
async function _otFFStitchWorker(asset) {
  const parts = [];
  let bytes = 0;
  for (let i = 0; i < asset.urls.length; i++) {
    const url = asset.urls[i];
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`ffmpeg download failed: HTTP ${resp.status} for ${url}`);
    const raw = await resp.arrayBuffer();                 // hash the bytes as served, before any rewrite
    await _otFFVerify(raw, asset.sha256[i], url);
    const src = new TextDecoder().decode(raw);
    bytes += raw.byteLength;
    parts.push(src.replace(/^import .*$/gm, '').replace(/^export /gm, ''));
  }
  const stitched = parts.join('\n');
  if (/^\s*(import|export)\s/m.test(stitched)) throw new Error('ffmpeg worker sources changed shape; cannot stitch them into one module');
  return [URL.createObjectURL(new Blob([stitched], { type: asset.mime })), bytes];
}

/* Fetches (once) and caches the three blobs, reporting per-asset and cumulative bytes. */
async function _otFFFetchBlobs() {
  if (_otFFBlobs) return _otFFBlobs;
  const order = ['worker', 'core', 'wasm'];
  const allExpected = order.reduce((n, k) => n + OT_FFMPEG_ASSETS[k].bytes, 0) + OT_FFMPEG_ASSETS.lib.bytes;
  let allReceived = OT_FFMPEG_ASSETS.lib.bytes;     // the lib <script> is already in by now
  const urls = {};
  for (const key of order) {
    const asset = OT_FFMPEG_ASSETS[key];
    let last = 0;
    if (asset.urls) {
      [urls[key], last] = await _otFFStitchWorker(asset);
      allReceived += last;
    } else {
      urls[key] = await otFFmpegToBlobURL(asset, (received, total) => {
        allReceived += received - last; last = received;
        _otFFEmitLoad({ asset: key, received, total, expected: asset.bytes, allReceived, allExpected, done: false });
      });
    }
    _otFFEmitLoad({ asset: key, received: last, total: last, expected: asset.bytes, allReceived, allExpected, done: true });
  }
  _otFFBlobs = urls;
  return urls;
}

/* (Re)creates the worker and loads the core into it from the cached blobs. */
async function _otFFLoadCore() {
  const blobs = await _otFFFetchBlobs();
  if (!_otFF) _otFF = new window.FFmpegWASM.FFmpeg();
  await _otFF.load({ classWorkerURL: blobs.worker, coreURL: blobs.core, wasmURL: blobs.wasm });
}

function _otFFEnsureLoaded() {
  if (_otFF && _otFF.loaded) return Promise.resolve();
  if (!_otFFReady) {
    _otFFReady = (async () => {
      try {
        if (!otFFmpegSupported()) throw new Error('This browser cannot run ffmpeg.wasm (needs WebAssembly + Web Workers)');
        await _otFFLoadLib();
        await _otFFLoadCore();
      } finally {
        _otFFReady = null;          // success: .loaded is true; failure: the next call retries
      }
    })();
  }
  return _otFFReady;
}

/* Kill the worker (drops every mount and any in-flight exec) and start a reload
   from the cached blobs so the NEXT run does not pay the load again. The reload
   promise is parked in _otFFReady; nobody awaits it here, so a failure surfaces
   on the next run() instead of as an unhandled rejection now. */
function _otFFTerminateAndReload() {
  if (_otFF) { try { _otFF.terminate(); } catch (_) { /* already dead */ } }
  _otFF = null;
  _otFFEnsureLoaded().catch(() => {});
}

/* Whole-arg and in-arg substitution of the {input} token with the mounted path. */
function _otFFArgs(args, inPath) {
  return args.map(a => {
    a = String(a);
    return inPath && a.includes('{input}') ? a.split('{input}').join(inPath) : a;
  });
}

function _otFFSafeName(file, fallback) {
  const raw  = (file && file.name) || fallback || 'input';
  const base = raw.replace(/^.*[\\/]/, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
  return base || fallback || 'input';
}

/* One conversion. Resolves to a Blob of `outName` (or null when no outName — e.g.
   `-encoders`), rejects with AbortError on abort, or with an Error carrying the last
   stderr lines (`err.log`) on a non-zero ffmpeg exit. `err.trap` = the wasm died and
   was restarted; `err.terminated` = another caller's abort killed this run's worker
   (nothing wrong with the file — it can simply be retried). */
async function _otFFRun({ file, args, outName, outType, onProgress, onLog, signal, timeout = -1 } = {}) {
  if (!Array.isArray(args) || !args.length) throw new Error('run(): args[] is required');
  if (signal && signal.aborted) throw _otFFAbortError();
  await _otFFEnsureLoaded();
  if (signal && signal.aborted) throw _otFFAbortError();

  const ff   = _otFF;
  const tail = [];
  const logCb = ({ type, message }) => {
    if (tail.push(`${type}: ${message}`) > OT_FFMPEG_LOG_TAIL) tail.shift();
    if (onLog) onLog({ type, message });
  };
  const progCb = ({ progress, time }) => {
    if (!onProgress) return;
    const ratio = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
    onProgress({ ratio, time: Number.isFinite(time) ? time : 0 });
  };
  const onAbort = () => _otFFTerminateAndReload();

  ff.on('log', logCb);
  ff.on('progress', progCb);
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  let mounted = false, inPath = null;
  try {
    if (file) {
      const name = _otFFSafeName(file, 'input');
      inPath = `${OT_FFMPEG_IN_DIR}/${name}`;
      // Self-heal: if a previous run's cleanup did not complete (its unmount threw, or the
      // page was mid-abort), /in is still there and createDir would fail every run from
      // here on with no way out. Clearing it first is idempotent on a clean instance.
      await ff.unmount(OT_FFMPEG_IN_DIR).catch(() => {});
      await ff.deleteDir(OT_FFMPEG_IN_DIR).catch(() => {});
      await ff.createDir(OT_FFMPEG_IN_DIR);
      // `blobs` (not `files`) so the in-FS name is ours, not whatever the user's file was called.
      await ff.mount('WORKERFS', { blobs: [{ name, data: file }] }, OT_FFMPEG_IN_DIR);
      mounted = true;
    }
    const argv = _otFFArgs(args, inPath);
    if (!argv.includes('-hide_banner')) argv.unshift('-hide_banner');
    const rc = await ff.exec(argv, timeout);
    if (rc !== 0) {
      const err = new Error(`ffmpeg exited with code ${rc}`);
      err.code = rc; err.log = tail.slice();
      throw err;
    }
    if (!outName) return null;
    const data = await ff.readFile(outName);
    await ff.deleteFile(outName).catch(() => {});
    return new Blob([data], { type: outType || otFFmpegMime(outName) });
  } catch (e) {
    if (signal && signal.aborted) throw _otFFAbortError();
    if (ff !== _otFF || !ff.loaded) {          // terminated underneath us by another caller's abort
      const err = new Error('ffmpeg was terminated'); err.log = tail.slice(); err.terminated = true; throw err;
    }
    if (!(e instanceof Error)) e = new Error(String(e));   // the worker posts e.toString()
    if (!e.log) e.log = tail.slice();
    if (e.name !== 'AbortError' && OT_FFMPEG_TRAP_RE.test(e.message)) {
      e.trap = true;                           // the instance is unusable from here on
      _otFFTerminateAndReload();
    }
    throw e;
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    ff.off('log', logCb);
    ff.off('progress', progCb);
    if (mounted && ff === _otFF && ff.loaded) {   // after terminate() the FS is gone; nothing to unmount
      await ff.unmount(OT_FFMPEG_IN_DIR).catch(() => {});
      await ff.deleteDir(OT_FFMPEG_IN_DIR).catch(() => {});
      if (outName) await ff.deleteFile(outName).catch(() => {});   // leftover from a failed run
    }
  }
}

/* Lazy singleton. Resolves to the shared handle once the core is loaded; every
   caller that arrives during the first load gets the same load-progress events. */
function otFFmpeg({ onLoadProgress } = {}) {
  if (onLoadProgress) _otFFLoadCbs.add(onLoadProgress);
  return _otFFEnsureLoaded().then(() => {
    if (onLoadProgress) _otFFLoadCbs.delete(onLoadProgress);
    if (!_otFFHandle) {
      _otFFHandle = {
        version: { ...OT_FFMPEG_VER },
        /* Serialised: one ffmpeg process per page; concurrent calls wait their turn. */
        run: opts => {
          const job = _otFFQueue.then(() => _otFFRun(opts));
          _otFFQueue = job.catch(() => {});
          return job;
        },
        /* Kill whatever is running and reload; mostly for the probe page / tests. */
        reset: () => { _otFFTerminateAndReload(); return _otFFEnsureLoaded(); },
        get raw() { return _otFF; },
        get loaded() { return !!(_otFF && _otFF.loaded); },
      };
    }
    return _otFFHandle;
  }, err => {
    if (onLoadProgress) _otFFLoadCbs.delete(onLoadProgress);
    throw err;
  });
}

/* ---------- Page helpers shared by the two converters -------------------------
   Everything below is DOM-light and used by both tools/audio-converter and
   tools/video-converter. A helper only one page needs stays in that page; one
   both need lives here rather than as a second copy — and one common.js already
   has (escHtml, otFmtSize) is used from there, never re-declared. */

/* Sizes: common.js's otFmtSize() (GB-aware since 2026-09-18) — not re-declared here.
   seconds → "m:ss" / "h:mm:ss" */
function otFFFmtDur(s) {
  if (!Number.isFinite(s) || s < 0) return '?';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? h + ':' : '') + mm + ':' + String(sec).padStart(2, '0');
}
/* "90", "1:30", "0:01:30.5" → seconds; '' → null; garbage → NaN */
function otFFParseTime(str) {
  const t = String(str || '').trim();
  if (!t) return null;
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(t)) return NaN;
  const parts = t.split(':').map(Number);
  let s = 0;
  for (const p of parts) s = s * 60 + p;
  return s;
}
function otFFNoExt(n) { return String(n || '').replace(/\.[^.]+$/, ''); }
function otFFExtOf(n) { const m = String(n || '').match(/\.([^.]+)$/); return m ? m[1].toLowerCase() : ''; }

/* A download name that every OS accepts: the user's own base name minus any path,
   reserved / C0 / C1 control characters, invisible format characters (a U+202E bidi
   override makes "abc‮gpj.mp3" DISPLAY as "abc3pm.jpg" — the extension we append
   would read as a different one), trailing dots/spaces (Windows drops them), Windows
   device names (CON, NUL, COM1… — keyed on the part before the FIRST dot, so "con.tar"
   is reserved too), and capped in UTF-8 BYTES, not code points: Linux/macOS NAME_MAX
   is 255 bytes and 100 emoji are 400. 120 + "_converted" + " (20)" + ".aiff" = 140.
   The result goes into `a.download` and a zip entry name only — never into markup. */
const OT_FF_MAX_BASE_BYTES = 120;
function otFFSafeBase(name, fallback) {
  let b = otFFNoExt(String(name || '').replace(/^.*[\\/]/, ''))
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f-\x9f]+/g, '_')
    .replace(/(?!‍)\p{Cf}/gu, '')            // keep ZWJ: it glues emoji sequences
    .replace(/^[\s.]+|[\s.]+$/g, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(b)) b = b.replace(/^[^.]*/, m => m + '_');
  const enc = new TextEncoder();
  if (enc.encode(b).length > OT_FF_MAX_BASE_BYTES) {
    let out = '', n = 0;
    for (const c of b) {                            // by code point, so a surrogate pair is never split
      const l = enc.encode(c).length;
      if (n + l > OT_FF_MAX_BASE_BYTES) break;
      n += l; out += c;
    }
    b = out.replace(/[\s.]+$/, '');
  }
  return b || fallback || 'file';
}
function otFFDownload(blob, name) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 60000);
}
const otFFIsIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/* Demuxer name (as `ffmpeg -i` prints it) → a label a user recognises. */
const OT_FF_FORMAT_NAMES = {
  mov: 'MP4/MOV', matroska: 'MKV/WebM', mp3: 'MP3', wav: 'WAV', ogg: 'OGG', flac: 'FLAC', aiff: 'AIFF', asf: 'WMV/ASF',
  aac: 'AAC', ac3: 'AC3', eac3: 'E-AC3', mpegts: 'MPEG-TS', avi: 'AVI', flv: 'FLV', mpeg: 'MPEG', amr: 'AMR', wv: 'WavPack',
  ape: 'APE', caf: 'CAF', dts: 'DTS', mpegvideo: 'MPEG video', image2: 'image', png_pipe: 'PNG image', jpeg_pipe: 'JPEG image',
  gif: 'GIF', tty: 'text', m4v: 'M4V', mxf: 'MXF', rm: 'RealMedia', dv: 'DV', swf: 'SWF', nut: 'NUT', wtv: 'WTV',
  h264: 'raw H.264', hevc: 'raw HEVC', ivf: 'IVF', yuv4mpegpipe: 'Y4M',
};
function otFFFormatLabel(name) { return OT_FF_FORMAT_NAMES[name] || String(name || '').split(',')[0].toUpperCase(); }

/* Parses the stderr of `ffmpeg -i <file>` (no output → exit 1; the log IS the result).
   Returns { ok:false, reason } when ffmpeg recognised no container at all, else
   { ok:true, info } with:
     format    demuxer name (first alias)        duration  seconds, or null
     bitrate   container kbit/s, or 0
     audio     first audio stream  { index, codec, codecLong, profile, rate, channels, layout }, or null
     video     first REAL video stream { index, codec, codecLong, profile, width, height, fps, pixfmt }, or null
               (`codec` is the bare name — "h264", "aac" — as codec-tag tables key it;
               `codecLong` keeps the profile, "h264 (High)", for display)
               (an "attached pic" — cover art — is never the video stream)
   Whether a missing stream is a rejection is the PAGE's decision: the audio converter
   needs `audio`, the video converter needs `video`. */
function otFFParseProbe(lines) {
  const text = lines.join('\n');
  const input = text.match(/^Input #0, ([^,\n]+(?:,[^,\n]+)*), from /m);
  if (!input) {
    // ffmpeg usually says WHY — "moov atom not found" is a recording cut off before its
    // index was written (an interrupted phone transfer), the commonest case in the wild
    // and one the user can act on. Keep that line, minus our own input name.
    const hits = lines.filter(l => /moov atom|Invalid data|Unknown format|not found|Error|Invalid/i.test(l) && !/^\s*Stream|^Input/.test(l));
    // The generic "Invalid data found when processing input" always comes LAST; the line
    // before it is the specific one, when there is one.
    const why = hits.filter(l => !/Invalid data found when processing input/.test(l)).pop() || hits.pop();
    const words = why && why.replace(/^\[[^\]]*\]\s*/, '').replace(/^\S+: /, '').trim();   // drop "[mov,mp4… @ 0x…] " and "src: "
    return { ok: false, reason: 'Not a recognised audio or video file' + (words ? ' (' + words + ')' : '') };
  }
  const info = { format: input[1].split(',')[0].trim(), duration: null, bitrate: 0, audio: null, video: null };
  const dur = text.match(/^\s*Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/m);
  if (dur) info.duration = (+dur[1]) * 3600 + (+dur[2]) * 60 + (+dur[3]);
  const br = text.match(/bitrate: (\d+) kb\/s/);
  if (br) info.bitrate = +br[1];
  for (const line of lines) {
    const st = line.match(/Stream #0:(\d+)(?:\[[^\]]*\])?(?:\([^)]*\))?: (Video|Audio): (.+)$/);
    if (!st) continue;
    const index = +st[1], desc = st[3];
    const parts = desc.split(', ');
    // "h264 (High) (avc1 / 0x31637661)" → codec "h264" (what a codec-tag table is keyed on),
    // profile "High"; the codec-tag "(mp4a / 0x…)" is dropped. `codecLong` keeps the
    // codec + profile for display.
    const noTag = parts[0].replace(/\s*\([^()]* \/ 0x[0-9a-fA-F]+\)/g, '').trim();
    const codec = noTag.split(/\s+/)[0].toLowerCase();
    const profile = (noTag.match(/\(([^()]*)\)/) || [])[1] || '';
    if (st[2] === 'Video') {
      if (info.video || /attached pic/.test(line)) continue;
      const dim = desc.match(/(\d{2,5})x(\d{2,5})/);
      const fps = desc.match(/([\d.]+) fps/) || desc.match(/([\d.]+) tbr/);
      const pf = (parts[1] || '').replace(/\(.*$/, '').trim();
      info.video = { index, codec, codecLong: noTag, profile, width: dim ? +dim[1] : 0, height: dim ? +dim[2] : 0,
                     fps: fps ? parseFloat(fps[1]) : 0, pixfmt: /^[a-z0-9]+$/.test(pf) ? pf : '' };
    } else {
      if (info.audio) continue;
      const hz = desc.match(/(\d+) Hz/);
      const lay = parts[2] || '';
      const layout = lay.replace(/\(.*\)$/, '').trim();
      const m = lay.match(/^(\d+) channels?/);
      const channels = m ? +m[1]
        : /^mono/.test(lay) ? 1 : /^stereo/.test(lay) ? 2 : /^quad/.test(lay) ? 4
        : /^5\.1/.test(lay) ? 6 : /^7\.1/.test(lay) ? 8 : /^5\.0/.test(lay) ? 5 : /^6\.1/.test(lay) ? 7
        : /^(downmix|2\.1)/.test(lay) ? 2 : 0;
      info.audio = { index, codec, codecLong: noTag, profile, rate: hz ? +hz[1] : 0, channels, layout };
    }
  }
  return { ok: true, info };
}

/* Sniff a file: `ffmpeg -i` on a name with NO extension, so the demuxer is chosen by
   content alone (ffmpeg scores the extension as a hint otherwise). ffmpeg exits 1 when
   no output is given — that is the expected path. Resolves to otFFParseProbe()'s
   result; rejects on abort or on a real engine failure. */
async function otFFProbe(ff, file, signal) {
  const lines = [];
  const capture = ({ message }) => { if (lines.length < 600) lines.push(message); };
  const src = new File([file], 'src');       // copy-free re-wrap: File parts reference the original bytes
  try {
    await ff.run({ file: src, args: ['-i', '{input}'], onLog: capture, signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    if (e && e.code !== 1 && !lines.some(l => /^Input #0/.test(l))) throw e;   // a real failure, not the "no output" exit
  }
  return otFFParseProbe(lines);
}

/* The engine panel + lazy load, identical on both pages: one panel (title, sub, bar) that
   narrates the ~31 MB first download, says "ready", then hides itself. `els` =
   { panel, title, sub, bar } (DOM nodes). Returns:
     ensure()  → Promise<handle>; rejects with `err.engine = true` so an item handler can
                 tell "the engine did not load" (nothing wrong with the file — keep it
                 retryable) from "this file is bad". Concurrent callers share one load.
     show(title, sub, ratio, isErr)   ratio null = indeterminate bar
     handle    the resolved otFFmpeg() handle, or null until ensure() has succeeded */
function otFFEnginePanel(els) {
  let handle = null, loading = null;
  const DL = 'One-time download — your browser caches it for next time. Nothing about your files is sent anywhere.';
  function show(title, sub, ratio, isErr) {
    els.panel.hidden = false;
    els.panel.classList.toggle('is-error', !!isErr);
    els.title.textContent = title;
    els.sub.textContent = sub || '';
    els.bar.classList.toggle('indet', ratio == null);
    els.bar.style.width = ratio == null ? '' : Math.round(ratio * 100) + '%';
  }
  function ensure() {
    if (handle) return Promise.resolve(handle);
    if (loading) return loading;
    show('Downloading the converter engine (ffmpeg.wasm, ≈31 MB)…', DL, null);
    loading = otFFmpeg({
      onLoadProgress: e => {
        const r = e.allExpected ? e.allReceived / e.allExpected : null;
        show(`Downloading the converter engine… ${otFmtSize(e.allReceived)} of ≈${otFmtSize(e.allExpected)}`, DL, r);
      },
    }).then(h => {
      handle = h;
      show('Converter engine ready ✓', `ffmpeg.wasm ${h.version.core} loaded — runs entirely in this tab.`, 1);
      setTimeout(() => { if (handle) els.panel.hidden = true; }, 2500);
      return h;
    }).catch(err => {
      loading = null;
      const msg = (err && err.message) || String(err);
      show('Could not load the converter engine', msg + ' — check your connection and use ↻ Retry on a file.', 0, true);
      const e = err instanceof Error ? err : new Error(msg);
      e.engine = true;
      throw e;
    });
    return loading;
  }
  return { ensure, show, get handle() { return handle; } };
}

/* The page-level notice box (`.notice.warn` / `.notice.err`): a title plus an optional
   list, every string escaped. `loopFailed(what)` is the catch for the fire-and-forget probe
   and convert loops — if one ever escapes its per-item try (a render bug, not a file
   problem) the user must still see words, not a stuck "Identifying…" row. */
function otFFNotice(el) {
  const box = {
    show(kind, title, list) {
      el.hidden = false;
      el.className = 'notice ' + kind;
      el.innerHTML = `<strong>${escHtml(title)}</strong>` +
        (list && list.length ? '<ul>' + list.map(s => `<li>${escHtml(s)}</li>`).join('') + '</ul>' : '');
    },
    hide() { el.hidden = true; el.innerHTML = ''; },
    loopFailed: what => err => box.show('err', `${what} stopped unexpectedly: ` + ((err && err.message) || err) + ' — reload the page if it stays stuck.'),
  };
  return box;
}

/* Words for a failed run(). `e.trap` = the wasm died and the loader restarted it;
   `e.terminated` = another caller's abort killed this worker (the file is fine);
   `e.engine` = the page's own marker for an engine-load failure; else ffmpeg's last
   relevant stderr lines. Returns { cancelled:true } for an abort, else { text }. */
function otFFErrorText(e, { probing = false } = {}) {
  if (e && e.name === 'AbortError') return { cancelled: true, text: '' };
  const msg = (e && e.message) || String(e);
  let text;
  if (e && e.trap) {
    text = probing ? 'The converter crashed while identifying this file (' + msg + '). The engine has been restarted — use ↻ Retry.'
                   : 'The converter crashed on this file (' + msg + '). The engine has been restarted — retry, or try another format or preset.';
  } else if (e && e.terminated) {
    text = probing ? 'The converter was restarted while identifying this file. Use ↻ Retry.'
                   : 'The converter was restarted while this file was running (another file was cancelled or removed). Nothing is wrong with the file — use ↻ Retry.';
  } else if (e && e.engine) {
    text = probing ? 'The converter engine could not be loaded, so this file was not checked: ' + msg + '. Use ↻ Retry once you are back online.'
                   : 'The converter engine could not be loaded: ' + msg + '. Check your connection and use ↻ Retry.';
  } else if (probing) {
    text = 'Could not read this file: ' + msg;
  } else {
    const log = (e && e.log || []).map(l => l.replace(/^std(err|out): /, ''));
    let tail = log.filter(l => /error|invalid|not supported|unsupported|failed|could not|cannot|no such/i.test(l)).slice(-3);
    if (!tail.length) tail = log.filter(l => l.trim()).slice(-2);   // no keyword hit: the last lines are still the best clue
    text = msg + (tail.length ? '\n' + tail.join('\n') : '');
  }
  return { cancelled: false, text };
}

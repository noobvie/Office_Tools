/*
 * File Drop — streaming-download service worker.
 *
 * The page pipes incoming WebRTC chunks here over a MessageChannel; this worker
 * answers a virtual URL (./dl/<id>) with a ReadableStream Response, so the file
 * flows straight through the browser's normal download machinery to disk instead
 * of accumulating in tab memory. Nothing is uploaded anywhere — the virtual URL
 * never reaches the network (and 404s harmlessly if this worker is not running,
 * in which case the page falls back to an in-memory Blob download).
 *
 * Flow control: each chunk is acked either immediately (queue has room) or from
 * pull() once the download consumer drains, so a slow disk backpressures the
 * page (which in turn stops reading the DataChannel).
 */
'use strict';

const streams = new Map(); // id → { readable, name, size }

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('message', e => {
  const d = e.data || {};
  if (d.type !== 'stream' || !e.ports[0]) return;

  const port = e.ports[0];
  let controller = null;
  let pendingAcks = 0;
  const readable = new ReadableStream({
    start(c) { controller = c; },
    pull() {
      if (pendingAcks > 0) { pendingAcks--; try { port.postMessage({ type: 'ack' }); } catch {} }
    },
    cancel() { try { port.postMessage({ type: 'cancel' }); } catch {} }
  }, new CountQueuingStrategy({ highWaterMark: 64 }));

  port.onmessage = ev => {
    const m = ev.data || {};
    try {
      if (m.type === 'chunk') {
        controller.enqueue(new Uint8Array(m.buf));
        if (controller.desiredSize > 0) port.postMessage({ type: 'ack' });
        else pendingAcks++;
      } else if (m.type === 'end') {
        controller.close(); port.onmessage = null;
      } else if (m.type === 'abort') {
        controller.error(new Error('transfer aborted')); port.onmessage = null;
      }
    } catch { /* stream already errored/cancelled */ }
  };

  streams.set(String(d.id), { readable, name: String(d.name || 'download'), size: Number(d.size) || 0 });
  // Unclaimed stream (download never navigated) — drop after 2 min so it can't leak
  setTimeout(() => streams.delete(String(d.id)), 120_000);
  port.postMessage({ type: 'ready' });
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  const m = url.pathname.match(/\/dl\/([A-Za-z0-9_-]+)$/);
  if (!m || !streams.has(m[1])) return; // fall through to network

  const s = streams.get(m[1]);
  streams.delete(m[1]);

  // RFC 5987 filename* so unicode names survive; ASCII-sanitized plain filename as fallback
  const ascii = s.name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(s.name)}`,
    'X-Content-Type-Options': 'nosniff'
  };
  if (s.size > 0) headers['Content-Length'] = String(s.size);

  e.respondWith(new Response(s.readable, { headers }));
});

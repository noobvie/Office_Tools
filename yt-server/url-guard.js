'use strict';

// Which URLs this server will hand to yt-dlp. yt-dlp fetches ANY URL it is given (its
// generic extractor downloads the page), so this allowlist is the SSRF guard: a URL that
// passes it can make this box fetch that host.
//
// Three rules, all load-bearing:
// - The host must EQUAL an allowed host or end in "." + one. A bare endsWith('youtube.com')
//   also admits evilyoutube.com, which anyone can register and point at 127.0.0.1.
// - yt-dlp must get `href`, rebuilt from the checked video id, never the raw input.
//   WHATWG and Python's urllib disagree on odd input: for 'https://youtube.com\@evil.example/'
//   WHATWG says the host is youtube.com and urllib says evil.example.
// - Only a SINGLE video is accepted. Playlist, channel, search and feed URLs would make
//   yt-dlp walk many videos with the server's (burner-account) cookies. The page lists a
//   playlist itself through the YouTube Data API and requests its videos one at a time,
//   so the server never needs a playlist URL. `list=`, `t=` and every other parameter
//   are dropped by the rebuild.

const ALLOWED_HOSTS = ['youtube.com', 'youtu.be'];   // subdomains pass the host check
const VIDEO_HOSTS   = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
const VIDEO_ID_RE   = /^[A-Za-z0-9_-]{11}$/;
const ID_PATH_RE    = /^\/(?:shorts|live|embed|v)\/([^/]*)\/?$/;

// The id a video URL names: a string (possibly malformed — the caller checks it), or
// undefined when the URL is not a single-video form at all.
function videoIdFrom(host, u) {
  if (host === 'youtu.be') {
    const m = /^\/([^/]*)\/?$/.exec(u.pathname);
    return m ? m[1] : undefined;
  }
  if (!VIDEO_HOSTS.has(host)) return undefined;
  if (u.pathname === '/watch' || u.pathname === '/watch/') return u.searchParams.get('v') || '';
  const m = ID_PATH_RE.exec(u.pathname);
  return m ? m[1] : undefined;
}

// → { href } when allowed, else { error: 'invalid_url' | 'unsupported_host' | 'unsupported_url' }.
// href is always https://www.youtube.com/watch?v=<id>.
function checkVideoUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'invalid_url' };
  let u;
  try { u = new URL(raw.trim()); } catch { return { error: 'invalid_url' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'invalid_url' };
  if (u.username || u.password || u.port) return { error: 'unsupported_host' };
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!ALLOWED_HOSTS.some(h => host === h || host.endsWith('.' + h))) return { error: 'unsupported_host' };
  const id = videoIdFrom(host, u);
  if (id === undefined) return { error: 'unsupported_url' };
  if (!VIDEO_ID_RE.test(id)) return { error: 'invalid_url' };
  return { href: `https://www.youtube.com/watch?v=${id}` };
}

module.exports = { checkVideoUrl, ALLOWED_HOSTS, VIDEO_ID_RE };

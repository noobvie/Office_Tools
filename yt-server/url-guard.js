'use strict';

// Which URLs this server will hand to yt-dlp. yt-dlp fetches ANY URL it is given (its
// generic extractor downloads the page), so this allowlist is the SSRF guard: a URL that
// passes it can make this box fetch that host.
//
// Two rules, both load-bearing (R1, 2026-10-10):
// - The host must EQUAL an allowed host or end in "." + one. A bare endsWith('youtube.com')
//   also admits evilyoutube.com, which anyone can register and point at 127.0.0.1.
// - yt-dlp must get `href`, the canonical form of what was CHECKED, never the raw input.
//   WHATWG and Python's urllib disagree on odd input: for 'https://youtube.com\@evil.example/'
//   WHATWG says the host is youtube.com and urllib says evil.example.

const ALLOWED_HOSTS = ['youtube.com', 'youtu.be'];   // subdomains (www., m., music.) included

// → { href } when allowed, else { error: 'invalid_url' | 'unsupported_host' }.
function checkVideoUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'invalid_url' };
  let u;
  try { u = new URL(raw.trim()); } catch { return { error: 'invalid_url' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'invalid_url' };
  if (u.username || u.password || u.port) return { error: 'unsupported_host' };
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!ALLOWED_HOSTS.some(h => host === h || host.endsWith('.' + h))) return { error: 'unsupported_host' };
  return { href: u.href };
}

module.exports = { checkVideoUrl, ALLOWED_HOSTS };

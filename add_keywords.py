import re

KEYWORDS = {
  'aspect-ratio':        'aspect ratio calculator, image aspect ratio, 16:9 ratio, resize calculator, video resolution',
  'base-converter':      'binary converter, hex converter, decimal to binary, hexadecimal, octal, number base conversion',
  'base64-converter':    'Base64 encoder decoder, encode decode Base64 online, Base64 file converter',
  'calendar':            'world calendar, chinese lunar calendar, islamic hijri calendar, gregorian, lunar calendar',
  'char-map':            'character map, special characters, copy symbols, unicode, arrow math symbols, emoji picker',
  'color-converter':     'color converter, HEX to RGB, RGB to HSL, CMYK, CSS color, color picker, color format',
  'contrast-checker':    'WCAG contrast checker, color contrast ratio, accessibility, AA AAA compliance, a11y, web design',
  'crontab':             'crontab explainer, cron expression parser, cron to English, cron schedule, linux scheduler, automation',
  'csr-decoder':         'CSR decoder, certificate signing request, SSL TLS certificate, PEM decoder, X.509, SAN, openssl',
  'csv-json':            'CSV to JSON, JSON to CSV, CSV JSON converter, parse CSV, spreadsheet to JSON, data format',
  'currency':            'currency converter, crypto, live exchange rate, forex, USD EUR GBP, bitcoin BTC ETH XMR, grin, cryptocurrency',
  'date-calculator':     'date calculator, date difference, age calculator, days between dates, countdown, add days, date math',
  'fake-data':           'fake data generator, test data, random name, mock data, dummy data, fake email, sample CSV JSON',
  'file-compressor':     'zip files online, extract zip browser, compress zip, online zip tool, zip extractor, zip archive',
  'file-share':          'file sharing, share ZIP, upload share file, temporary file hosting, file share link, private transfer',
  'hash-generator':      'hash generator, SHA-256 SHA-512 SHA-384, HMAC, file hash checksum, md5 sha1 cryptographic, integrity verify',
  'html-entities':       'HTML entity encoder decoder, HTML encode decode escape, ampersand encoder, special characters, web developer',
  'image-converter':     'image converter, HEIC to JPG, HEIF to PNG, compress image, resize image, convert WebP, photo format',
  'ip-location':         'IP location lookup, IP geolocation, IP address, domain lookup, VPN detection, IP to country, trace IP, ASN',
  'json-editor':         'JSON editor online, JSON formatter validator, JSON beautifier minifier, pretty print, JSON lint, JSON viewer',
  'jwt-decoder':         'JWT decoder, JSON web token, decode JWT online, JWT payload header, JWT expiry claims, auth token inspect',
  'loan-calculator':     'loan calculator, mortgage calculator, monthly payment, amortization schedule, interest calculator, EMI',
  'lorem-ipsum':         'lorem ipsum generator, placeholder dummy text, lipsum, fake text paragraphs sentences words',
  'markdown-editor':     'markdown editor online, live markdown preview, markdown to HTML, GFM editor, markdown renderer',
  'my-ip':               'what is my IP address, find my IP, check my IP, public IP lookup, IPv4 IPv6, ISP lookup, my IP right now',
  'notepad':             'online notepad, browser notepad, auto-save, scratch pad, quick notes, local storage notes',
  'number-words':        'number to words, spell out number, number in english words, check writing, invoice amount in words',
  'palette-extractor':   'color palette extractor, image color picker, dominant colors, extract palette from photo, HEX from image',
  'password-generator':  'password generator, secure random password, strong password maker, memorable passphrase, special characters',
  'pastebin':            'pastebin, code sharing, share code online, syntax highlight paste, private paste, burn after read',
  'pdf-to-text':         'PDF to text, extract text from PDF, PDF to Word, PDF text extractor, PDF to TXT, convert PDF, read PDF text',
  'pdf-toolkit':         'PDF merger, merge PDF, split PDF, extract PDF pages, reorder pages, compress PDF, reduce file size, combine PDF',
  'percentage-calculator': 'percentage calculator, percent of number, percentage change increase decrease, calculate percentage online',
  'photo-editor':        'remove background free, background remover AI, add text to photo, resize passport social media image, recolor crop',
  'pomodoro':            'pomodoro timer, focus timer, productivity, 25 minute timer, work break, study timer, pomodoro technique',
  'qr-generator':        'qr code generator, barcode generator, qr with logo, wifi qr code, vcard qr, EAN-13 code128 UPC barcode, scan me',
  'random-number':       'random number generator, random integer decimal, bulk random, no duplicates, dice roller, number randomizer',
  'regex-tester':        'regex tester, regular expression, online regex, regex debugger, match highlight, capture groups, flags',
  'screenshot-beautifier': 'screenshot beautifier, screenshot editor, screenshot background gradient, professional screenshot, screen capture',
  'speech-voice':        'speech to text, voice to text, text to speech, transcribe audio, whisper AI, microphone transcription, TTS STT',
  'sql-formatter':       'SQL formatter beautifier, format SQL online, SQL pretty print, SQL minifier, SQL indentation, query formatter',
  'text-case':           'text case converter, uppercase lowercase, camelCase snake_case kebab-case PascalCase, title case, transform',
  'text-diff':           'text diff, compare text online, diff checker, text comparison, code diff, document compare, diff viewer',
  'timer':               'stopwatch online, countdown timer, lap timer, web stopwatch, milliseconds, alarm, interval timer',
  'timezone':            'time zone converter, world clock, meeting planner, UTC GMT offset, time difference, remote teams',
  'tip-calculator':      'tip calculator, split bill, restaurant tip, bill splitter, gratuity, tip percentage, how much to tip per person',
  'typing-speed':        'typing speed test, WPM, words per minute, typing accuracy, keyboard speed test, touch typing, free typing test',
  'unit-converter':      'unit converter, length weight temperature volume, metric imperial, km miles, kg lbs, celsius fahrenheit',
  'unix-timestamp':      'unix timestamp, epoch converter, timestamp to date, date to unix, epoch time, current unix time',
  'url-encoder':         'URL encoder decoder, percent encode URL, URL encoding, decode URL, percent encoding, URL escape unescape',
  'url-shortener':       'URL shortener, short link, custom URL, link shortener, shorten URL, self-hosted, tiny url alias',
  'utm-builder':         'UTM builder, UTM parameters, Google Analytics campaign URL, UTM generator, campaign tracking',
  'uuid-generator':      'UUID generator, GUID generator, UUID v4 v7, random UUID, bulk UUID, unique ID, GUID online',
  'wheel-of-names':      'wheel of names, random name picker, spinning wheel, winner picker, random selector, raffle giveaway',
  'word-counter':        'word counter, character counter, word count online, reading time, keyword density, sentence counter',
  'yt-downloader':       'youtube downloader, youtube to mp3 mp4, download youtube video, youtube converter, save video, playlist',
}

path = 'c:/Users/LenovoTiny/OneDrive/Git_noobvie/Office_Tools/index.html'
with open(path, 'r', encoding='utf-8') as f:
    html = f.read()

def add_kw(m):
    full = m.group(0)
    href = m.group(1)
    sm   = re.search(r'tools/([^/]+)/index\.html', href)
    if not sm: return full
    slug = sm.group(1)
    kw   = KEYWORDS.get(slug)
    if not kw or 'data-keywords=' in full: return full
    return full.replace(' class="tool-card"', ' class="tool-card" data-keywords="' + kw + '"')

new_html = re.sub(r'<a (href="tools/[^"]+/index\.html"[^>]*)>', add_kw, html)
with open(path, 'w', encoding='utf-8') as f:
    f.write(new_html)
print("Done. Updated:", new_html.count('data-keywords='), "cards")

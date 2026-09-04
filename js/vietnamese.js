/* Vietnamese text repair — shared helper.
 *
 * Loaded by the tools that produce Vietnamese text out of something that was
 * never Unicode to begin with: PDF to Text (pdf.js text layer) and OCR.
 *
 * ── The distinction this file exists to keep straight ────────────────────────
 * "Telex" and "VNI" are two different KINDS of thing and people use both words
 * for both, which is why a converter that treats them as one setting gets the
 * wrong answer:
 *
 *   INPUT METHODS  — how a human types. Telex ("tieengs" → "tiếng"), VNI-number
 *                    ("tie61ng"), VIQR ("tie^'ng"). Plain ASCII on the way in.
 *   FONT ENCODINGS — how bytes were stored before Unicode. TCVN3/ABC (.VnTime),
 *                    VNI-Windows (VNI-Times), VISCII. NOT ASCII, and NOT valid
 *                    text in any other charset either.
 *
 * A garbled PDF is essentially always the second kind. The document was typed
 * in a legacy font, the PDF embedded that font, and the extracted characters
 * are the font's byte values read as Latin-1 — so "Tiếng Việt" comes out as
 * "TiÕng ViÖt" (TCVN3) or "Tieáng Vieät" (VNI-Windows). Those are handled by
 * decode() and can be auto-detected, because the byte patterns are unmistakable.
 *
 * The input methods are handled too (telexToUnicode / decode(…,'viqr')) but are
 * MANUAL-ONLY on purpose: their source text is ordinary ASCII, so there is no
 * signature to detect, and running them over English destroys it — VIQR turns
 * "sudden" into "suđen", Telex turns "see" into "sê". detect() will never
 * return one.
 *
 * ── Where the tables come from ───────────────────────────────────────────────
 * Generated, not hand-typed, from two independent sources that were diffed
 * against each other first (74 shared TCVN3 single-char entries, 0 conflicts):
 *   • iconv-lite  encodings/sbcs-data-generated.js → `tcvn` (TCVN 5712 VN3,
 *     which adds the precomposed uppercase block the font tables lack) `viscii`
 *   • anhskohbo/u-convert  src/UConvert.php → parallel UNICODE/VNI/TCVN3/VIQR
 *     arrays, 134 entries each (MIT)
 * Regenerate with scripts/gen-vietnamese-tables.js rather than editing inline.
 *
 * Everything here is pure — no DOM, no network. Exposed as window.OTVietnamese.
 */
(function (global) {
  'use strict';

  // Each entry is a flat [from, to, from, to, …] list, already sorted
  // LONGEST-FIRST so a digraph is matched before its own single-char tail:
  // TCVN3 "¢Ê" is "Ấ", but "Ê" alone is "ấ", and matching the short one first
  // would silently turn every uppercase Ấ into "Âấ".
  var TABLES = {
    tcvn3: ["Aµ","À", "A¸","Á", "A·","Ã", "EÌ","È", "EÐ","É", "I×","Ì", "IÝ","Í", "Oß","Ò", "Oã","Ó", "Oâ","Õ", "Uï","Ù", "Uó","Ú", "Yý","Ý", "IÜ","Ĩ", "Uò","Ũ", "A¹","Ạ", "A¶","Ả", "¢Ê","Ấ", "¢Ç","Ầ", "¢È","Ẩ", "¢É","Ẫ", "¢Ë","Ậ", "¡¾","Ắ", "¡»","Ằ", "¡¼","Ẳ", "¡½","Ẵ", "¡Æ","Ặ", "EÑ","Ẹ", "EÎ","Ẻ", "EÏ","Ẽ", "£Õ","Ế", "£Ò","Ề", "£Ó","Ể", "£Ô","Ễ", "£Ö","Ệ", "IØ","Ỉ", "IÞ","Ị", "Oä","Ọ", "Oá","Ỏ", "¤è","Ố", "¤å","Ồ", "¤æ","Ổ", "¤ç","Ỗ", "¤é","Ộ", "¥í","Ớ", "¥ê","Ờ", "¥ë","Ở", "¥ì","Ỡ", "¥î","Ợ", "Uô","Ụ", "Uñ","Ủ", "¦ø","Ứ", "¦õ","Ừ", "¦ö","Ử", "¦÷","Ữ", "¦ù","Ự", "Yú","Ỳ", "Yþ","Ỵ", "Yû","Ỷ", "Yü","Ỹ", "¢","Â", "£","Ê", "¤","Ô", "µ","à", "¸","á", "©","â", "·","ã", "Ì","è", "Ð","é", "ª","ê", "×","ì", "Ý","í", "ß","ò", "ã","ó", "«","ô", "â","õ", "ï","ù", "ó","ú", "ý","ý", "¡","Ă", "¨","ă", "§","Đ", "®","đ", "Ü","ĩ", "ò","ũ", "¥","Ơ", "¬","ơ", "¦","Ư", "­","ư", "¹","ạ", "¶","ả", "Ê","ấ", "Ç","ầ", "È","ẩ", "É","ẫ", "Ë","ậ", "¾","ắ", "»","ằ", "¼","ẳ", "½","ẵ", "Æ","ặ", "Ñ","ẹ", "Î","ẻ", "Ï","ẽ", "Õ","ế", "Ò","ề", "Ó","ể", "Ô","ễ", "Ö","ệ", "Ø","ỉ", "Þ","ị", "ä","ọ", "á","ỏ", "è","ố", "å","ồ", "æ","ổ", "ç","ỗ", "é","ộ", "í","ớ", "ê","ờ", "ë","ở", "ì","ỡ", "î","ợ", "ô","ụ", "ñ","ủ", "ø","ứ", "õ","ừ", "ö","ử", "÷","ữ", "ù","ự", "ú","ỳ", "þ","ỵ", "û","ỷ", "ü","ỹ", "\u0080","À", "\u0081","Ả", "\u0082","Ã", "\u0083","Á", "\u0084","Ạ", "\u0085","Ặ", "\u0086","Ậ", "\u0087","È", "\u0088","Ẻ", "\u0089","Ẽ", "\u008a","É", "\u008b","Ẹ", "\u008c","Ệ", "\u008d","Ì", "\u008e","Ỉ", "\u008f","Ĩ", "\u0090","Í", "\u0091","Ị", "\u0092","Ò", "\u0093","Ỏ", "\u0094","Õ", "\u0095","Ó", "\u0096","Ọ", "\u0097","Ộ", "\u0098","Ờ", "\u0099","Ở", "\u009a","Ỡ", "\u009b","Ớ", "\u009c","Ợ", "\u009d","Ù", "\u009e","Ủ", "\u009f","Ũ", "¯","Ằ", "°","̀", "±","̉", "²","̃", "³","́", "´","̣", "º","Ẳ", "¿","Ẵ", "À","Ắ", "Á","Ầ", "Â","Ẩ", "Ã","Ẫ", "Ä","Ấ", "Å","Ề", "Í","Ể", "Ù","Ễ", "Ú","Ế", "Û","Ồ", "à","Ổ", "ð","Ỗ", "ÿ","Ố"],
    vni: ["AØ","À", "AÙ","Á", "AÂ","Â", "AÕ","Ã", "EØ","È", "EÙ","É", "EÂ","Ê", "OØ","Ò", "OÙ","Ó", "OÂ","Ô", "OÕ","Õ", "UØ","Ù", "UÙ","Ú", "YÙ","Ý", "aø","à", "aù","á", "aâ","â", "aõ","ã", "eø","è", "eù","é", "eâ","ê", "oø","ò", "où","ó", "oâ","ô", "oõ","õ", "uø","ù", "uù","ú", "yù","ý", "AÊ","Ă", "aê","ă", "UÕ","Ũ", "uõ","ũ", "AÏ","Ạ", "aï","ạ", "AÛ","Ả", "aû","ả", "AÁ","Ấ", "aá","ấ", "AÀ","Ầ", "aà","ầ", "AÅ","Ẩ", "aå","ẩ", "AÃ","Ẫ", "aã","ẫ", "AÄ","Ậ", "aä","ậ", "AÉ","Ắ", "aé","ắ", "AÈ","Ằ", "aè","ằ", "AÚ","Ẳ", "aú","ẳ", "AÜ","Ẵ", "aü","ẵ", "AË","Ặ", "aë","ặ", "EÏ","Ẹ", "eï","ẹ", "EÛ","Ẻ", "eû","ẻ", "EÕ","Ẽ", "eõ","ẽ", "EÁ","Ế", "eá","ế", "EÀ","Ề", "eà","ề", "EÅ","Ể", "eå","ể", "EÃ","Ễ", "eã","ễ", "EÄ","Ệ", "eä","ệ", "OÏ","Ọ", "oï","ọ", "OÛ","Ỏ", "oû","ỏ", "OÁ","Ố", "oá","ố", "OÀ","Ồ", "oà","ồ", "OÅ","Ổ", "oå","ổ", "OÃ","Ỗ", "oã","ỗ", "OÄ","Ộ", "oä","ộ", "ÔÙ","Ớ", "ôù","ớ", "ÔØ","Ờ", "ôø","ờ", "ÔÛ","Ở", "ôû","ở", "ÔÕ","Ỡ", "ôõ","ỡ", "ÔÏ","Ợ", "ôï","ợ", "UÏ","Ụ", "uï","ụ", "UÛ","Ủ", "uû","ủ", "ÖÙ","Ứ", "öù","ứ", "ÖØ","Ừ", "öø","ừ", "ÖÛ","Ử", "öû","ử", "ÖÕ","Ữ", "öõ","ữ", "ÖÏ","Ự", "öï","ự", "YØ","Ỳ", "yø","ỳ", "YÛ","Ỷ", "yû","ỷ", "YÕ","Ỹ", "yõ","ỹ", "Ñ","Đ", "ñ","đ", "Ó","Ĩ", "ó","ĩ", "Ô","Ơ", "ô","ơ", "Ö","Ư", "ö","ư", "Æ","Ỉ", "æ","ỉ", "Ò","Ị", "ò","ị", "Î","Ỵ", "î","ỵ"],
    viscii: ["\u0002","Ẳ", "\u0005","Ẵ", "\u0006","Ẫ", "\u0014","Ỷ", "\u0019","Ỹ", "\u001e","Ỵ", "\u0080","Ạ", "\u0081","Ắ", "\u0082","Ằ", "\u0083","Ặ", "\u0084","Ấ", "\u0085","Ầ", "\u0086","Ẩ", "\u0087","Ậ", "\u0088","Ẽ", "\u0089","Ẹ", "\u008a","Ế", "\u008b","Ề", "\u008c","Ể", "\u008d","Ễ", "\u008e","Ệ", "\u008f","Ố", "\u0090","Ồ", "\u0091","Ổ", "\u0092","Ỗ", "\u0093","Ộ", "\u0094","Ợ", "\u0095","Ớ", "\u0096","Ờ", "\u0097","Ở", "\u0098","Ị", "\u0099","Ỏ", "\u009a","Ọ", "\u009b","Ỉ", "\u009c","Ủ", "\u009d","Ũ", "\u009e","Ụ", "\u009f","Ỳ", "\u00a0","Õ", "¡","ắ", "¢","ằ", "£","ặ", "¤","ấ", "¥","ầ", "¦","ẩ", "§","ậ", "¨","ẽ", "©","ẹ", "ª","ế", "«","ề", "¬","ể", "­","ễ", "®","ệ", "¯","ố", "°","ồ", "±","ổ", "²","ỗ", "³","Ỡ", "´","Ơ", "µ","ộ", "¶","ờ", "·","ở", "¸","ị", "¹","Ự", "º","Ứ", "»","Ừ", "¼","Ử", "½","ơ", "¾","ớ", "¿","Ư", "Ä","Ả", "Å","Ă", "Æ","ẳ", "Ç","ẵ", "Ë","Ẻ", "Î","Ĩ", "Ï","ỳ", "Ð","Đ", "Ñ","ứ", "Õ","ạ", "Ö","ỷ", "×","ừ", "Ø","ử", "Û","ỹ", "Ü","ỵ", "Þ","ỡ", "ß","ư", "ä","ả", "å","ă", "æ","ữ", "ç","ẫ", "ë","ẻ", "î","ĩ", "ï","ỉ", "ð","đ", "ñ","ự", "ö","ỏ", "÷","ọ", "ø","ụ", "û","ũ", "ü","ủ", "þ","ợ", "ÿ","Ữ"],
    viqr: ["A^'","Ấ", "a^'","ấ", "A^`","Ầ", "a^`","ầ", "A^?","Ẩ", "a^?","ẩ", "A^~","Ẫ", "a^~","ẫ", "A^.","Ậ", "a^.","ậ", "A('","Ắ", "a('","ắ", "A(`","Ằ", "a(`","ằ", "A(?","Ẳ", "a(?","ẳ", "A(~","Ẵ", "a(~","ẵ", "A(.","Ặ", "a(.","ặ", "E^'","Ế", "e^'","ế", "E^`","Ề", "e^`","ề", "E^?","Ể", "e^?","ể", "E^~","Ễ", "e^~","ễ", "E^.","Ệ", "e^.","ệ", "O^'","Ố", "o^'","ố", "O^`","Ồ", "o^`","ồ", "O^?","Ổ", "o^?","ổ", "O^~","Ỗ", "o^~","ỗ", "O^.","Ộ", "o^.","ộ", "O+'","Ớ", "o+'","ớ", "O+`","Ờ", "o+`","ờ", "O+?","Ở", "o+?","ở", "O+~","Ỡ", "o+~","ỡ", "O+.","Ợ", "o+.","ợ", "U+'","Ứ", "u+'","ứ", "U+`","Ừ", "u+`","ừ", "U+?","Ử", "u+?","ử", "U+~","Ữ", "u+~","ữ", "U+.","Ự", "u+.","ự", "A`","À", "A'","Á", "A^","Â", "A~","Ã", "E`","È", "E'","É", "E^","Ê", "I`","Ì", "I'","Í", "O`","Ò", "O'","Ó", "O^","Ô", "O~","Õ", "U`","Ù", "U'","Ú", "Y'","Ý", "a`","à", "a'","á", "a^","â", "a~","ã", "e`","è", "e'","é", "e^","ê", "i`","ì", "i'","í", "o`","ò", "o'","ó", "o^","ô", "o~","õ", "u`","ù", "u'","ú", "y'","ý", "A(","Ă", "a(","ă", "DD","Đ", "dd","đ", "I~","Ĩ", "i~","ĩ", "U~","Ũ", "u~","ũ", "O+","Ơ", "o+","ơ", "U+","Ư", "u+","ư", "A.","Ạ", "a.","ạ", "A?","Ả", "a?","ả", "E.","Ẹ", "e.","ẹ", "E?","Ẻ", "e?","ẻ", "E~","Ẽ", "e~","ẽ", "I?","Ỉ", "i?","ỉ", "I.","Ị", "i.","ị", "O.","Ọ", "o.","ọ", "O?","Ỏ", "o?","ỏ", "U.","Ụ", "u.","ụ", "U?","Ủ", "u?","ủ", "Y`","Ỳ", "y`","ỳ", "Y.","Ỵ", "y.","ỵ", "Y?","Ỷ", "y?","ỷ", "Y~","Ỹ", "y~","ỹ"],
  };

  // Escaped rather than literal: a bare combining mark in source is invisible in
  // every editor and the first person to reflow this file would lose one.
  var COMBINING = {
    s: '\u0301',  // sac    (acute)
    f: '\u0300',  // huyen  (grave)
    r: '\u0309',  // hoi    (hook above)
    x: '\u0303',  // nga    (tilde)
    j: '\u0323'   // nang   (dot below)
  };

  // The 134 characters that only Vietnamese uses (plus the 7 base letters).
  // Membership in this set is what a conversion is scored ON, so it must not
  // include plain à/é/ü etc. that any Western language also has... except that
  // Vietnamese genuinely uses those too. Hence the scoring in detect() leans on
  // the JUNK side of the ledger, which has no such ambiguity.
  var VIET_CHARS = 'ăâđêôơưĂÂĐÊÔƠƯ'
    + 'àáạảãÀÁẠẢÃằắặẳẵẰẮẶẲẴầấậẩẫẦẤẬẨẪ'
    + 'èéẹẻẽÈÉẸẺẼềếệểễỀẾỆỂỄ'
    + 'ìíịỉĩÌÍỊỈĨ'
    + 'òóọỏõÒÓỌỎÕồốộổỗỒỐỘỔỖờớợởỡỜỚỢỞỠ'
    + 'ùúụủũÙÚỤỦŨừứựửữỪỨỰỬỮ'
    + 'ỳýỵỷỹỲÝỴỶỸ';
  var VIET_SET = new Set(VIET_CHARS.split(''));

  // A character is "junk" when it is in a Latin supplement block, is not a
  // Vietnamese character, and is sitting INSIDE a word. The word-internal test
  // is the whole point: a standalone °, ©, § or ± is ordinary punctuation in an
  // English document and must not count, whereas the same byte wedged between
  // two ASCII letters ("TiÕng") is a legacy font and nothing else.
  var JUNK_RANGE = /[\u0080-\u00ff\u0100-\u024f\u02b0-\u02ff]/;
  var ASCII_LETTER = /[A-Za-z]/;

  var compiled = {};

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Build the alternation once per encoding. The table is already longest-first
  // and JS alternation is first-match-wins, so order is load-bearing here.
  function compile(id) {
    if (compiled[id]) return compiled[id];
    var flat = TABLES[id];
    if (!flat) return null;
    var map = new Map();
    var keys = [];
    for (var i = 0; i < flat.length; i += 2) {
      if (map.has(flat[i])) continue;      // first entry wins, matching the sort
      map.set(flat[i], flat[i + 1]);
      keys.push(escapeRe(flat[i]));
    }
    compiled[id] = { map: map, re: new RegExp(keys.join('|'), 'g') };
    return compiled[id];
  }

  /** NFC-compose. Vietnamese needs it even when nothing else is wrong: a PDF
   *  that stores "ế" as e + ◌̂ + ◌́ renders correctly on screen and still breaks
   *  Ctrl+F, sorting, word counts and most of Word. Safe on any language. */
  function toNFC(text) {
    try { return text.normalize('NFC'); } catch (e) { return text; }
  }

  // VIQR reuses "." and "?" as tone marks, and those are also sentence
  // punctuation — "ddo+`i." is "đời." with a full stop, not "đờị". They can
  // only be told apart by position, and the split that costs least is: a "."
  // or "?" that ends a word is punctuation, anywhere else it is a mark. That
  // keeps "de.p" → "đẹp" and "ho?i" → "hỏi" while leaving real sentences
  // intact; the price is a word that genuinely ENDS in a dot-below vowel with
  // no punctuation after it ("nho?" for "nhỏ"), which VIQR itself cannot
  // disambiguate either. The UI note says so.
  // Sentinels in the private-use area, so a mark that is really punctuation is
  // parked somewhere the tables can never match it and put back afterwards.
  var VIQR_GUARD = { '.': '\ue000', '?': '\ue001' };
  // ...and 'ends a word' is not enough on its own: 'thu?' is 'thủ', not a
  // question. What actually separates them is what comes NEXT — real
  // punctuation is followed by end-of-text or by a new sentence, never by a
  // lowercase letter. VIQR source is pure ASCII, so [^a-z] is a safe test.
  var VIQR_GUARD_RE = /[.?](?=\s*$|\s+[^a-z])/g;
  var VIQR_UNGUARD_RE = /[\ue000\ue001]/g;
  var VIQR_UNGUARD = { '\ue000': '.', '\ue001': '?' };

  /** Convert legacy-encoded text to Unicode. Returns NFC. */
  function decode(text, id) {
    var c = compile(id);
    if (!c) return toNFC(text);
    var src = String(text);
    if (id === 'viqr') {
      src = src.replace(VIQR_UNGUARD_RE, '')   // never trust private-use input
               .replace(VIQR_GUARD_RE, function (m) { return VIQR_GUARD[m]; });
    }
    var out = src.replace(c.re, function (m) { return c.map.get(m); });
    if (id === 'viqr') {
      out = out.replace(VIQR_UNGUARD_RE, function (m) { return VIQR_UNGUARD[m]; });
    }
    return toNFC(out);
  }

  function score(text) {
    var viet = 0, junk = 0;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (VIET_SET.has(ch)) { viet++; continue; }
      if (!JUNK_RANGE.test(ch)) continue;
      var before = i > 0 ? text[i - 1] : '';
      var after = i + 1 < text.length ? text[i + 1] : '';
      // Word-internal only — see JUNK_RANGE above.
      if (ASCII_LETTER.test(before) || ASCII_LETTER.test(after)
          || VIET_SET.has(before) || VIET_SET.has(after)) junk++;
    }
    return { viet: viet, junk: junk, value: viet * 2 - junk * 5 };
  }

  // Detection thresholds. These are not taste — they are the gap measured
  // between the right answer and every wrong one on the same text:
  //
  //     text                correct   next best   other languages
  //     TCVN3 garble        1.00      0.67        EN 0.24  FR 0.24  DE 0.00
  //     VNI garble          1.00      0.40
  //
  // Scoring on "how much junk did this clear" instead — the obvious metric —
  // does NOT separate them: German "größer/Prüfung/Grüße" clears 11 junk
  // characters under TCVN3 and scored higher than the real VNI answer did on
  // real VNI text. Only "is the RESULT valid Vietnamese" tells them apart.
  var MIN_RATE = 0.80;      // converted text must be mostly real syllables
  var MIN_RATE_GAIN = 0.15; // and must beat leaving it alone by a clear margin
  var MIN_JUNK_FIXED = 4;   // and must actually have had something to fix

  function wordsOf(text) {
    return toNFC(text).match(/[A-Za-zÀ-ỹ]+/g) || [];
  }

  function rateOfWords(words) {
    if (words.length < MIN_WORDS) return null;
    var sample = words.length > 4000 ? words.slice(0, 4000) : words;
    var ok = 0;
    for (var i = 0; i < sample.length; i++) if (isSyllable(sample[i])) ok++;
    return ok / sample.length;
  }

  /** Which legacy encoding, if any, this text looks like.
   *  Returns { encoding, confidence: 'high'|'low'|null, rate, baseRate,
   *            converted, candidates }.
   *  encoding is null when the text is already fine, when it is not Vietnamese
   *  at all, and when there is too little of it to judge — in every one of
   *  those cases the honest answer is "leave it alone". */
  function detect(text) {
    var sample = text.length > 200000 ? text.slice(0, 200000) : text;
    var baseText = toNFC(sample);
    var baseWords = wordsOf(baseText);
    var empty = { encoding: null, confidence: null, rate: null, baseRate: null,
                  converted: 0, candidates: [] };
    if (baseWords.length < MIN_WORDS) return empty;

    var baseRate = rateOfWords(baseWords);
    var baseJunk = score(baseText).junk;
    var candidates = [];

    ['tcvn3', 'vni', 'viscii'].forEach(function (id) {
      var out = decode(sample, id);
      var s = score(out);
      candidates.push({ encoding: id, rate: rateOfWords(wordsOf(out)),
                        junkFixed: baseJunk - s.junk, junkLeft: s.junk });
    });

    candidates.sort(function (a, b) {
      return (b.rate || 0) - (a.rate || 0) || b.junkFixed - a.junkFixed;
    });

    var best = candidates[0];
    var good = best && best.rate !== null && best.rate >= MIN_RATE
      && best.rate >= baseRate + MIN_RATE_GAIN && best.junkFixed >= MIN_JUNK_FIXED;

    return {
      encoding: good ? best.encoding : null,
      confidence: good ? (best.rate >= 0.9 && best.junkFixed >= 10 ? 'high' : 'low') : null,
      rate: best ? best.rate : null,
      baseRate: baseRate,
      converted: best ? best.junkFixed : 0,
      candidates: candidates
    };
  }

  // ── Vietnamese syllable check ───────────────────────────────────────────────
  // This is what detect() ranks on, and what a UI can show the user as a plain
  // number ("96% of words are valid Vietnamese syllables") instead of a
  // confidence label they would have to take on trust.
  //
  // Structure is onset + nucleus + coda. Tone marks are stripped first because
  // any of the six tones may sit on any nucleus; the letter-level diacritics
  // (ă â ê ô ơ ư đ) are NOT stripped, because in Vietnamese those are separate
  // letters and "â" vs "a" changes which syllables are legal.
  var MIN_WORDS = 12;   // below this there is not enough text to judge anything
  var ONSETS = ['ngh', 'ng', 'nh', 'ch', 'gh', 'gi', 'kh', 'ph', 'th', 'tr', 'qu',
                'b', 'c', 'd', 'đ', 'g', 'h', 'k', 'l', 'm', 'n', 'p', 'r', 's',
                't', 'v', 'x'];
  var NUCLEI = ['uyê', 'uya', 'uyu', 'ươi', 'ươu', 'iêu', 'yêu', 'uôi', 'oai',
                'oay', 'oao', 'oeo', 'uây', 'uôm',
                'ia', 'iê', 'ya', 'yê', 'ua', 'uô', 'ưa', 'ươ', 'oa', 'oă', 'oe',
                'oo', 'uâ', 'uê', 'uy', 'uơ', 'ai', 'ao', 'au', 'ay', 'âu', 'ây',
                'eo', 'êu', 'iu', 'oi', 'ôi', 'ơi', 'ui', 'ưi', 'ưu', 'ay',
                'a', 'ă', 'â', 'e', 'ê', 'i', 'o', 'ô', 'ơ', 'u', 'ư', 'y'];
  var CODAS = ['ngh', 'ng', 'nh', 'ch', 'c', 'm', 'n', 'p', 't'];

  function longestFirst(a) { return a.slice().sort(function (x, y) { return y.length - x.length; }); }
  var SYLLABLE_RE = new RegExp(
    '^(?:' + longestFirst(ONSETS).join('|') + ')?'
    + '(?:' + longestFirst(NUCLEI).join('|') + ')'
    + '(?:' + longestFirst(CODAS).join('|') + ')?$');

  // Strip tone marks but keep the letter-level diacritics (ă â ê ô ơ ư đ), which
  // are part of the letter in Vietnamese and not a tone.
  var TONE_MARKS = /[\u0300\u0301\u0303\u0309\u0323]/g;
  function stripTones(w) {
    try { return w.normalize('NFD').replace(TONE_MARKS, '').normalize('NFC'); }
    catch (e) { return w; }
  }

  function isSyllable(word) {
    return SYLLABLE_RE.test(stripTones(word).toLowerCase());
  }

  /** Share of alphabetic words that parse as Vietnamese syllables, 0–1.
   *  Returns null when there is not enough text to say anything. */
  function syllableRate(text) {
    return rateOfWords(wordsOf(text));
  }

  // ── Telex ───────────────────────────────────────────────────────────────────
  // MANUAL ONLY. See the header: the input is plain ASCII, so there is nothing
  // to detect and no way to tell a Telex "see" from an English one.
  var TELEX_MOD = {
    a: { a: 'â', w: 'ă' }, e: { e: 'ê' }, o: { o: 'ô', w: 'ơ' },
    u: { w: 'ư' }, d: { d: 'đ' }
  };
  var VOWELS = 'aăâeêioôơuưyAĂÂEÊIOÔƠUƯY';
  var SPECIAL_VOWELS = 'ăâêôơưĂÂÊÔƠƯ';

  function matchCase(ch, model) {
    return model === model.toUpperCase() && model !== model.toLowerCase()
      ? ch.toUpperCase() : ch;
  }

  function applyTone(ch, tone) {
    if (!COMBINING[tone]) return ch;
    return (ch + COMBINING[tone]).normalize('NFC');
  }

  function telexWord(w) {
    // 1. Letter modifiers, left to right. "uow" is the one sequence a pairwise
    //    pass gets wrong on its own — the w has to reach back past the o to the
    //    u as well, which is how "nguowif" becomes "người" and not "ngươi"+f.
    var s = '';
    for (var i = 0; i < w.length; i++) {
      var c = w[i], lc = c.toLowerCase();
      var prev = s.slice(-1), plc = prev.toLowerCase();
      if (lc === 'w' && s.length >= 2 && plc === 'o' && s[s.length - 2].toLowerCase() === 'u') {
        s = s.slice(0, -2) + matchCase('ư', s[s.length - 2]) + matchCase('ơ', prev);
        continue;
      }
      if (TELEX_MOD[plc] && TELEX_MOD[plc][lc]) {
        s = s.slice(0, -1) + matchCase(TELEX_MOD[plc][lc], prev);
        continue;
      }
      s += c;
    }

    // 2. Tone letter. It is NOT always last: Telex applies the tone the moment
    //    it is typed, so "Vieejt" and "Vieetj" both mean "Việt" and both are
    //    what people actually type. So scan from the right for a tone letter
    //    that has a vowel before it and leaves a legal coda behind it — the
    //    'j' in "Vieejt" leaves "t", which is one; the 'j' in "jump" has no
    //    vowel before it and is left alone.
    var tone = '';
    for (var idx = s.length - 1; idx >= 1; idx--) {
      var tc = s[idx].toLowerCase();
      if ('sfrxjz'.indexOf(tc) < 0) continue;
      var tail = s.slice(idx + 1).toLowerCase();
      if (tail && CODAS.indexOf(tail) < 0) continue;
      var head = s.slice(0, idx);
      var hasVowel = false;
      for (var k = 0; k < head.length; k++) {
        if (VOWELS.indexOf(head[k]) >= 0) { hasVowel = true; break; }
      }
      if (!hasVowel) continue;
      tone = tc;
      s = head + s.slice(idx + 1);
      break;
    }
    if (!tone || tone === 'z') return s;

    // 3. Place the tone. Find the vowel cluster, then:
    //      - a letter-diacritic vowel (ă â ê ô ơ ư) always takes it — the LAST
    //        one, so "ươ" tones the ơ and "uyê" the ê;
    //      - otherwise last vowel when the syllable has a coda, penultimate
    //        when it is open. That is the traditional placement, which is what
    //        dictionaries and Unikey's default both use: hòa, thủy, hóa.
    var start = -1, end = -1;
    for (var j = 0; j < s.length; j++) {
      if (VOWELS.indexOf(s[j]) >= 0) { if (start < 0) start = j; end = j; }
      else if (start >= 0) break;
    }
    if (start < 0) return s;

    // "gi" and "qu" are onsets, not vowels — without this "gias" tones the i
    // and gives "gía" instead of "giá".
    var head = s.slice(0, start + 1).toLowerCase();
    if (start > 0 && end > start && (head.slice(-2) === 'gi' || head.slice(-2) === 'qu')) start++;

    var target = -1;
    for (var v = end; v >= start; v--) {
      if (SPECIAL_VOWELS.indexOf(s[v]) >= 0) { target = v; break; }
    }
    if (target < 0) {
      var open = end === s.length - 1;
      target = (open && end > start) ? end - 1 : end;
    }
    return s.slice(0, target) + applyTone(s[target], tone) + s.slice(target + 1);
  }

  function telexToUnicode(text) {
    return toNFC(String(text).replace(/[A-Za-z]+/g, telexWord));
  }

  // ── Public surface ──────────────────────────────────────────────────────────
  // `auto` is only ever offered for the three font encodings; the two input
  // methods carry `manualOnly` so a UI can refuse to auto-apply them.
  var ENCODINGS = [
    { id: 'tcvn3',  label: 'TCVN3 / ABC (.VnTime)', kind: 'font',
      sample: 'TiÕng ViÖt' },
    { id: 'vni',    label: 'VNI-Windows (VNI-Times)', kind: 'font',
      sample: 'Tieáng Vieät' },
    { id: 'viscii', label: 'VISCII', kind: 'font', sample: '' },
    { id: 'viqr',   label: 'VIQR', kind: 'input', manualOnly: true,
      sample: "Tie^́ng Vie^.t" },
    { id: 'telex',  label: 'Telex', kind: 'input', manualOnly: true,
      sample: 'Tieengs Vieejt' }
  ];

  /** Single entry point a tool calls: convert by id, where 'none' is still an
   *  NFC pass because that is never wrong. */
  function convert(text, id) {
    if (!id || id === 'none') return toNFC(text);
    if (id === 'telex') return telexToUnicode(text);
    return decode(text, id);
  }

  // ── Proofreading OCR output ─────────────────────────────────────────────────
  // A spell checker cannot help here, and it is worth being precise about why:
  // the errors this exists to catch are REAL WORDS. Vietnamese OCR reads "cái"
  // as "cói" and "đã" as "đỡ" — both of which isSyllable() accepts, because
  // both are ordinary words (cói = sedge, đỡ = to support). Only context
  // separates them.
  //
  // The context used here is the DOCUMENT ITSELF, not a bundled language model.
  // A word that a document uses forty times is that document's spelling; the
  // same word appearing once more in a shape one confusion-step away is
  // overwhelmingly a misreading of it. That needs no corpus, ships no
  // megabytes, adapts to the document's own vocabulary, and — the part a
  // frequency list cannot do — leaves a document genuinely ABOUT "đỡ" alone,
  // because there "đỡ" is the frequent form.
  //
  // What it cannot do: a short document gives it almost nothing to work with,
  // and an error the OCR made consistently looks exactly like a real word.
  // It suggests; it never rewrites on its own.

  // Base letters whose shapes OCR actually swaps. The tone is NOT part of the
  // confusion — it is a separate high-contrast mark that survives, which is why
  // the reported errors kept the tone and changed only the vowel:
  //     cái -> cói   (a->o, acute kept)      đã -> đỡ   (a->ơ, tilde kept)
  var CONFUSABLE_GROUPS = ['aăâoôơ', 'uư', 'eê', 'iy', 'dđ'];
  var PROOF_TONES = ['', '̀', '́', '̃', '̉', '̣'];

  // The other half, and in Vietnamese the larger one: the tone mark itself.
  // A scan that is faint, skewed or low-dpi loses or swaps tone marks far more
  // often than it confuses letters — ả/ã differ by a few pixels, and a dropped
  // mark turns a word into a different real word rather than into nonsense.
  var TONE_BEARING = 'aăâeêioôơuưy';

  var CONFUSE = (function () {
    var m = Object.create(null);
    function add(a, b) {
      if (a === b) return;
      (m[a] || (m[a] = [])).push(b);
      if (a.toUpperCase() !== a) (m[a.toUpperCase()] || (m[a.toUpperCase()] = []))
        .push(b.toUpperCase());
    }
    // A combination that does not compose to ONE character is not a letter any
    // Vietnamese font ever drew, so no OCR engine can have confused it. That
    // single check is what keeps "d"/"đ" to their untoned forms and drops the
    // impossible vowel+tone pairs, without needing a table of exceptions.
    function compose(base, tone) {
      var c = (base + tone).normalize('NFC');
      return c.length === 1 ? c : null;
    }
    // same tone, confusable base letter  — cái -> cói, đã -> đỡ
    CONFUSABLE_GROUPS.forEach(function (group) {
      for (var i = 0; i < group.length; i++) {
        for (var j = 0; j < group.length; j++) {
          if (i === j) continue;
          for (var t = 0; t < PROOF_TONES.length; t++) {
            var a = compose(group[i], PROOF_TONES[t]);
            var b = compose(group[j], PROOF_TONES[t]);
            if (a && b) add(a, b);
          }
        }
      }
    });
    // same base letter, confusable tone — người -> ngươi, hỏi -> hõi
    for (var v = 0; v < TONE_BEARING.length; v++) {
      for (var s = 0; s < PROOF_TONES.length; s++) {
        for (var u = 0; u < PROOF_TONES.length; u++) {
          if (s === u) continue;
          var x = compose(TONE_BEARING[v], PROOF_TONES[s]);
          var y = compose(TONE_BEARING[v], PROOF_TONES[u]);
          if (x && y) add(x, y);
        }
      }
    }
    return m;
  })();

  // Words that may be a correction TARGET but never a correction SUSPECT.
  //
  // Self-consistency has one bad failure mode, and it is this: in a document
  // that happens to be about "đỡ", a single correct "đã" is rare enough and
  // "đỡ" frequent enough that the rule proposes rewriting the grammar. These
  // are ordinary Vietnamese function words — if one appears at all, even once,
  // it is almost certainly what the page really said.
  var PROOF_KEEP = (function () {
    var keep = Object.create(null);
    ('là và của có không được các một những người cho với này đó đã trong khi '
      + 'đến ra thì mà nên cũng như về tại bởi vì nếu hay hoặc tôi chúng bạn họ '
      + 'nó ai gì nào sao đâu rất quá lắm hơn nhất mỗi mọi cả chỉ còn đang sẽ '
      + 'vẫn chưa phải cần muốn biết làm đi lại ở từ theo sau trước trên dưới '
      + 'giữa ngoài cùng để do bằng thêm nhưng hoặc rồi nữa ấy kia').split(' ')
      .forEach(function (w) { if (w) keep[w] = true; });
    return keep;
  })();

  // One substitution only. Allowing two would reach far enough to connect words
  // that merely rhyme, and precision is the whole value here.
  function confusionNeighbours(word) {
    var out = [];
    for (var i = 0; i < word.length; i++) {
      var alts = CONFUSE[word[i]];
      if (!alts) continue;
      for (var k = 0; k < alts.length; k++) {
        out.push(word.slice(0, i) + alts[k] + word.slice(i + 1));
      }
    }
    return out;
  }

  var PROOF_RARE_MAX  = 2;   // the suspect must be rare in this document
  var PROOF_ALT_MIN   = 4;   // the alternative must be well established in it
  var PROOF_MIN_RATIO = 8;   // and must clearly dominate it

  // corpus = the text to learn the document's own spellings from (pass
  // everything). target = the text actually eligible for correction; defaults
  // to the corpus. They differ because pdf-extracted text is EXACT — a rare
  // word there is a real word — so only OCR pages should be corrected, while
  // every page is worth counting.
  function proofread(corpus, target) {
    var count = Object.create(null);
    var all = wordsOf(corpus);
    for (var i = 0; i < all.length; i++) {
      var k = all[i].toLowerCase();
      count[k] = (count[k] || 0) + 1;
    }
    var pool = Object.create(null);
    var tw = target === undefined || target === null ? all : wordsOf(target);
    for (var j = 0; j < tw.length; j++) pool[tw[j].toLowerCase()] = true;

    var out = [];
    for (var w in pool) {
      var n = count[w] || 0;
      if (n < 1 || n > PROOF_RARE_MAX || w.length < 2) continue;
      if (PROOF_KEEP[w]) continue;
      var alts = confusionNeighbours(w);
      var best = null;
      for (var a = 0; a < alts.length; a++) {
        var an = count[alts[a]] || 0;
        if (an < PROOF_ALT_MIN || an < n * PROOF_MIN_RATIO) continue;
        if (!isSyllable(alts[a])) continue;
        if (!best || an > best.altCount) best = { to: alts[a], altCount: an };
      }
      if (best) out.push({ from: w, to: best.to, count: n, altCount: best.altCount });
    }
    out.sort(function (x, y) {
      return y.altCount - x.altCount || (x.from < y.from ? -1 : x.from > y.from ? 1 : 0);
    });
    return out;
  }

  function applySuggestions(text, subs) {
    if (!subs || !subs.length) return toNFC(text);
    var map = Object.create(null);
    for (var i = 0; i < subs.length; i++) map[subs[i].from] = subs[i].to;
    return toNFC(text).replace(/[A-Za-zÀ-ỹ]+/g, function (w) {
      var to = map[w.toLowerCase()];
      if (!to) return w;
      // Match the case that was actually there — a corrected word at the start
      // of a sentence must not come back lowercase.
      if (w === w.toUpperCase() && w !== w.toLowerCase()) return to.toUpperCase();
      if (w[0] === w[0].toUpperCase()) return to.charAt(0).toUpperCase() + to.slice(1);
      return to;
    });
  }

  global.OTVietnamese = {
    ENCODINGS: ENCODINGS,
    convert: convert,
    decode: decode,
    detect: detect,
    telexToUnicode: telexToUnicode,
    toNFC: toNFC,
    isSyllable: isSyllable,
    syllableRate: syllableRate,
    proofread: proofread,
    applySuggestions: applySuggestions
  };
})(typeof window !== 'undefined' ? window : globalThis);

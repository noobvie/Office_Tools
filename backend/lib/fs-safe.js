'use strict';

// Start-up cleanup of a scratch directory that must be empty at boot.
//
// emptyDirInside(dir, parent): delete everything INSIDE `dir`, then make sure `dir`
// exists. Refuses (returns false, deletes nothing) unless `dir` resolves to a strict
// sub-directory of `parent` and is a real directory, not a symlink — so a bad config
// value can never turn this into "rm -rf" of something else. Never throws.

const fs = require('fs');
const path = require('path');

function emptyDirInside(dir, parent, log = console) {
  try {
    const d = path.resolve(dir);
    const p = path.resolve(parent);
    if (d === p || !d.startsWith(p + path.sep)) {
      log.error('[cleanup] refusing to empty', d, '(not inside', p + ')');
      return false;
    }
    let st = null;
    try { st = fs.lstatSync(d); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (st && !st.isDirectory()) {
      log.error('[cleanup] refusing to empty', d, '(not a plain directory)');
      return false;
    }
    if (st) {
      for (const name of fs.readdirSync(d)) {
        const child = path.join(d, name);
        if (path.dirname(child) !== d) continue;
        fs.rmSync(child, { recursive: true, force: true });
      }
    }
    fs.mkdirSync(d, { recursive: true });
    return true;
  } catch (e) {
    log.error('[cleanup]', dir, e.message);
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* reported above */ }
    return false;
  }
}

module.exports = { emptyDirInside };

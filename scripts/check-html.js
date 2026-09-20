#!/usr/bin/env node
/**
 * scripts/check-html.js
 * Validates that every tools/<name>/index.html conforms to the required head structure:
 *   1. inline theme-init <script> (sets data-theme) before the stylesheet
 *   2. <link rel="stylesheet" href="../../css/style.css">
 *
 * theme-init is inlined (not an external file) so it runs with zero fetch
 * delay and there is no flash of the wrong theme on first paint.
 *
 * Usage:  node scripts/check-html.js
 * Exit code 0 = all OK, 1 = one or more violations found.
 *
 * This file is also a library: scripts/check-tools.js (the full mechanical sweep)
 * requires it for the theme-init rule so the two never drift apart. Keep the CLI
 * behaviour identical when run directly.
 */

const fs   = require('fs');
const path = require('path');

const TOOLS_DIR      = path.join(__dirname, '..', 'tools');
// Distinctive marker for the inline theme-init snippet.
const THEME_INIT_REF = 'localStorage.getItem("ot-theme")';
const STYLESHEET_REF = '<link rel="stylesheet" href="../../css/style.css">';

/**
 * Theme-init / stylesheet ordering check for one page's HTML.
 * Returns null when the page is fine, otherwise a one-line reason.
 */
function checkThemeInit(html) {
  const initPos  = html.indexOf(THEME_INIT_REF);
  const stylePos = html.indexOf(STYLESHEET_REF);
  if (initPos < 0)        return 'missing inline theme-init <script>';
  if (stylePos < 0)       return 'missing style.css <link> tag';
  if (initPos > stylePos) return 'theme-init must come before style.css';
  return null;
}

function toolPages() {
  return fs.readdirSync(TOOLS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => path.join(TOOLS_DIR, d.name, 'index.html'));
}

function main() {
  const dirs = toolPages();
  let errors = 0;

  for (const file of dirs) {
    const rel = path.relative(path.join(__dirname, '..'), file);
    if (!fs.existsSync(file)) {
      console.error(`MISSING  ${file}`);
      errors++;
      continue;
    }
    const reason = checkThemeInit(fs.readFileSync(file, 'utf8'));
    if (reason) {
      console.error(`FAIL  ${rel}  — ${reason}`);
      errors++;
    } else {
      console.log(`OK    ${rel}`);
    }
  }

  if (errors > 0) {
    console.error(`\n${errors} violation(s) found.`);
    process.exit(1);
  } else {
    console.log(`\nAll ${dirs.length} tool pages passed.`);
  }
}

module.exports = { checkThemeInit, toolPages, THEME_INIT_REF, STYLESHEET_REF, TOOLS_DIR };

if (require.main === module) main();

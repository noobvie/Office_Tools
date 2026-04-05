#!/usr/bin/env node
/**
 * scripts/check-html.js
 * Validates that every tools/*/index.html conforms to the required head structure:
 *   1. <script src="../../js/theme-init.js"> before the stylesheet
 *   2. <link rel="stylesheet" href="../../css/style.css">
 *
 * Usage:  node scripts/check-html.js
 * Exit code 0 = all OK, 1 = one or more violations found.
 */

const fs   = require('fs');
const path = require('path');

const TOOLS_DIR      = path.join(__dirname, '..', 'tools');
const THEME_INIT_REF = '<script src="../../js/theme-init.js"></script>';
const STYLESHEET_REF = '<link rel="stylesheet" href="../../css/style.css">';

const dirs = fs.readdirSync(TOOLS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => path.join(TOOLS_DIR, d.name, 'index.html'));

let errors = 0;

for (const file of dirs) {
  if (!fs.existsSync(file)) {
    console.error(`MISSING  ${file}`);
    errors++;
    continue;
  }

  const html = fs.readFileSync(file, 'utf8');
  const hasThemeInit  = html.includes(THEME_INIT_REF);
  const hasStylesheet = html.includes(STYLESHEET_REF);

  // theme-init must appear before the stylesheet
  const initPos  = html.indexOf(THEME_INIT_REF);
  const stylePos = html.indexOf(STYLESHEET_REF);
  const correctOrder = hasThemeInit && hasStylesheet && initPos < stylePos;

  const rel = path.relative(path.join(__dirname, '..'), file);

  if (!hasThemeInit) {
    console.error(`FAIL  ${rel}  — missing theme-init.js <script> tag`);
    errors++;
  } else if (!hasStylesheet) {
    console.error(`FAIL  ${rel}  — missing style.css <link> tag`);
    errors++;
  } else if (!correctOrder) {
    console.error(`FAIL  ${rel}  — theme-init.js must come before style.css`);
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

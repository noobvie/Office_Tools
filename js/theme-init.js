/* Theme initialiser — must be loaded in <head> before the stylesheet.
   Sets data-theme on <html> immediately so there is no flash of wrong theme. */
(function () {
  const VALID = ['light', 'dark', 'matrix', 'anime'];
  const saved = localStorage.getItem('ot-theme');
  document.documentElement.setAttribute(
    'data-theme',
    VALID.includes(saved) ? saved : 'matrix'
  );
})();

'use strict';

// Keep one bad request from taking the process down, and keep internals out of
// error responses.
//
//   guardAsyncRoutes(app);               // once, before any route: wraps every async handler
//   app.get('/x', asyncRoute(async (req, res) => { … }));   // the explicit form
//   app.use(finalErrorHandler);          // last middleware, after every route
//   installProcessGuards();              // once, at start-up
//
// Express 4 does not forward a rejected promise from an async handler; on Node 24 an
// unhandled rejection terminates the process. asyncRoute catches it, logs, and
// answers 500 JSON (or just ends a response that had already started, e.g. SSE).

function asyncRoute(fn) {
  return function asyncRouteWrapper(req, res, next) {
    let p;
    try { p = fn(req, res, next); }
    catch (err) { return handleRouteError(err, req, res); }
    if (p && typeof p.catch === 'function') p.catch(err => handleRouteError(err, req, res));
    return p;
  };
}

function handleRouteError(err, req, res) {
  console.error(`[route] ${req.method} ${req.path}:`, err?.stack || err?.message || err);
  try {
    if (!res.headersSent) res.status(500).json({ error: 'Server error' });
    else if (!res.writableEnded) res.end();
  } catch { /* socket already gone */ }
}

// Wrap every async handler registered through app.get / post / put / delete / all
// with asyncRoute, so no route can be added without the guard. Sync handlers are left
// alone (Express 4 already catches their throws). `app.get('setting')` (one string
// argument) is Express's settings getter and passes straight through.
const _AsyncFunction = (async () => {}).constructor;
function guardAsyncRoutes(app) {
  for (const m of ['get', 'post', 'put', 'delete', 'all']) {
    const orig = app[m].bind(app);
    app[m] = function guardedRoute(...args) {
      if (m === 'get' && args.length === 1 && typeof args[0] === 'string') return orig(...args);
      return orig(...args.map(a => (a instanceof _AsyncFunction ? asyncRoute(a) : a)));
    };
  }
  return app;
}

// Last error middleware: generic JSON, never Express's HTML stack-trace page.
// Body-parser errors (malformed JSON, too large) carry a 4xx status.
// eslint-disable-next-line no-unused-vars
function finalErrorHandler(err, req, res, next) {
  const status = Number(err?.status || err?.statusCode) || 500;
  if (status >= 500) console.error(`[error] ${req.method} ${req.path}:`, err?.stack || err?.message || err);
  if (res.headersSent) { try { res.end(); } catch { /* gone */ } return; }
  if (status >= 400 && status < 500) return res.status(status).json({ error: 'Bad request' });
  res.status(500).json({ error: 'Server error' });
}

// Backstop only: log and keep serving. Every route should already be guarded.
let _installed = false;
function installProcessGuards() {
  if (_installed) return;
  _installed = true;
  process.on('unhandledRejection', err => {
    console.error('[unhandledRejection]', err?.stack || err);
  });
  process.on('uncaughtException', err => {
    console.error('[uncaughtException]', err?.stack || err);
  });
}

module.exports = { asyncRoute, guardAsyncRoutes, finalErrorHandler, installProcessGuards };

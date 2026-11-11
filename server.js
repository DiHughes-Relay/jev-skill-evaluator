// Jev Skill Evaluator: the whole app (page + API) as one request handler.
// - On Vercel: this file is the app's entrypoint; Vercel calls the exported handler for each request.
// - On your laptop: `node server.js`, then open http://localhost:4317
// Reads TYPESAFE_API_KEY (and optional APP_PASSWORD) from the environment, or from .env locally.
const http = require('http');
const fs = require('fs');
const path = require('path');
const core = require('./lib/core');

const routes = {
  '/api/config': core.handlers.config,
  '/api/skills': core.handlers.skills,
  '/api/preview': core.handlers.preview,
  '/api/evaluate': core.handlers.evaluate,
  '/api/docs': core.handlers.docs,
  '/api/live-turn': core.handlers.liveTurn,
  '/api/harm': core.handlers.harm,
};

// Read the pages once at startup. (On Vercel, files in public/ are also served directly.)
const readPage = (f) => { try { return fs.readFileSync(path.join(__dirname, 'public', f)); } catch { return null; } };
const PAGES = { '/': readPage('index.html'), '/index.html': readPage('index.html'), '/how-it-works': readPage('how-it-works.html'), '/live': readPage('live.html'), '/live.html': readPage('live.html'), '/how-it-works.html': readPage('how-it-works.html') };

function app(req, res) {
  const url = req.url.split('?')[0];
  if (routes[url]) return routes[url](req, res);
  if (req.method === 'GET' && PAGES[url]) {
    return core.send(res, 200, PAGES[url], 'text/html; charset=utf-8');
  }
  return core.send(res, 404, { error: 'not found' });
}

module.exports = app;

if (require.main === module) {
  const PORT = Number(process.env.PORT || 4317);
  http.createServer(app).listen(PORT, () => {
    console.log(`Jev Skill Evaluator running at http://localhost:${PORT}${core.MOCK ? '  (MOCK mode — no real Jev calls)' : ''}`);
    if (!process.env.TYPESAFE_API_KEY && !core.MOCK) console.log('Add TYPESAFE_API_KEY=... to the .env file in this folder, then restart.');
  });
}

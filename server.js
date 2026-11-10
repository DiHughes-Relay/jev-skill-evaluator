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
};

// Read the page once at startup. (On Vercel, files in public/ are also served directly.)
let PAGE = null;
try { PAGE = fs.readFileSync(path.join(__dirname, 'public', 'index.html')); } catch { /* served statically on Vercel */ }

function app(req, res) {
  const url = req.url.split('?')[0];
  if (routes[url]) return routes[url](req, res);
  if (req.method === 'GET' && (url === '/' || url === '/index.html') && PAGE) {
    return core.send(res, 200, PAGE, 'text/html; charset=utf-8');
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

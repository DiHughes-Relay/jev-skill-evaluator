// Jev Skill Evaluator — local app (not used on Vercel). Run with:  node local-server.js
// Named local-server.js on purpose: Vercel auto-detects a root server.js as the whole app.
//   then open http://localhost:4317
// No dependencies. Reads TYPESAFE_API_KEY (and optional APP_PASSWORD) from .env in this folder.
// The same handlers run on Vercel as api/*.js.
const http = require('http');
const fs = require('fs');
const path = require('path');
const core = require('./lib/core');

const PORT = Number(process.env.PORT || 4317);
const routes = { '/api/config': core.handlers.config, '/api/skills': core.handlers.skills, '/api/preview': core.handlers.preview, '/api/evaluate': core.handlers.evaluate };

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    return core.send(res, 200, fs.readFileSync(path.join(__dirname, 'public/index.html')), 'text/html; charset=utf-8');
  }
  if (routes[url]) return routes[url](req, res);
  core.send(res, 404, { error: 'not found' });
});

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Jev Skill Evaluator running at http://localhost:${PORT}${core.MOCK ? '  (MOCK mode — no real Jev calls)' : ''}`);
    if (!process.env.TYPESAFE_API_KEY && !core.MOCK) console.log('Add TYPESAFE_API_KEY=... to the .env file in this folder, then restart.');
  });
}
module.exports = core;

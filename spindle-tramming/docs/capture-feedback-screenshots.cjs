// Capture current README images against an isolated simulated gSender SDK.
// This helper does not connect to, or command, a CNC.
const { chromium } = require('C:/Users/jim/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../ui');
const output = path.resolve(__dirname, 'images');
fs.mkdirSync(output, { recursive: true });

const mock = `
window.sim={snapshot:{connection:{isConnected:true},pluginState:{busy:false},controller:{workflow:{state:'idle'},state:{status:{activeState:'Idle'}},feeder:{status:{pending:false,queue:0,hold:false}},mpos:{x:200,y:200,z:50},wpos:{x:0,y:0,z:0}}}};
export const redux={getState:async()=>structuredClone(window.sim.snapshot)};
const savedSettings={radius:'42',feed:'275',start:'north',degrees:'45',preload:'1.03',readingUnits:'mm',xSpan:'',ySpan:'',gain:'250'};
export const storage={get:async key=>key==='spindleTramming.settings'?structuredClone(savedSettings):{},set:async()=>{}};
export const machine={
  query:async command=>command==='$G'
    ? {ok:true,complete:true,lines:['[GC:G0 G54 G17 G21 G90 G94 M5]','ok']}
    : {ok:true,complete:true,lines:['ok']},
  command:async()=>{},
  setBusy:async value=>{window.sim.snapshot.pluginState.busy=value;}
};`;

const server = http.createServer((req, res) => {
  if (req.url === '/plugin-sdk/index.js') {
    res.setHeader('Content-Type', 'text/javascript');
    return res.end(mock);
  }
  const target = path.resolve(root, '.' + decodeURIComponent(req.url === '/' ? '/index.html' : req.url));
  if (!target.startsWith(root + path.sep)) {
    res.statusCode = 403;
    return res.end();
  }
  try {
    res.setHeader('Content-Type', target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(target));
  } catch {
    res.statusCode = 404;
    res.end();
  }
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1700 }, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('#begin').waitFor();
    await page.locator('#settingsStatus').filter({ hasText: 'Saved settings restored' }).waitFor();
    await page.screenshot({ path: path.join(output, '09-persistent-settings.png') });
    await page.fill('#preload', '1.03');
    await page.check('#ready');
    await page.click('#begin');
    await page.locator('#status').filter({ hasText: 'Session ready' }).waitFor();
    await page.screenshot({ path: path.join(output, '04-interactive.png') });
    const terminology = page.locator('section.panel').filter({ hasText: 'Understanding tilt and nod' });
    await terminology.screenshot({ path: path.join(output, '08-tilt-nod-ui.png') });
    console.log('Captured current setup and tilt/nod UI screenshots with simulated host state. No CNC connected.');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => {
  console.error(error);
  server.close();
  process.exitCode = 1;
});

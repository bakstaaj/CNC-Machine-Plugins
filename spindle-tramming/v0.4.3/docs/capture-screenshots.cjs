// Isolated documentation and integration preview. Never connects to gSender or a CNC.
const {chromium}=require('C:/Users/jim/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../ui'),output=path.resolve(__dirname,'images');fs.mkdirSync(output,{recursive:true});
const mock=`
window.sim={commands:[],hold:false,pending:null,fail:false,snapshot:{connection:{isConnected:true},pluginState:{busy:false},controller:{workflow:{state:'idle'},state:{status:{activeState:'Idle'}},feeder:{status:{pending:false,queue:0,hold:false}},mpos:{x:200,y:200,z:50},wpos:{x:0,y:0,z:0}}}};
export const redux={getState:async()=>structuredClone(window.sim.snapshot)};
export const machine={
query:async(cmd)=>{
 const sim=window.sim;sim.commands.push(cmd);
 if(cmd==='$G')return{ok:true,complete:true,lines:['[GC:G0 G54 G17 G21 G90 G94 M5]','ok']};
 if(/^G[23] /.test(cmd)){
  if(sim.fail)return{ok:false,complete:true,error:'error:9',lines:['error:9']};
  const words=cmd.split(' '),value=key=>Number(words.find(w=>w.startsWith(key)).slice(1));
  sim.pending={x:value('X'),y:value('Y')};sim.snapshot.controller.state.status.activeState='Run';
 }
 if(cmd==='G4 P0'){
  await new Promise(r=>setTimeout(r,200));
  if(sim.hold)return{ok:false,complete:false,reason:'timeout',lines:[]};
  for(const frame of ['mpos','wpos']){sim.snapshot.controller[frame].x+=sim.pending.x;sim.snapshot.controller[frame].y+=sim.pending.y;}
  sim.pending=null;sim.snapshot.controller.state.status.activeState='Idle';
 }
 return{ok:true,complete:true,lines:['ok']};
},
setBusy:async(value)=>{window.sim.snapshot.pluginState.busy=value;},
command:async(cmd)=>{window.sim.commands.push(cmd);if(cmd==='feedhold'){window.sim.hold=true;window.sim.snapshot.controller.state.status.activeState='Hold';}}
};`;
const server=http.createServer((req,res)=>{
 if(req.url==='/plugin-sdk/index.js'){res.setHeader('Content-Type','text/javascript');return res.end(mock);}
 const target=path.resolve(root,'.'+decodeURIComponent(req.url==='/'?'/index.html':req.url));
 if(!target.startsWith(root+path.sep)){res.statusCode=403;return res.end();}
 try{res.setHeader('Content-Type',target.endsWith('.js')?'text/javascript':target.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(target));}catch{res.statusCode=404;res.end();}
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1180,height:1100},deviceScaleFactor:1});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.locator('#begin').waitFor();assert.equal(await page.locator('#cw').isDisabled(),true);
  await page.click('#begin');assert.match(await page.locator('#status').textContent(),/setup confirmation/);
  await page.fill('#preload','1.03');await page.check('#ready');await page.click('#begin');
  await page.locator('#status').filter({hasText:'Session ready'}).waitFor();
  assert.equal(await page.locator('#readings tr').count(),1);
  await page.screenshot({path:path.join(output,'04-interactive.png'),fullPage:true});
  for(const [i,reading]of ['0.98','0.97','1.02','1.03'].entries()){
   await page.click('#cw');
   await page.locator('#readings tr').nth(i+1).filter({hasText:'Moving'}).waitFor();
   assert.equal(await page.locator('#ccw').isDisabled(),true);
   await page.locator('#status').filter({hasText:'Move complete'}).waitFor();
   assert.equal(await page.locator('#cw').isDisabled(),true);
   await page.locator('#latestReading').fill(reading);await page.click('#saveReading');
  }
  assert.match(await page.locator('#position').textContent(),/EAST/);
  await page.locator('#readings').locator('..').locator('..').screenshot({path:path.join(output,'05-readings.png')});
  await page.fill('#xSpan','200');await page.fill('#ySpan','150');await page.click('#calculate');
  await page.locator('#visual').waitFor({state:'visible'});
  assert.match(await page.locator('#result').textContent(),/0.06000 mm/);
  assert.match(await page.locator('#result').textContent(),/0.12000 mm/);
  const resultText=await page.locator('#result').textContent();
  const before=await page.locator('.error-plane').getAttribute('points');
  await page.locator('#gain').fill('700');
  assert.equal(await page.locator('#result').textContent(),resultText);
  assert.notEqual(await page.locator('.error-plane').getAttribute('points'),before);
  assert.match(await page.locator('#gainLabel').textContent(),/700x/);
  await page.locator('#visual').screenshot({path:path.join(output,'06-error-plane.png')});
  await page.locator('#result').locator('..').screenshot({path:path.join(output,'07-corrections.png')});
  await page.click('#ccw');await page.locator('#status').filter({hasText:'Move complete at NORTH'}).waitFor();
  assert.equal(await page.locator('#visual').isHidden(),true);
  assert.match(await page.locator('#readings tr').last().textContent(),/CCW.*NORTH/);
  await page.locator('#latestReading').fill('1.02');await page.click('#saveReading');
  await page.evaluate(()=>{window.sim.fail=true;});await page.click('#cw');
  await page.locator('#status').filter({hasText:'error:9'}).waitFor();
  assert.equal(await page.locator('#cw').isDisabled(),true);assert.match(await page.locator('#position').textContent(),/uncertain/);
  const payload=await page.evaluate(()=>window.sim.commands);
  assert.ok(payload.every(command=>/^[\x20-\x7E]+$/.test(command)));
  assert.ok(!payload.some(command=>/^M0/.test(command)));
  assert.ok(payload.includes('feedhold'));
  assert.deepEqual(errors,[]);
  // Small-screen layout must retain horizontal scrolling inside the table only.
  await page.setViewportSize({width:430,height:900});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  console.log('Browser checks passed: CW/CCW, reading gating, completion, calculations, 3D exaggeration invariance, ASCII commands, fault lockout, responsive layout. Four screenshots saved. No live machine connection.');
 }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});

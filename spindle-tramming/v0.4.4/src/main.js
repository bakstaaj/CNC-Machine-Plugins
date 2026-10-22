import { machine, redux, storage } from '@sienci/gsender-plugin-sdk';
import { TrammingSession } from './motion.js';
import { analyzeReadings, planeModel } from './analysis.js';
import tiltNodImage from '../docs/images/tilt-nod.png';
import './style.css';

const $=id=>document.getElementById(id);
document.querySelector('#app').innerHTML=`
<header><div class="eyebrow">gSender spindle alignment</div><h1>Spindle Tramming</h1><p>Measure spindle tilt and nod from this window. Switch off spindle/VFD power at its power control before mounting the indicator.</p></header>
<section class="panel"><h2>Measurement setup</h2><form id="settings"><fieldset id="config"><div class="grid">
<label>Indicator radius (mm)<input id="radius" type="number" min="0.001" max="1000" step="any" value="50" required></label>
<label>Feed (mm/min)<input id="feed" type="number" min="0.001" max="10000" step="any" value="300" required></label>
<label>Starting spindle position<select id="start"><option value="east">X+</option><option value="south">Y-</option><option value="west">X-</option><option value="north">Y+</option></select></label>
<label>Angle per move<select id="degrees"><option value="90">90 degrees</option><option value="45">45 degrees</option></select></label>
<label>Initial preload reading<input id="preload" type="number" step="any" value="0" required></label>
<label>Dial reading units<select id="readingUnits"><option value="mm">Millimeters</option><option value="in">Inches</option></select></label>
</div></fieldset></form><p id="settingsStatus" class="hint" role="status">Settings are saved automatically on this device in gSender.</p>
<p class="hint">The selected X/Y position describes the spindle around the fixed contact tip. The indicator arm points toward the center. Rotate the arm by hand during each arc. Do not jog or change offsets during a session.</p>
<p class="hint">Check clearance for the full arc, including the gauge body and stem; some gauges may need the stem cap removed if their design allows it. A camera or mirror can help read the dial when it faces away. Avoid leaning on the machine table while reading.</p>
<label class="check"><input id="ready" type="checkbox"> I switched spindle/VFD power off at its power control, secured the indicator, and checked the start geometry and full travel.</label>
<button id="begin">Start new session (clears readings)</button></section>
<section id="workflow" class="panel movement workflow"><div><h2>Move and measure</h2><p id="position">No active session</p>
<svg id="circle" viewBox="-95 -95 190 190" aria-label="Current spindle position around contact point"><circle cx="0" cy="0" r="60" class="orbit"/><path id="arc"/><line id="arm" x1="0" y1="0"/><circle cx="0" cy="0" r="3" class="center"/><circle id="marker" r="6"/><text x="-9" y="-78">Y+</text><text x="78" y="4">X+</text><text x="-9" y="86">Y-</text><text x="-91" y="4">X-</text><text x="34" y="-40">X+ Y+</text><text x="34" y="48">X+ Y-</text><text x="-68" y="48">X- Y-</text><text x="-68" y="-40">X- Y+</text></svg></div>
<div><div class="latest-entry"><label class="latest-reading"><span id="latestLabel">Start a session to enter readings here.</span><input id="latestReading" type="number" step="any" disabled placeholder="Dial value"></label><button id="saveReading" disabled>Save</button></div><div class="actions workflow-actions"><button id="cw" disabled>Move CW</button><button id="ccw" disabled>Move CCW</button><button id="hold" class="danger" disabled>Hold motion</button><button id="done" class="secondary" disabled>Done</button></div><p class="hint">Save each reading before the next move. Done finishes the move sequence and releases this pinned panel; saved readings remain available below.</p><p class="hint">Hold interrupts a move. Recover using gSender and start a new session at known geometry; there is no automatic resume.</p><p role="status" id="status">Set up your indicator and start a session.</p></div></section>
<section class="panel"><h2>Dial readings</h2><p id="unitsNote" class="hint">Initial preload becomes reading 0. New moves add a row automatically.</p><div class="table-wrap"><table><thead><tr><th>Reading</th><th>Move</th><th>Spindle position</th><th>Dial value</th><th>Change from preload</th><th>Status</th></tr></thead><tbody id="readings"></tbody></table></div></section>
<section class="panel"><h2>Understanding tilt and nod</h2><figure class="tilt-nod-figure"><img src="${tiltNodImage}" alt="Front view: tilt is spindle alignment across X. Side view: nod is spindle alignment across Y."><figcaption><strong>Tilt</strong> is the X-axis comparison (X+ to X-). <strong>Nod</strong> is the Y-axis comparison (Y+ to Y-).</figcaption></figure><p class="hint">This diagram describes the axis terminology. The plugin still measures by revolving the Z-carriage around a fixed indicator contact point.</p></section>
<section class="panel"><h2>Calculate tilt, nod, and correction</h2><div class="grid"><label>Effective X adjustment span (mm, optional)<input id="xSpan" type="number" min="0.001" step="any" placeholder="Leave blank for tram error only"></label><label>Effective Y adjustment span (mm, optional)<input id="ySpan" type="number" min="0.001" step="any" placeholder="Leave blank for tram error only"></label></div><p class="hint">X+ versus X- gives tilt. Y+ versus Y- gives nod. Three non-collinear samples fit the 3D plane; 45 degree moves add diagonal samples. Adjustment spans estimate equivalent height correction; actual screw direction depends on the mount and dial orientation.</p><button id="calculate" disabled>Calculate tilt / nod and correction</button><div id="result" aria-live="polite"></div></section>
<section id="visual" class="panel" hidden><div class="visual-heading"><h2>3D tram error plane</h2><span id="gainLabel">250x display exaggeration</span></div><label>Visual exaggeration<input id="gain" type="range" min="1" max="1000" value="250" step="1"></label><svg id="plane" viewBox="-180 -165 360 330" role="img" aria-label="Exaggerated three dimensional dial error plane"></svg><p class="hint">Colored plane: best fit to the measured dial readings. Dots show recorded sample locations, including diagonal positions from 45 degree moves. Dashed plane: zero error. Exaggeration changes the picture only. This is a tram visualization, not a surface height map.</p></section>`;

let result=null, lastArc=null, sessionDone=false;
const sideLabel=side=>({east:'X+',south:'Y-',west:'X-',north:'Y+',southeast:'X+ / Y-',southwest:'X- / Y-',northwest:'X- / Y+',northeast:'X+ / Y+'}[side]||side.toUpperCase());
const finiteReading=value=>value!=='' && Number.isFinite(Number(value));
const session=new TrammingSession({machine,redux,onChange:render});
const settings=()=>({radius:Number($('radius').value),feed:Number($('feed').value),start:$('start').value,degrees:Number($('degrees').value),preload:$('preload').value,readingUnits:$('readingUnits').value});
const persistedSettingIds=['radius','feed','start','degrees','preload','readingUnits','xSpan','ySpan','gain'];
const settingsKey='spindleTramming.settings';
let settingsWriteQueue=Promise.resolve(), settingsSaveTimer;
function currentPersistentSettings(){return Object.fromEntries(persistedSettingIds.map(id=>[id,$(id).value]));}
function validSavedSetting(id,value){
 if(id==='start')return ['east','south','west','north'].includes(value);
 if(id==='degrees')return ['45','90'].includes(String(value));
 if(id==='readingUnits')return ['mm','in'].includes(value);
 if(id==='xSpan'||id==='ySpan')return value==='' || Number.isFinite(Number(value))&&Number(value)>0;
 if(id==='gain')return Number.isInteger(Number(value))&&Number(value)>=1&&Number(value)<=1000;
 if(id==='radius')return Number.isFinite(Number(value))&&Number(value)>0&&Number(value)<=1000;
 if(id==='feed')return Number.isFinite(Number(value))&&Number(value)>0&&Number(value)<=10000;
 if(id==='preload')return value!==''&&Number.isFinite(Number(value));
 return false;
}
async function restorePersistentSettings(){
 try{
  const saved=await storage.get(settingsKey,{});
  if(saved&&typeof saved==='object')for(const id of persistedSettingIds)if(Object.hasOwn(saved,id)&&validSavedSetting(id,saved[id]))$(id).value=String(saved[id]);
  $('settingsStatus').textContent=saved&&Object.keys(saved).length?'Saved settings restored from this device. Safety confirmation and measurement readings start fresh.':'Settings save automatically on this device in gSender.';
 }catch(error){$('settingsStatus').textContent=`Could not load saved settings: ${error.message}`;}
 render();
}
function savePersistentSettings(){
 const values=currentPersistentSettings();
 settingsWriteQueue=settingsWriteQueue.catch(()=>{}).then(()=>storage.set(settingsKey,values)).then(()=>{
  $('settingsStatus').textContent='Settings saved on this device in gSender.';
 }).catch(error=>{
  $('settingsStatus').textContent=`Could not save settings: ${error.message}`;
 });
 return settingsWriteQueue;
}
function scheduleSettingsSave(){
 clearTimeout(settingsSaveTimer);
 settingsSaveTimer=setTimeout(()=>void savePersistentSettings(),250);
}
const f=(value,digits=5)=>Number(value).toFixed(digits);
function clearResult(){result=null;$('result').replaceChildren();$('visual').hidden=true;}
function syncButtons(){
 const last=session.rows.at(-1);
 const enabled=session.active && !sessionDone && !session.moving && !session.fault && last && last.saved!==false && finiteReading(last.reading);
 $('cw').disabled=!enabled;$('ccw').disabled=!enabled;
 $('latestReading').disabled=!last || session.moving || last.status!=='Ready' || session.fault;
 $('saveReading').disabled=!last || session.moving || last.status!=='Ready' || session.fault || last.saved!==false || !finiteReading(last.reading);
 $('done').disabled=!session.active || sessionDone || session.moving || session.fault;
 $('latestLabel').textContent=last?`Reading ${last.id} at ${sideLabel(last.side)}`:'Start a session to enter readings here.';
 $('calculate').disabled=session.moving || !session.rows.some(r=>r.status==='Ready');
 $('hold').disabled=!session.moving || !session.active;
 $('begin').disabled=session.moving || session.active&&!sessionDone;
 $('config').disabled=session.active&&!sessionDone || session.moving;
 $('ready').disabled=session.moving || session.active&&!sessionDone;
 $('workflow').classList.toggle('pinned',session.active&&!sessionDone&&!session.fault);
}
function render(){
 syncButtons();
 const side=session.side || $('start').value;
 const angles={east:0,southeast:45,south:90,southwest:135,west:180,northwest:225,north:270,northeast:315};
 const points=Object.fromEntries(Object.entries(angles).map(([name,angle])=>{const rad=angle*Math.PI/180;return[name,[60*Math.cos(rad),60*Math.sin(rad)]];}));
 const point=points[side];
 $('marker').setAttribute('cx',point[0]);$('marker').setAttribute('cy',point[1]);
 $('arm').setAttribute('x2',point[0]);$('arm').setAttribute('y2',point[1]);
 $('circle').classList.toggle('uncertain',session.fault);
 $('position').textContent=session.fault?'Position uncertain - start a new session':session.moving?`Operation in progress - last verified position ${sideLabel(side)}`:sessionDone?`Move sequence complete at ${sideLabel(side)}`:session.active?`Current spindle position: ${sideLabel(side)}`:'No active session';
 $('latestReading').value=session.rows.at(-1)?.reading ?? '';
 if(lastArc){const a=points[lastArc.start],b=points[lastArc.end];$('arc').setAttribute('d',`M ${a} A 60 60 0 0 ${lastArc.clockwise?1:0} ${b}`);}else $('arc').setAttribute('d','');
 $('unitsNote').textContent=`Dial readings: ${session.config?.readingUnits || $('readingUnits').value}. Initial preload is reading 0. Enter absolute dial values; differences are calculated automatically.`;
 $('readings').replaceChildren(...session.rows.map(row=>{
  const tr=document.createElement('tr');
  for(const value of [row.id,row.turn,sideLabel(row.side)]){const td=document.createElement('td');td.textContent=value;tr.append(td);}
  const td=document.createElement('td');td.dataset.reading=row.id;
  if(row===session.rows.at(-1))td.textContent=row.saved===false?(row.reading?`${row.reading} (unsaved)`:'Enter above'):(row.reading || '--');
  else if(row.status==='Ready'){
   const input=document.createElement('input');input.type='number';input.step='any';input.value=row.reading;input.dataset.row=row.id;input.setAttribute('aria-label',`Reading ${row.id} ${row.side}`);input.disabled=session.moving;td.append(input);
  }else td.textContent=row.reading || '--';
  tr.append(td);
  const delta=document.createElement('td');delta.dataset.delta=row.id;
  delta.textContent=finiteReading(row.reading)?f(Number(row.reading)-session.config.preload):'--';tr.append(delta);
  const status=document.createElement('td');status.textContent=row.status;tr.append(status);
  return tr;
 }));
}
$('latestReading').addEventListener('input',event=>{
 const row=session.rows.at(-1);if(!row || row.status!=='Ready')return;
 row.reading=event.target.value;row.saved=false;
 const cell=document.querySelector(`[data-reading="${row.id}"]`);if(cell)cell.textContent=row.reading?`${row.reading} (unsaved)`:'Enter above';
 const delta=document.querySelector(`[data-delta="${row.id}"]`);if(delta)delta.textContent=finiteReading(row.reading)?f(Number(row.reading)-session.config.preload):'--';
 clearResult();syncButtons();
});
$('saveReading').onclick=()=>{
 const row=session.rows.at(-1);if(!row || !finiteReading(row.reading)){ $('status').textContent='Enter a finite dial reading before saving.';return; }
 row.saved=true;const cell=document.querySelector(`[data-reading="${row.id}"]`);if(cell)cell.textContent=row.reading;
 $('status').textContent=`Saved reading ${row.id} at ${sideLabel(row.side)}. Choose the next move when ready.`;syncButtons();
};
$('done').onclick=()=>{
 sessionDone=true;render();$('status').textContent='Move sequence finished and panel released. Save any pending reading; saved readings remain available below.';
};
$('readings').addEventListener('input',event=>{
 const row=session.rows[Number(event.target.dataset.row)];if(!row)return;
 row.reading=event.target.value;
 document.querySelector(`[data-delta="${row.id}"]`).textContent=finiteReading(row.reading)?f(Number(row.reading)-session.config.preload):'--';
 clearResult();syncButtons();
});
$('settings').addEventListener('submit',event=>event.preventDefault());
$('settings').addEventListener('input',()=>{if(!session.active || sessionDone){$('ready').checked=false;render();}});
for(const id of persistedSettingIds){
 $(id).addEventListener('input',scheduleSettingsSave);
 $(id).addEventListener('change',()=>{clearTimeout(settingsSaveTimer);void savePersistentSettings();});
}
$('begin').onclick=async()=>{
 await settingsReady;
 if(!$('ready').checked){$('status').textContent='Check the setup confirmation before starting.';return;}
 sessionDone=false;
 clearResult();lastArc=null;
 try{await session.begin(settings());$('status').textContent='Session ready. The initial reading is recorded. Choose Move CW or Move CCW.';}
 catch(error){$('status').textContent=error.message;}
};
async function move(clockwise){
 clearResult();const start=session.side;
 $('status').textContent='Validating machine and moving. Wait for endpoint verification.';
 try{
  const row=await session.move(clockwise);lastArc={start,end:row.side,clockwise};render();
  $('status').textContent=`Move complete at ${sideLabel(row.side)}. Enter the dial reading in row ${row.id}.`;
  $('latestReading').focus();
 }catch(error){$('status').textContent=error.message;}
}
$('cw').onclick=()=>move(true);$('ccw').onclick=()=>move(false);
$('hold').onclick=async()=>{try{await session.hold();$('status').textContent='Hold requested. Position is uncertain. Recover in gSender and start a new session.';}catch(error){$('status').textContent=`Hold request failed: ${error.message}. Use the machine stop controls.`;}};
function addText(parent,tag,text,className){const node=document.createElement(tag);node.textContent=text;if(className)node.className=className;parent.append(node);return node;}
$('calculate').onclick=()=>{
 clearResult();
 try{
  result=analyzeReadings(session.rows,{radius:session.config.radius,readingUnits:session.config.readingUnits,xSpan:$('xSpan').value,ySpan:$('ySpan').value});
  for(const [axis,name,pair] of [['X','Tilt',result.x],['Y','Nod',result.y]]){
  if(!pair){addText($('result'),'p',`${axis} axis: opposite reading pair is missing.`);continue;}
   addText($('result'),'h3',`${name} (axis ${axis}): ${sideLabel(pair.positive)} versus ${sideLabel(pair.negative)}`);
   addText($('result'),'p',`Dial difference ${f(pair.difference)} mm across ${f(2*result.radius,2)} mm diameter. Equivalent angular error ${f(pair.angleDegrees,6)} degrees.`);
   const units=session.config.readingUnits,scale=units==='in'?25.4:1;
   addText($('result'),'p',`Recommended target: bring the two side readings together. Current pair mean is ${f(pair.target/scale)} ${units}; the positive-side reading differs from that mean by ${f(pair.difference/(2*scale))} ${units}.`);
   if(pair.correction!==null)addText($('result'),'p',`Equivalent correction across ${f(pair.span,2)} mm effective ${axis} span: ${f(pair.correction)} mm. Direction at a particular adjustment screw depends on the pivot, mounting layout, and indicator orientation.`);
  }
  if(result.complete){
   addText($('result'),'p',`Combined tilt ${f(result.totalAngleDegrees,6)} degrees. Equivalent maximum opposite-side dial difference ${f(result.diameterError)} mm.`,'result-total');
   $('visual').hidden=false;drawPlane();
  }else addText($('result'),'p','Collect readings from at least three non-collinear spindle positions to display the 3D error plane. Opposite pairs are still needed for the X and Y comparison values.');
  const repeats=Object.entries(result.ranges).filter(([side])=>result.counts[side]>1);
  if(repeats.length)addText($('result'),'p',`Repeated sides use their mean. Reading spread: ${repeats.map(([side,range])=>`${side.toUpperCase()} ${f(range)} mm`).join('; ')}. Large spread can indicate tracking or setup drift.`);
  if(session.rows.at(-1)?.saved===false)addText($('result'),'p','The newest reading has not been saved and is excluded from this calculation.');
  if(session.fault)addText($('result'),'p','Session was interrupted. Results use only previously verified reading rows; remeasure before making adjustments.');
 }catch(error){addText($('result'),'p',error.message);}
};
for(const id of ['xSpan','ySpan'])$(id).addEventListener('input',clearResult);
function drawPlane(){
 if(!result?.complete)return;
 const gain=Number($('gain').value),model=planeModel(result,gain),r=result.radius;
 const maxHeight=Math.max(...model.vertices.map(v=>Math.abs(v.displayZ/r)),...model.samples.map(v=>Math.abs(v.displayZ/r)));
 const zoom=90/Math.max(1,maxHeight*0.85);
 const project=(v,flat=false)=>[(v.x/r+v.y/r)*0.78*zoom,(v.x/r-v.y/r)*0.35*zoom-(flat?0:v.displayZ/r)*zoom];
 const points=(vertices,flat=false)=>vertices.map(v=>project(v,flat).join(',')).join(' ');
 const ns='http://www.w3.org/2000/svg',svg=$('plane');svg.replaceChildren();
 const shape=(tag,attributes,text)=>{const node=document.createElementNS(ns,tag);for(const [key,value]of Object.entries(attributes))node.setAttribute(key,value);if(text)node.textContent=text;svg.append(node);return node;};
 shape('polygon',{points:points(model.vertices,true),class:'reference-plane'});
 for(const v of model.vertices){const a=project(v,true),b=project(v);shape('line',{x1:a[0],y1:a[1],x2:b[0],y2:b[1],class:'height-line'});}
 shape('polygon',{points:points(model.vertices),class:'error-plane'});
 // Grid on the tilted plane provides depth cues without changing the data.
 for(const t of [-0.5,0,0.5]){
  for(const vertical of [true,false]){
   const vertices=[-1,1].map(end=>{const x=(vertical?t:end)*r,y=(vertical?end:t)*r;return{x,y,displayZ:(result.plane.xSlope*x+result.plane.ySlope*y)*gain};});
   const [a,b]=vertices.map(v=>project(v));shape('line',{x1:a[0],y1:a[1],x2:b[0],y2:b[1],class:'plane-grid'});
  }
 }
 for(const [side,v]of Object.entries(model.markers).filter(([side])=>result.counts[side])){
  const p=project(v);shape('circle',{cx:p[0],cy:p[1],r:4,class:v.z>=0?'positive-height':'negative-height'});
   if(['east','south','west','north'].includes(side))shape('text',{x:p[0]+7,y:p[1]-8,class:'plane-label'},`${sideLabel(side)} ${f(v.z,4)} mm`);
 }
 for(const v of model.samples){const p=project(v),dot=shape('circle',{cx:p[0],cy:p[1],r:2.5,class:'sample-point'});shape('title',{},`${v.side.toUpperCase()} measured ${f(v.reading,4)} mm`);dot.append(svg.lastChild);}
 $('gainLabel').textContent=`${gain}x display exaggeration`;
}
$('gain').addEventListener('input',drawPlane);
// Best effort if the user closes this view during a direct move. A hardware
// stop and the host controls remain authoritative; navigation is not a resume.
window.addEventListener('pagehide',()=>{
 clearTimeout(settingsSaveTimer);
 void savePersistentSettings();
 if(session.moving && session.active)void session.hold().catch(()=>{});
});
render();
const settingsReady=restorePersistentSettings();

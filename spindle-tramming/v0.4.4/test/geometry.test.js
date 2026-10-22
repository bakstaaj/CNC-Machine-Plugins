import {test} from 'node:test';
import assert from 'node:assert/strict';
import {plan,planSequence,directions,controllerMessage,assertAsciiGcode} from '../src/geometry.js';
test('all arc combinations preserve radius and expected direction',()=>{
 for(const start of directions)for(const clockwise of [true,false])for(const degrees of [45,90]){
  const p=plan({radius:50,feed:300,start,clockwise,degrees});
  assert.equal(Math.hypot(p.x,p.y),50);assert.equal(Math.hypot(p.ex,p.ey),50);
  assert.equal(p.end,directions[(directions.indexOf(start)+(clockwise?1:-1)*degrees/45+directions.length)%directions.length]);
  assert.ok(!/\bZ[-\d]/.test(p.command));
 }
});
test('east clockwise quarter arc moves down and left',()=>{
 assert.match(plan({radius:50,feed:300,start:'east',clockwise:true,degrees:90}).command,/G2 X-50.0000 Y-50.0000 I-50.0000 J0.0000/);
});
test('45 degree moves reach diagonal positions',()=>{
 const p=plan({radius:50,feed:300,start:'east',clockwise:true,degrees:45});
 assert.equal(p.end,'southeast');assert.ok(Math.abs(Math.hypot(p.ex,p.ey)-50)<1e-10);
 assert.match(p.command,/G2 X-14\.6447 Y-35\.3553 I-50\.0000 J0\.0000/);
});

const defaults={radius:50,feed:300,start:'east',clockwise:true,degrees:90,moves:4,alternate:false};

// Interpret emitted coordinates rather than trusting the segment metadata:
// every arc must stay centered on the original contact point and every pause
// must follow a completed arc at the expected physical cardinal position.
function interpret(gcode,radius,start) {
 const point=side=>{const angle=directions.indexOf(side)*Math.PI/4;return[radius*Math.cos(angle),-radius*Math.sin(angle)];};
 let [x,y]=point(start),relative=false;
 const pauses=[],arcs=[];
 for(const raw of gcode.split('\n')) {
  const line=raw.replace(/\([^)]*\)/g,'').split(';')[0].trim();
  const words=line.split(/\s+/);
  if(words.includes('G90'))relative=false;
  if(words.includes('G91'))relative=true;
  if(words.includes('G2') || words.includes('G3')) {
   assert.equal(relative,true,'arc endpoints must be relative');
   const number=letter=>Number(words.find(w=>w.startsWith(letter)).slice(1));
   const center=[x+number('I'),y+number('J')];
   assert.ok(Math.abs(center[0])<1e-3 && Math.abs(center[1])<1e-3,'center must remain fixed within coordinate rounding');
   x+=number('X');y+=number('Y');
   assert.ok(Math.abs(Math.hypot(x,y)-radius)<1e-3,'endpoint must stay on circle within coordinate rounding');
   arcs.push([x,y]);
  }
  if(words.includes('M0')) {
   assert.equal(relative,false,'pause in G90');
   pauses.push([x,y]);
  }
 }
 return {pauses,arcs};
}

test('default full run includes starting reading, all four sides, and closing reading',()=>{
 const run=planSequence(defaults);
 assert.deepEqual(run.positions,['east','south','west','north','east']);
 assert.equal(run.pauseCount,5);
 assert.deepEqual(interpret(run.gcode,50,'east').pauses,[[50,0],[0,-50],[-50,0],[0,50],[50,0]]);
 assert.equal(run.gcode.match(/^M2$/gm).length,1);
 assert.match(run.gcode,/Reading 4 of 4 EAST.*Resume to end program/);
});

test('emitted full-run arcs preserve center and pause positions across all selections',()=>{
 for(const start of directions)for(const clockwise of [true,false])for(const degrees of [45,90])for(const alternate of [true,false])for(const moves of [1,2,4,7]) {
  const run=planSequence({...defaults,start,clockwise,degrees,alternate,moves});
  const actual=interpret(run.gcode,50,start);
  assert.equal(actual.arcs.length,moves);assert.equal(actual.pauses.length,moves+1);
  run.positions.forEach((side,i)=>{const angle=directions.indexOf(side)*Math.PI/4,expected=[50*Math.cos(angle),-50*Math.sin(angle)];assert.ok(Math.abs(actual.pauses[i][0]-expected[0])<1e-8);assert.ok(Math.abs(actual.pauses[i][1]-expected[1])<1e-8);});
  assert.equal(run.gcode.match(/^M0 ;Reading /gm).length,moves+1);
  assert.ok(!/[^\x20-\x7E\n]/.test(run.gcode),'machine file must be ASCII only');
  for(const comment of run.gcode.matchAll(/\(([^)]*)\)|;([^\n]*)/g)) {
    assert.match(comment[1] ?? comment[2],/^[A-Za-z0-9. ]+$/,'messages must exclude hyphens, Unicode, and other punctuation');
  }
  assert.ok(!/\b(?:Z|M3|M4|G0)\b/.test(run.gcode));
 }
});

test('eight 45 degree moves visit every position around the circle',()=>{
 const run=planSequence({...defaults,degrees:45,moves:8});
 assert.deepEqual(run.positions,['east','southeast','south','southwest','west','northwest','north','northeast','east']);
 assert.equal(run.segments.length,8);
});

test('initial M0 clears Edge2 early-pause threshold even when comments are removed',()=>{
 const commands=planSequence(defaults).gcode.split('\n').map(l=>l.replace(/\([^)]*\)/g,'').split(';')[0].trim()).filter(Boolean);
 const firstPause=commands.indexOf('M0');
 assert.ok(firstPause>10,'Edge2 requires sent > 10 at initial M0');
 assert.ok(commands.slice(0,firstPause).every(l=>/^(G21|G17|G90|G94|G4 P0)$/.test(l)),'setup must contain no axis movement');
 assert.equal(commands.at(-1),'M2');
});

test('invalid run lengths and selections are rejected',()=>{
 for(const moves of [0,-1,1.5,NaN,Infinity,101])assert.throws(()=>planSequence({...defaults,moves}));
 assert.throws(()=>planSequence({...defaults,alternate:'true'}));
 assert.throws(()=>planSequence({...defaults,start:'center'}));
 assert.throws(()=>planSequence({...defaults,degrees:360}));
 assert.equal(planSequence({...defaults,moves:100}).segments.length,100);
});
test('reject invalid geometry and feed',()=>{
 for(const radius of [0,-1,NaN,Infinity,1001])assert.throws(()=>plan({radius,feed:300,start:'east',clockwise:true,degrees:90}));
 for(const feed of [0,-1,NaN,Infinity,10001])assert.throws(()=>plan({radius:50,feed,start:'east',clockwise:true,degrees:90}));
});

test('controller messages remove Unicode and hyphens without altering numeric minus signs',()=>{
 assert.equal(controllerMessage('Reading 1/4: SOUTH \u2014 90\u00b0 - resume \u2192 next'),'Reading 1 4 SOUTH 90 resume next');
 const run=planSequence(defaults);
 assert.match(run.gcode,/\(Move 2 of 4 south to west clockwise\)/);
 assert.match(run.gcode,/G2 X-50.0000 Y-50.0000 I-50.0000/);
 assert.doesNotThrow(()=>assertAsciiGcode(run.gcode));
 for(const invalid of ['G21\n(90\u00b0)','\uFEFFG21','M0 ;Resume\u2014next','G21\x00'])assert.throws(()=>assertAsciiGcode(invalid));
});

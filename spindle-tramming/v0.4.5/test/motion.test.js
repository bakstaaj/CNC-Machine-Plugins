import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TrammingSession,assertIdle,positionFromSnapshot} from '../src/motion.js';
const config={radius:50,feed:300,start:'east',degrees:90,preload:'1',readingUnits:'mm'};
function harness(){
 const snapshot={connection:{isConnected:true},pluginState:{busy:false},controller:{workflow:{state:'idle'},state:{status:{activeState:'Idle'}},feeder:{status:{pending:false,queue:0,hold:false}},mpos:{x:100,y:100,z:20},wpos:{x:0,y:0,z:0}}};
 const queries=[],commands=[];let target=null;
 const machine={
  query:async cmd=>{
   queries.push(cmd);
   if(cmd==='$G')return {complete:true,ok:true,lines:['[GC:G0 G54 G17 G21 G90 G94 M5]','ok']};
   if(/^G[23] /.test(cmd)){
    const word=key=>Number(cmd.match(new RegExp(`${key}([-\\d.]+)`))[1]);
    target=structuredClone(snapshot.controller);
    for(const frame of ['mpos','wpos']){target[frame].x+=word('X');target[frame].y+=word('Y');}
   }
   if(cmd==='G4 P0' && target){snapshot.controller.mpos=target.mpos;snapshot.controller.wpos=target.wpos;target=null;}
   return {complete:true,ok:true,lines:['ok']};
  },
  command:async(...args)=>commands.push(args),
  setBusy:async value=>{snapshot.pluginState.busy=value;},
 };
 const session=new TrammingSession({machine,redux:{getState:async()=>structuredClone(snapshot)}});
 return {session,machine,snapshot,queries,commands};
}
test('CW and CCW moves add reading rows only after validation and verify the endpoints',async()=>{
 const h=harness();await h.session.begin(config);
 assert.equal(h.session.rows[0].reading,'1');
 await h.session.move(true);
 assert.equal(h.session.side,'south');assert.equal(h.session.rows[1].status,'Ready');assert.equal(h.session.rows[1].turn,'CW');
 assert.deepEqual(h.queries.slice(-4),['G21 G17 G91 G94','G2 X-50.0000 Y-50.0000 I-50.0000 J0.0000 F300.0000','G4 P0','G90']);
 await assert.rejects(h.session.move(false),/Save the current dial reading/);
 h.session.rows[1].reading='1.1';await h.session.move(false);
 assert.equal(h.session.side,'east');assert.equal(h.session.rows[2].turn,'CCW');
 assert.equal(h.snapshot.controller.mpos.x,100);assert.equal(h.snapshot.controller.mpos.y,100);
 assert.equal(h.snapshot.pluginState.busy,false);
 assert.ok(h.queries.every(s=>!/[\u0080-\uFFFF]/.test(s)));
});
test('delivery does not advance position while waiting for the completion dwell',async()=>{
 const h=harness();await h.session.begin(config);
 const original=h.machine.query;let release,entered;
 const waiting=new Promise(r=>entered=r);
 h.machine.query=async cmd=>{if(cmd==='G4 P0'){entered();await new Promise(r=>release=r);}return original(cmd);};
 const moving=h.session.move(true);await waiting;
 assert.equal(h.session.side,'east');assert.equal(h.session.rows[1].status,'Moving');
 await assert.rejects(h.session.move(false),/already in progress/);
 release();await moving;assert.equal(h.session.side,'south');
});
test('alarm, host job, disconnect, and feeder activity prevent motion',()=>{
 for(const change of [s=>s.connection.isConnected=false,s=>s.controller.workflow.state='paused',s=>s.controller.state.status.activeState='Alarm',s=>s.controller.feeder.status.pending=true,s=>s.pluginState.busy=true]){
  const h=harness();change(h.snapshot);assert.throws(()=>assertIdle(h.snapshot));
 }
});
test('position and offset changes invalidate the session without sending an arc',async()=>{
 const h=harness();await h.session.begin(config);h.snapshot.controller.wpos.x=5;
 await assert.rejects(h.session.move(true),/position or work offset changed/);
 assert.equal(h.session.fault,true);assert.equal(h.session.rows.length,1);
 assert.ok(!h.queries.some(q=>/^G[23] /.test(q)));
});
test('controller errors request hold and preserve last known side',async()=>{
 const h=harness();await h.session.begin(config);
 const original=h.machine.query;h.machine.query=async cmd=>/^G[23] /.test(cmd)?{complete:true,ok:false,error:'error:9',lines:['error:9']}:original(cmd);
 await assert.rejects(h.session.move(true),/error:9/);
 assert.equal(h.session.side,'east');assert.equal(h.session.rows[1].status,'Failed');assert.equal(h.session.active,false);
 assert.deepEqual(h.commands,[['feedhold']]);assert.equal(h.snapshot.pluginState.busy,false);
});
test('a hold during the dwell prevents subsequent G90 or position advancement',async()=>{
 const h=harness();await h.session.begin(config);const original=h.machine.query;
 let release,entered;const waiting=new Promise(r=>entered=r);
 h.machine.query=async cmd=>{if(cmd==='G4 P0'){entered();await new Promise(r=>release=r);}return original(cmd);};
 const pending=h.session.move(true);await waiting;await h.session.hold();release();
 await assert.rejects(pending,/interrupted/);assert.equal(h.session.side,'east');assert.equal(h.session.rows[1].status,'Failed');
 assert.ok(!h.queries.includes('G90'));
});
test('position reader uses normalized Redux millimeters, not raw inch status',()=>{
 const h=harness();h.snapshot.controller.state.status.mpos={x:100/25.4,y:100/25.4,z:20/25.4};
 assert.deepEqual(positionFromSnapshot(h.snapshot).machine,{x:100,y:100,z:20});
});

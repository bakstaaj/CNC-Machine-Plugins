import {plan,assertAsciiGcode} from './geometry.js';

export function positionFromSnapshot(snapshot) {
  const c=snapshot?.controller;
  const read=p=>{
    if(!p || ['x','y','z'].some(k=>p[k]===undefined || p[k]===null || p[k]==='' || !Number.isFinite(Number(p[k]))))throw Error('Machine position is unavailable.');
    return Object.fromEntries(['x','y','z'].map(k=>[k,Number(p[k])]));
  };
  // These top-level Redux positions are normalized to millimeters by Edge2,
  // unlike controller.state.status positions which follow firmware $13 units.
  return {machine:read(c?.mpos),work:read(c?.wpos)};
}

export function assertIdle(snapshot,{ownBusy=false}={}) {
  if(!snapshot?.connection?.isConnected)throw Error('Connect the machine before moving.');
  const c=snapshot.controller;
  if(c?.workflow?.state!=='idle')throw Error('Finish or stop the host job first.');
  if(c?.state?.status?.activeState!=='Idle')throw Error('Machine must be Idle and unlocked.');
  const feeder=c.feeder?.status;
  if(!feeder || feeder.pending || feeder.queue>0 || feeder.hold)throw Error('The host feeder is busy or unavailable.');
  if(snapshot.pluginState?.busy && !ownBusy)throw Error('Another plugin operation is busy.');
  return positionFromSnapshot(snapshot);
}

export function samePosition(a,b,tolerance=0.02) {
  return ['machine','work'].every(frame=>['x','y','z'].every(axis=>Math.abs(a[frame][axis]-b[frame][axis])<=tolerance));
}

export class TrammingSession {
  constructor({machine,redux,onChange=()=>{},sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=()=>Date.now()}) {
    Object.assign(this,{machine,redux,onChange,sleep,now});
    this.rows=[];this.active=false;this.moving=false;this.fault=false;this.side=null;this.token=0;
  }
  changed(){this.onChange(this);}
  async checkedQuery(command,timeout=10000) {
    assertAsciiGcode(command);
    const response=await this.machine.query(command,{timeout,maxLines:100});
    if(!response?.complete || !response.ok || response.error)throw Error(response?.error || `Controller did not acknowledge ${command}. ${response?.reason||''}`);
    return response;
  }
  async checkSpindle() {
    const result=await this.checkedQuery('$G');
    const report=result.lines.find(l=>/^\[GC:/.test(l));
    if(!report || !/\bM5\b/.test(report))throw Error('Controller must report spindle off M5 before moving.');
    if(/\bG90\.1\b/.test(report))throw Error('Absolute I J centers are unsupported. Select incremental arc centers first.');
  }
  async begin(config) {
    if(this.moving)throw Error('Wait for the current operation.');
    plan({...config,start:config.start,clockwise:true});
    if(config.preload==='' || !Number.isFinite(Number(config.preload)))throw Error('Enter a finite initial preload reading.');
    this.moving=true;this.active=false;this.fault=false;this.changed();
    try {
      assertIdle(await this.redux.getState());
      await this.checkSpindle();
      this.position=assertIdle(await this.redux.getState());
      this.config={...config,preload:Number(config.preload)};this.side=config.start;
      this.rows=[{id:0,side:this.side,turn:'Start',reading:String(config.preload),status:'Ready',saved:true}];
      this.active=true;
    } finally {this.moving=false;this.changed();}
  }
  async move(clockwise) {
    if(this.moving)throw Error('A move is already in progress.');
    if(!this.active || this.fault)throw Error('Start a new measurement session first.');
    const last=this.rows.at(-1);
    if(last.saved===false || last.reading.trim()==='' || !Number.isFinite(Number(last.reading)))throw Error('Save the current dial reading before the next move.');
    const arc=plan({...this.config,start:this.side,clockwise});
    const token=++this.token;
    const checkCancelled=()=>{if(token!==this.token)throw Error('Move interrupted. Restore the starting geometry and begin a new session.');};
    this.moving=true;this.changed();
    let row,arcSubmitted=false,motionCompleted=false,busy=false;
    try {
      const before=assertIdle(await this.redux.getState());
      if(!samePosition(before,this.position))throw Error('Machine position or work offset changed. Begin a new session at the actual start.');
      await this.checkSpindle();checkCancelled();
      const latest=assertIdle(await this.redux.getState());
      if(!samePosition(latest,this.position))throw Error('Machine moved during setup validation. Begin a new session.');
      await this.machine.setBusy(true,'Spindle tramming');busy=true;checkCancelled();
      row={id:this.rows.length,side:arc.end,turn:clockwise?'CW':'CCW',reading:'',status:'Moving',saved:false};
      this.rows.push(row);this.changed();
      await this.checkedQuery('G21 G17 G91 G94');checkCancelled();
      arcSubmitted=true;
      await this.checkedQuery(arc.command);checkCancelled();
      const length=this.config.radius*this.config.degrees*Math.PI/180;
      const timeout=Math.min(1800000,Math.max(15000,length/this.config.feed*60000*3+10000));
      // Firmware acknowledges the dwell only after the planned arc finishes.
      await this.checkedQuery('G4 P0',Math.ceil(timeout));checkCancelled();
      motionCompleted=true;
      try {
        // G90 is idempotent, but a missing acknowledgement must not cause a
        // feed hold after the arc has already completed.
        await this.checkedQuery('G90',15000);
      } catch(error) {
        throw Error(`Motion finished, but the controller did not acknowledge G90. The command may have executed. Check gSender's modal state and restore absolute mode before any further movement or job. ${error.message}`);
      }
      checkCancelled();
      const expected=structuredClone(before);
      for(const frame of ['machine','work']){expected[frame].x+=arc.ex-arc.x;expected[frame].y+=arc.ey-arc.y;}
      const deadline=this.now()+5000;
      let verified=false;
      do {
        checkCancelled();
        const snapshot=await this.redux.getState();
        if(snapshot?.controller?.state?.status?.activeState==='Run') {
          if(!snapshot.connection?.isConnected || snapshot.controller?.workflow?.state!=='idle')throw Error('Connection or host job state changed.');
        } else {
          const actual=assertIdle(snapshot,{ownBusy:true});
          if(samePosition(actual,expected)){verified=true;break;}
        }
        await this.sleep(150);
      }while(this.now()<deadline);
      if(!verified)throw Error('Motion was acknowledged but the endpoint was not verified. Begin a new session.');
      this.side=arc.end;this.position=expected;row.status='Ready';
      return row;
    } catch(error) {
      this.fault=true;this.active=false;
      if(row)row.status='Failed';
      // Hold only when the arc may still be moving. Sending feedhold after
      // G4 P0 completed turns a modal-restore acknowledgement timeout into an
      // unnecessary host hold, even though the physical move has finished.
      if(arcSubmitted && !motionCompleted)await this.machine.command('feedhold').catch(()=>{});
      throw error;
    } finally {
      if(busy)await this.machine.setBusy(false).catch(()=>{});
      this.moving=false;this.changed();
    }
  }
  async hold() {
    ++this.token;this.fault=true;this.active=false;this.changed();
    await this.machine.command('feedhold');
  }
}

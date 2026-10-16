const validNumber=value=>value!=='' && value!==null && value!==undefined && Number.isFinite(Number(value));
export const sideAngles={east:0,southeast:45,south:90,southwest:135,west:180,northwest:225,north:270,northeast:315};

export function analyzeReadings(rows,{radius,readingUnits='mm',xSpan=null,ySpan=null}) {
  if(!Number.isFinite(radius) || radius<=0)throw Error('Radius must be positive.');
  if(!['mm','in'].includes(readingUnits))throw Error('Unknown reading units.');
  const factor=readingUnits==='in'?25.4:1;
  const groups=Object.fromEntries(Object.keys(sideAngles).map(side=>[side,[]]));
  for(const row of rows) {
    if(row.status==='Ready' && row.saved!==false && groups[row.side] && validNumber(row.reading))groups[row.side].push(Number(row.reading)*factor);
  }
  const means={};
  for(const [side,values] of Object.entries(groups)) {
    if(values.length)means[side]=values.reduce((sum,v)=>sum+v,0)/values.length;
  }
  const pair=(positive,negative,span)=>{
    if(means[positive]===undefined || means[negative]===undefined)return null;
    if(span!==null && span!=='' && (!Number.isFinite(Number(span)) || Number(span)<=0))throw Error('Adjustment span must be positive or blank.');
    const difference=means[positive]-means[negative];
    return {positive,negative,difference,slope:difference/(2*radius),angleDegrees:Math.atan(difference/(2*radius))*180/Math.PI,
      target:(means[positive]+means[negative])/2,
      span:span!==null && span!==''?Number(span):null,
      correction:span!==null && span!==''?Math.abs(difference)*Number(span)/(2*radius):null};
  };
  const x=pair('east','west',xSpan), y=pair('north','south',ySpan);
  if(!Object.values(groups).some(values=>values.length))throw Error('Enter at least one valid dial reading.');

  // Fit z = baseline + sx*x + sy*y to every valid reading. This uses diagonal
  // 45 degree samples as well as cardinal samples and gives a least-squares
  // plane when tracking noise or repeat readings are present.
  const samples=[];
  for(const [side,values] of Object.entries(groups)) {
    const angle=sideAngles[side]*Math.PI/180;
    for(const reading of values)samples.push({side,x:radius*Math.cos(angle),y:-radius*Math.sin(angle),reading});
  }
  const mean=(key)=>samples.reduce((sum,s)=>sum+s[key],0)/samples.length;
  const mx=mean('x'),my=mean('y'),mz=mean('reading');
  let xx=0,yy=0,xy=0,xz=0,yz=0;
  for(const s of samples){const dx=s.x-mx,dy=s.y-my,dz=s.reading-mz;xx+=dx*dx;yy+=dy*dy;xy+=dx*dy;xz+=dx*dz;yz+=dy*dz;}
  const determinant=xx*yy-xy*xy;
  const planeReady=samples.length>=3 && determinant>1e-10;
  const plane=planeReady?{xSlope:(xz*yy-yz*xy)/determinant,ySlope:(yz*xx-xz*xy)/determinant,baseline:mz}:null;
  const slope=plane?Math.hypot(plane.xSlope,plane.ySlope):null;
  const ranges=Object.fromEntries(Object.entries(groups).filter(([,a])=>a.length).map(([side,a])=>[side,Math.max(...a)-Math.min(...a)]));
  return {radius,means,counts:Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,v.length])),ranges,x,y,complete:planeReady,plane,
    samples:samples.map(s=>({...s,z:s.reading-mz})),
    totalAngleDegrees:plane?Math.atan(slope)*180/Math.PI:null,
    diameterError:plane?2*radius*slope:null};
}

// Equivalent dial-error plane, not a map of the table surface. The sample
// dots retain each actual reading while the colored plane is the best fit.
export function planeModel(result,exaggeration=100) {
  if(!result.complete || !result.plane)throw Error('The 3D plane needs at least three non-collinear spindle positions.');
  if(!Number.isFinite(exaggeration) || exaggeration<1 || exaggeration>1000)throw Error('Exaggeration must be between 1 and 1000.');
  const r=result.radius, {xSlope,ySlope}=result.plane;
  const height=(x,y)=>xSlope*x+ySlope*y;
  const vertex=(x,y)=>({x,y,z:height(x,y),displayZ:height(x,y)*exaggeration});
  const markers=Object.fromEntries(Object.keys(sideAngles).map(side=>{
    const a=sideAngles[side]*Math.PI/180;return [side,vertex(r*Math.cos(a),-r*Math.sin(a))];
  }));
  const samples=result.samples.map(s=>({...s,displayZ:s.z*exaggeration}));
  return {exaggeration,vertices:[vertex(-r,-r),vertex(r,-r),vertex(r,r),vertex(-r,r)],markers,samples};
}

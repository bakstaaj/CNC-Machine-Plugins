import {test} from 'node:test';
import assert from 'node:assert/strict';
import {analyzeReadings,planeModel} from '../src/analysis.js';
const row=(side,reading,status='Ready')=>({side,reading:String(reading),status});
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-10,`${a} versus ${b}`);
const data=[row('east',1.03),row('west',0.97),row('north',1.02),row('south',0.98)];
test('opposite readings recover known X and Y slopes regardless of preload',()=>{
 const result=analyzeReadings(data,{radius:50,xSpan:200,ySpan:150});
 close(result.x.difference,0.06);close(result.y.difference,0.04);
 close(result.x.slope,0.0006);close(result.y.slope,0.0004);
 close(result.x.correction,0.12);close(result.y.correction,0.06);
 close(result.totalAngleDegrees,Math.atan(Math.hypot(0.0006,0.0004))*180/Math.PI);
 const shifted=analyzeReadings(data.map(r=>({...r,reading:String(Number(r.reading)+12)})),{radius:50});
 close(shifted.x.difference,result.x.difference);close(shifted.y.difference,result.y.difference);
});
test('inches readings convert to millimeters before calculation',()=>{
 const result=analyzeReadings(data.map(r=>({...r,reading:String(Number(r.reading)/25.4)})),{radius:50,readingUnits:'in'});
 close(result.x.difference,0.06);close(result.y.difference,0.04);
});
test('one opposite pair yields one axis; two adjacent samples cannot define a plane',()=>{
 const result=analyzeReadings([row('east',0),row('west',0.1)],{radius:50});
 assert.equal(result.complete,false);assert.equal(result.y,null);
 assert.throws(()=>planeModel(result,100));
 const adjacent=analyzeReadings([row('east',0),row('south',0.1)],{radius:50});
 assert.equal(adjacent.complete,false);assert.throws(()=>planeModel(adjacent,100));
});
test('45 degree diagonal samples contribute to the fitted plane and appear on the map',()=>{
 const sides=['east','southeast','south','southwest','west','northwest','north','northeast'];
 const angles=[0,45,90,135,180,225,270,315];
 const rows=sides.map((side,i)=>{const a=angles[i]*Math.PI/180,x=50*Math.cos(a),y=-50*Math.sin(a);return row(side,3+0.001*x-0.0004*y);});
 const result=analyzeReadings(rows,{radius:50});
 close(result.plane.xSlope,0.001);close(result.plane.ySlope,-0.0004);assert.equal(result.complete,true);
 const model=planeModel(result,100);
 assert.equal(model.samples.length,8);assert.ok(model.markers.southeast);
});
test('ignore failed and blank rows; average repeated sides and report spread',()=>{
 const result=analyzeReadings([row('east',0),row('east',0.02),row('west',0),row('north',''),row('south',99,'Failed')],{radius:50});
 close(result.x.difference,0.01);close(result.ranges.east,0.02);
 assert.equal(result.counts.east,2);assert.equal(result.counts.north,0);assert.equal(result.counts.south,0);
 assert.throws(()=>analyzeReadings(data,{radius:50,xSpan:-10}));
});
test('exaggeration scales only display Z; true plane and correction remain unchanged',()=>{
 const result=analyzeReadings(data,{radius:50,xSpan:200,ySpan:200});
 const stored=JSON.stringify(result),a=planeModel(result,1),b=planeModel(result,1000);
 for(let i=0;i<4;i++){close(a.vertices[i].z,b.vertices[i].z);close(b.vertices[i].displayZ,1000*a.vertices[i].displayZ);}
 assert.equal(JSON.stringify(result),stored);
 close(a.markers.east.z,0.03);close(a.markers.north.z,0.02);
 assert.throws(()=>planeModel(result,0));assert.throws(()=>planeModel(result,1001));
});

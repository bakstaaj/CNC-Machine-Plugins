// Ordered clockwise from +X. Diagonal positions are used by 45 degree moves.
export const directions = ['east','southeast','south','southwest','west','northwest','north','northeast'];

// Keep operator messages deliberately narrower than ASCII: letters, digits,
// spaces, and decimal points only. Never apply this to executable coordinates.
export function controllerMessage(text) {
  return String(text).replace(/[^A-Za-z0-9. ]/g,' ').replace(/ +/g,' ').trim();
}

export function assertAsciiGcode(text) {
  if(typeof text !== 'string' || /[^\x20-\x7E\n]/.test(text)) {
    throw Error('Generated G-code must contain printable ASCII characters and line feeds only.');
  }
  return text;
}

export function plan({radius,feed,start,degrees,clockwise}) {
  if (!Number.isFinite(radius) || radius <= 0 || radius > 1000) throw Error('Radius must be greater than 0 and at most 1000 mm.');
  if (!Number.isFinite(feed) || feed <= 0 || feed > 10000) throw Error('Feed must be greater than 0 and at most 10000 mm/min.');
  if (!directions.includes(start) || ![45,90].includes(degrees) || typeof clockwise !== 'boolean') throw Error('Invalid arc selection.');
  const index = directions.indexOf(start);
  const endIndex = (index + (clockwise?1:-1)*degrees/45 + directions.length)%directions.length;
  const point=i=>{const angle=i*Math.PI/4;return [radius*Math.cos(angle),-radius*Math.sin(angle)];};
  const points=directions.map((_,i)=>point(i));
  const [x,y] = points[index], [ex,ey] = points[endIndex];
  const n = v => (Object.is(v,-0)?0:v).toFixed(4);
  const command = `${clockwise?'G2':'G3'} X${n(ex-x)} Y${n(ey-y)} I${n(-x)} J${n(-y)} F${n(feed)}`;
  return {command, start, end:directions[endIndex], clockwise, x,y,ex,ey};
}

export function planSequence({radius,feed,start,degrees,clockwise,moves=4,alternate=false}) {
  if (!Number.isInteger(moves) || moves < 1 || moves > 100) throw Error('Number of moves must be a whole number from 1 to 100.');
  if (typeof alternate !== 'boolean') throw Error('Invalid alternating direction selection.');
  const segments=[];
  let side=start, direction=clockwise;
  for(let i=0;i<moves;i++) {
    const segment=plan({radius,feed,start:side,degrees,clockwise:direction});
    segments.push(segment);
    side=segment.end;
    if(alternate)direction=!direction;
  }
  const lines=[
    `(${controllerMessage('Spindle tramming complete measurement sequence')})`,
    `(${controllerMessage(`Radius ${radius} mm ${moves} moves of ${degrees} degrees`)})`,
    `(${controllerMessage('Manually position at the selected start spindle power off')})`,
    // Edge2 Grbl/GrblHAL sender ignores M0 unless sent > 10.
    // Keep 11 real non-motion blocks before the first stop even if comments
    // are stripped. Zero-second dwells do not move any axis.
    `(${controllerMessage('Edge2 initial pause compatibility retain the setup blocks')})`,
    'G21', 'G17', 'G90', 'G94',
    ...Array(7).fill('G4 P0'),
    `M0 ;${controllerMessage(`Reading 0 of ${moves} ${start.toUpperCase()} record starting dial reading. Resume for move 1.`)}`,
  ];
  segments.forEach((segment,i)=>{
    lines.push(
      `(${controllerMessage(`Move ${i+1} of ${moves} ${segment.start} to ${segment.end} ${segment.clockwise?'clockwise':'counterclockwise'}`)})`,
      'G21 G17 G91 G94',
      segment.command,
      'G4 P0',
      'G90',
      `M0 ;${controllerMessage(`Reading ${i+1} of ${moves} ${segment.end.toUpperCase()} record dial reading. ${i+1===moves?'Sequence complete. Resume to end program.':`Resume for move ${i+2}.`}`)}`,
    );
  });
  lines.push('G90','M2','');
  return {gcode:assertAsciiGcode(lines.join('\n')),segments,positions:[start,...segments.map(s=>s.end)],end:side,moves,pauseCount:moves+1};
}

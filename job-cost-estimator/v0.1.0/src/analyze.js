const WORD = /([A-Za-z])\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/g;

function codeOnly(line) {
  let depth = 0;
  let code = '';
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '(') { depth += 1; continue; }
    if (character === ')') { depth = Math.max(0, depth - 1); continue; }
    if (character === ';' && depth === 0) break;
    if (depth === 0) code += character;
  }
  return code;
}

function wordsFor(line) {
  const words = [];
  WORD.lastIndex = 0;
  for (let match; (match = WORD.exec(line));) words.push({ letter: match[1].toUpperCase(), value: Number(match[2]) });
  return words;
}

const has = (words, letter) => words.some((word) => word.letter === letter);
const val = (words, letter) => words.find((word) => word.letter === letter)?.value;

function arcDistance(start, end, words, absoluteCenter, clockwise, units, warnings, lineNumber) {
  const i = val(words, 'I');
  const j = val(words, 'J');
  const r = val(words, 'R');
  if (i !== undefined || j !== undefined) {
    const center = absoluteCenter
      ? { x: i === undefined ? start.x : i * units, y: j === undefined ? start.y : j * units }
      : { x: start.x + (i ?? 0) * units, y: start.y + (j ?? 0) * units };
    const radiusStart = Math.hypot(start.x - center.x, start.y - center.y);
    const radiusEnd = Math.hypot(end.x - center.x, end.y - center.y);
    if (!Number.isFinite(radiusStart) || radiusStart < 0.0001) {
      warnings.add(`Line ${lineNumber}: arc radius could not be read; used a straight chord estimate.`);
      return Math.hypot(end.x - start.x, end.y - start.y);
    }
    let startAngle = Math.atan2(start.y - center.y, start.x - center.x);
    let endAngle = Math.atan2(end.y - center.y, end.x - center.x);
    let sweep = endAngle - startAngle;
    if (clockwise && sweep >= 0) sweep -= Math.PI * 2;
    if (!clockwise && sweep <= 0) sweep += Math.PI * 2;
    if (Math.hypot(end.x - start.x, end.y - start.y) < 0.0001) sweep = clockwise ? -Math.PI * 2 : Math.PI * 2;
    if (Math.abs(radiusStart - radiusEnd) > Math.max(0.2, radiusStart * 0.02)) {
      warnings.add(`Line ${lineNumber}: arc start/end radii differ; estimate uses the start radius.`);
    }
    return Math.abs(sweep) * radiusStart;
  }
  if (r !== undefined) {
    const chord = Math.hypot(end.x - start.x, end.y - start.y);
    const radius = Math.abs(r * units);
    if (radius < chord / 2 || chord < 0.0001) {
      warnings.add(`Line ${lineNumber}: R arc geometry is ambiguous; used a straight chord estimate.`);
      return chord;
    }
    const minorSweep = 2 * Math.asin(Math.min(1, chord / (2 * radius)));
    const majorArc = r < 0;
    return radius * (majorArc ? 2 * Math.PI - minorSweep : minorSweep);
  }
  warnings.add(`Line ${lineNumber}: arc has no I/J or R values; used a straight chord estimate.`);
  return Math.hypot(end.x - start.x, end.y - start.y);
}

/** Read-only, modal G-code time estimator. Coordinates and lengths are normalized to mm. */
export function analyzeGcode(text, settings = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Choose a non-empty G-code file.');
  if (text.length > 30 * 1024 * 1024) throw new Error('G-code files larger than 30 MB are not supported.');
  const settingNumber = (key, fallback) => Number.isFinite(Number(settings[key])) ? Number(settings[key]) : fallback;
  const rapidRate = Math.max(1, settingNumber('rapidRate', 3000));
  const manualToolSeconds = Math.max(0, settingNumber('manualToolSeconds', 90));
  const autoToolSeconds = Math.max(0, settingNumber('autoToolSeconds', 15));
  const pauseSeconds = Math.max(0, settingNumber('pauseSeconds', 30));
  const efficiency = Math.max(1, Number(settings.motionFactor) || 1.15);
  const safeZ = Number.isFinite(Number(settings.safeZ)) ? Number(settings.safeZ) : 5;
  const state = {
    unit: 1, absolute: true, centerAbsolute: false, feedMode: 94, plane: 17,
    motion: null, feed: null, x: 0, y: 0, z: 0,
    optimizedZ: 0, wcs: null,
  };
  const stats = {
    rapidDistance: 0, cuttingDistance: 0, rapidMinutes: 0, cuttingMinutes: 0,
    dwellSeconds: 0, pauseCount: 0, toolChanges: 0, motionBlocks: 0,
    xyRapidDistance: 0, xyRapidMinutes: 0, xyRapidMoveCount: 0, longestRapidXYMoves: [],
    zRapidDistance: 0, highSafeZMoves: 0, safeZPotentialSeconds: 0,
    safeZAnalysisValid: true,
    warnings: new Set(), tools: new Set(), xyBounds: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  };
  let sawAbsolutePosition = false;

  const setBounds = (point) => {
    stats.xyBounds.minX = Math.min(stats.xyBounds.minX, point.x);
    stats.xyBounds.minY = Math.min(stats.xyBounds.minY, point.y);
    stats.xyBounds.maxX = Math.max(stats.xyBounds.maxX, point.x);
    stats.xyBounds.maxY = Math.max(stats.xyBounds.maxY, point.y);
  };

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const code = codeOnly(lines[index]);
    if (/[#\[\]]/.test(code)) stats.warnings.add(`Line ${lineNumber}: macro/expression syntax is not evaluated; estimate may omit motion.`);
    const words = wordsFor(code);
    if (!words.length) continue;
    if (has(words, 'A') || has(words, 'B') || has(words, 'C')) stats.warnings.add('Rotary axes are present but excluded from the distance estimate.');
    for (const word of words) if (word.letter === 'T') stats.tools.add(word.value);

    const gCodes = words.filter((word) => word.letter === 'G').map((word) => word.value);
    for (const g of gCodes) {
      const g1 = Number(g.toFixed(1));
      if (g1 === 20) state.unit = 25.4;
      if (g1 === 21) state.unit = 1;
      if (g1 === 90) state.absolute = true;
      if (g1 === 91) state.absolute = false;
      if (g1 === 90.1) state.centerAbsolute = true;
      if (g1 === 91.1) state.centerAbsolute = false;
      if (g1 === 17) state.plane = 17;
      if (g1 === 18) state.plane = 18;
      if (g1 === 19) state.plane = 19;
      if (g1 === 93 || g1 === 94 || g1 === 95) state.feedMode = g1;
      if ([0, 1, 2, 3].includes(g1)) state.motion = g1;
      if ([54, 55, 56, 57, 58, 59].includes(g1)) state.wcs = `G${g1}`;
      if ([28, 30, 38, 53, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 92].includes(Math.floor(g1))) {
        stats.warnings.add(`Line ${lineNumber}: G${g} motion/offset is not fully modeled; estimate may be incomplete.`);
        stats.safeZAnalysisValid = false;
      }
    }
    if (has(words, 'F')) state.feed = val(words, 'F') * (state.feedMode === 93 ? 1 : state.unit);
    for (const word of words) {
      if (word.letter === 'M' && word.value === 6) stats.toolChanges += 1;
      if (word.letter === 'G' && Number(word.value.toFixed(1)) === 4) {
        const dwell = val(words, 'P') ?? val(words, 'X');
        if (Number.isFinite(dwell) && dwell > 0) stats.dwellSeconds += dwell;
      }
      if (word.letter === 'M' && [0, 1].includes(word.value)) stats.pauseCount += 1;
    }

    const hasAxis = has(words, 'X') || has(words, 'Y') || has(words, 'Z');
    if (!hasAxis || ![0, 1, 2, 3].includes(state.motion)) continue;
    const start = { x: state.x, y: state.y, z: state.z };
    const coordinates = {};
    for (const axis of ['X', 'Y', 'Z']) {
      const raw = val(words, axis);
      if (raw === undefined) continue;
      const value = raw * state.unit;
      const key = axis.toLowerCase();
      coordinates[key] = state.absolute ? value : state[key] + value;
    }
    const end = { x: coordinates.x ?? start.x, y: coordinates.y ?? start.y, z: coordinates.z ?? start.z };
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const dz = end.z - start.z;
    let planar = Math.hypot(dx, dy);
    if ([2, 3].includes(state.motion)) {
      if (state.plane === 17) planar = arcDistance(start, end, words, state.centerAbsolute, state.motion === 2, state.unit, stats.warnings, lineNumber);
      else stats.warnings.add(`Line ${lineNumber}: non-XY arc length uses a straight-line approximation.`);
    }
    const length = Math.hypot(planar, dz);
    if (length > 0) {
      stats.motionBlocks += 1;
      if (state.motion === 0) {
        stats.rapidDistance += length;
        stats.rapidMinutes += length / rapidRate;
        if (planar > 0 && Math.abs(dz) < 0.0001) {
          stats.xyRapidDistance += planar;
          stats.xyRapidMinutes += length / rapidRate;
          stats.xyRapidMoveCount += 1;
          stats.longestRapidXYMoves.push({
            line: lineNumber,
            distance: planar,
            seconds: length / rapidRate * 60,
            from: { x: start.x, y: start.y },
            to: { x: end.x, y: end.y },
          });
        }
        if (has(words, 'Z')) {
          stats.zRapidDistance += Math.abs(dz);
          if (state.absolute && !has(words, 'X') && !has(words, 'Y')) {
            const nextOptimizedZ = Math.min(end.z, safeZ);
            const oldDistance = Math.abs(end.z - start.z);
            const optimizedDistance = Math.abs(nextOptimizedZ - state.optimizedZ);
            if (end.z > safeZ) stats.highSafeZMoves += 1;
            stats.safeZPotentialSeconds += Math.max(0, oldDistance - optimizedDistance) / rapidRate * 60;
            state.optimizedZ = nextOptimizedZ;
          } else if (state.absolute) {
            state.optimizedZ = end.z;
          } else {
            stats.warnings.add('Incremental Z rapids are not used for safe-height savings estimates.');
            stats.safeZAnalysisValid = false;
            state.optimizedZ = end.z;
          }
        }
      } else if (state.feedMode === 93) {
        const inverseFeed = val(words, 'F') ?? state.feed;
        if (inverseFeed > 0) stats.cuttingMinutes += 1 / inverseFeed;
        else stats.warnings.add(`Line ${lineNumber}: inverse-time move is missing F and was not timed.`);
        stats.cuttingDistance += length;
      } else if (state.feedMode === 95) {
        stats.cuttingDistance += length;
        stats.warnings.add(`Line ${lineNumber}: G95 feed/revolution motion was not timed because spindle speed is not modeled.`);
      } else if (state.feed > 0) {
        stats.cuttingDistance += length;
        stats.cuttingMinutes += length / state.feed;
      } else {
        stats.cuttingDistance += length;
        stats.warnings.add(`Line ${lineNumber}: cutting move has no known feed rate and was not timed.`);
      }
      setBounds(end);
    }
    state.x = end.x;
    state.y = end.y;
    state.z = end.z;
    if (state.motion !== 0 && has(words, 'Z')) state.optimizedZ = end.z;
    if (state.absolute && (has(words, 'X') || has(words, 'Y'))) sawAbsolutePosition = true;
  }

  const toolChangeSeconds = stats.toolChanges * (settings.toolMode === 'automatic' ? autoToolSeconds : manualToolSeconds);
  const pauseTimeSeconds = stats.pauseCount * pauseSeconds;
  const motionSeconds = (stats.rapidMinutes + stats.cuttingMinutes) * 60 * efficiency;
  const totalSeconds = motionSeconds + stats.dwellSeconds + toolChangeSeconds + pauseTimeSeconds;
  if (!sawAbsolutePosition) stats.warnings.add('No absolute XY coordinates were found; job bounds may not reflect the actual work area.');
  if (stats.xyBounds.minX === Infinity) stats.xyBounds = null;
  stats.longestRapidXYMoves.sort((a, b) => b.distance - a.distance);
  stats.longestRapidXYMoves = stats.longestRapidXYMoves.slice(0, 8);

  return {
    ...stats,
    warnings: [...stats.warnings],
    tools: [...stats.tools].sort((a, b) => a - b),
    efficiency,
    toolChangeSeconds,
    pauseTimeSeconds,
    motionSeconds,
    totalSeconds,
    safeZPotentialSeconds: stats.safeZPotentialSeconds * efficiency,
    xyRapidMinutes: stats.xyRapidMinutes,
    xyRapidPotentialSeconds: stats.xyRapidMinutes * 60 * efficiency * Math.min(50, Math.max(0, Number(settings.xyRapidReduction) || 0)) / 100,
    materialCost: Math.max(0, Number(settings.materialCost) || 0),
    machineHourlyCost: Math.max(0, Number(settings.machineHourlyCost) || 0),
    machineCost: totalSeconds / 3600 * Math.max(0, Number(settings.machineHourlyCost) || 0),
    estimatedTotalCost: Math.max(0, Number(settings.materialCost) || 0) + totalSeconds / 3600 * Math.max(0, Number(settings.machineHourlyCost) || 0),
  };
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours} h ${minutes} min` : `${minutes} min`;
}

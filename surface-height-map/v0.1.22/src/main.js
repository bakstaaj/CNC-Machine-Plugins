import { gcode, machine, storage, workspace } from '@sienci/gsender-plugin-sdk';
import { DEFAULTS, appendMachineOriginReturn, compensateGcode, computeG54ForMapOrigin, computePostProbeRetract, makeStlExportRecord, parseAbsoluteXYBounds, parseProbePosition, parseTravelLimits, parseWorkOffsetLine, validateMachineTarget, validateMap } from './heightmap.js';
import './style.css';

const $ = (id) => document.getElementById(id);
const fields = ['lengthX', 'lengthY', 'pointsX', 'pointsY', 'postProbeRetract', 'probeTravel', 'fastFeed', 'slowFeed', 'slowTravel', 'retract', 'puckThickness'];
const state = { origin: null, homeMachineZ: null, probeParserSequence: 0, offsetParserSequence: 0, map: null, stlExport: null, file: null, busy: false, stopRequested: false, abortPuck: null };
const setNotice = (message, kind = '') => { $('notice').textContent = message; $('notice').className = kind; };
const setApplyStatus = (message, kind = '') => { $('applyStatus').textContent = message; $('applyStatus').className = kind; };
const n = (id) => Number($(id).value);
const round = (v) => Number(v.toFixed(4));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function drawSurfaceMap() {
    const panel = $('mapVisual');
    const map = state.map;
    panel.hidden = !map;
    if (!map) return;
    const values = map.z.flat();
    if (!values.length || values.some((value) => !Number.isFinite(value))) return;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min;
    $('mapStats').textContent = `Lowest ${min.toFixed(3)} mm · highest ${max.toFixed(3)} mm · range ${range.toFixed(3)} mm`;
    const factor = Number($('exaggeration').value);
    $('exaggerationValue').textContent = `${factor}×`;
    const canvas = $('surfaceCanvas');
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const nx = map.pointsX;
    const ny = map.pointsY;
    const span = Math.min(width * 0.40, height * 0.34);
    const lift = Math.min(height * 0.28, span * factor * 0.08);
    const points = map.z.map((row, iy) => row.map((z, ix) => {
        const u = ix / (nx - 1);
        const v = iy / (ny - 1);
        const level = range > 0 ? (z - min) / range : 0.5;
        return { x: width / 2 + (u - v) * span, y: height * 0.32 + (u + v) * span * 0.43 - level * lift, level };
    }));
    const color = (level) => {
        const stops = [[36, 91, 219], [25, 185, 165], [184, 214, 60], [245, 140, 50], [216, 56, 56]];
        const at = level * (stops.length - 1);
        const idx = Math.min(stops.length - 2, Math.floor(at));
        const t = at - idx;
        const rgb = stops[idx].map((channel, c) => Math.round(channel + (stops[idx + 1][c] - channel) * t));
        return `rgb(${rgb.join(',')})`;
    };
    for (let iy = 0; iy < ny - 1; iy += 1) {
        for (let ix = 0; ix < nx - 1; ix += 1) {
            const quad = [points[iy][ix], points[iy][ix + 1], points[iy + 1][ix + 1], points[iy + 1][ix]];
            const level = quad.reduce((sum, point) => sum + point.level, 0) / quad.length;
            ctx.beginPath();
            ctx.moveTo(quad[0].x, quad[0].y);
            for (let i = 1; i < quad.length; i += 1) ctx.lineTo(quad[i].x, quad[i].y);
            ctx.closePath();
            ctx.fillStyle = color(level);
            ctx.globalAlpha = 0.84;
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.strokeStyle = 'rgba(235,245,255,0.72)';
            ctx.lineWidth = 1;
            ctx.stroke();
        }
    }
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (const row of points) for (const point of row) {
        ctx.beginPath();
        ctx.arc(point.x, point.y, 2.2, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = getComputedStyle(canvas).color;
    ctx.fillText('X', width / 2 + span + 14, height * 0.32 + span * 0.43);
    ctx.fillText('Y', width / 2 - span - 14, height * 0.32 + span * 0.43);
}

function currentSettings() {
    return {
        ...Object.fromEntries(fields.map((id) => [id, n(id)])),
        surfaceType: document.querySelector('input[name="surfaceType"]:checked').value,
    };
}

function populateSettings(saved = {}) {
    for (const id of fields) {
        const value = saved[id];
        const missingOrInvalid = value == null || value === '' || !Number.isFinite(Number(value));
        const invalidSlowTravel = id === 'slowTravel'
            && Number(value) <= Number(saved.retract ?? DEFAULTS.retract);
        $(id).value = String(missingOrInvalid || invalidSlowTravel ? DEFAULTS[id] : value);
    }
    document.querySelector(`input[name="surfaceType"][value="${saved.surfaceType ?? DEFAULTS.surfaceType}"]`).checked = true;
    updatePuckThicknessVisibility();
}

function updatePuckThicknessVisibility() {
    $('puckThicknessField').hidden = document.querySelector('input[name="surfaceType"]:checked').value !== 'puck';
}

function renderStlExport() {
    const panel = $('stlExportPanel');
    const output = state.stlExport;
    panel.hidden = !output || typeof output.text !== 'string' || typeof output.filename !== 'string';
    if (panel.hidden) return;
    panel.open = true;
    $('stlExportSummary').textContent = `${output.filename} · ${(new TextEncoder().encode(output.text).length / 1024).toFixed(1)} KiB in plugin storage`;
    $('stlText').value = output.text;
}

async function saveSettings() {
    try { await storage.set('settings', currentSettings()); }
    catch (err) { setNotice(`Could not save plugin settings: ${err.message}`, 'error'); }
}

function machineStatus(line) {
    const mpos = line.match(/MPos:([-\d.]+),([-\d.]+),([-\d.]+)/i);
    const wpos = line.match(/WPos:([-\d.]+),([-\d.]+),([-\d.]+)/i);
    if (!mpos) return null;
    return {
        mpos: mpos.slice(1, 4).map(Number),
        wpos: wpos ? wpos.slice(1, 4).map(Number) : null,
        state: line.match(/^<([^|]+)/)?.[1] ?? 'unknown',
    };
}

async function statusSnapshot() {
    const result = await machine.query('?', { until: /^<[^>]+>$/, includeStatusReports: true, timeout: 5000, allowDuringJob: true });
    const line = result.lines.find((entry) => /^</.test(entry));
    const snapshot = line && machineStatus(line);
    if (!snapshot) throw new Error(`Could not read machine position. Controller response: ${result.lines.join(' ') || result.reason}`);
    return snapshot;
}

async function waitIdle(timeoutMs = 30000) {
    const until = Date.now() + timeoutMs;
    await pause(150);
    while (Date.now() < until) {
        const snapshot = await statusSnapshot();
        if (snapshot.state === 'Idle') return snapshot;
        if (snapshot.state === 'Alarm') throw new Error('Controller entered Alarm state. Resolve the alarm in gSender before continuing.');
        await pause(200);
    }
    throw new Error('Timed out waiting for the machine to become idle.');
}

async function sendAndWait(line, timeout = 30000) {
    const result = await machine.query(line, { until: 'ok-or-error', timeout, maxLines: 50 });
    if (!result.complete || result.error || !result.ok) {
        throw new Error(`Controller did not accept “${line}”: ${result.error ?? result.lines.join(' ') ?? result.reason}`);
    }
    return result;
}

async function readTravelLimits() {
    const result = await machine.query('$$', { until: 'ok-or-error', timeout: 10000, maxLines: 350 });
    if (!result.complete || result.error || !result.ok) throw new Error(`Could not read controller settings ($$): ${result.error ?? result.reason}`);
    return parseTravelLimits(result.lines);
}

async function readCoordinateOffsets(activeWcs) {
    const parserId = `surface-height-map-offset-${++state.offsetParserSequence}`;
    const registration = await machine.registerParser({
        id: parserId,
        mode: 'line',
        match: /^\[(?<name>G5[4-9]|G92):[-\d.,]+\]\s*$/i,
    });
    if (!registration.registered.includes(parserId) || registration.errors.length) {
        throw new Error(`Could not listen for coordinate offsets: ${registration.errors.map((entry) => entry.error ?? 'parser registration failed').join('; ')}`);
    }

    const offsets = {};
    let resolveOffset;
    const offsetReport = new Promise((resolve) => { resolveOffset = resolve; });
    const collect = (name, line) => {
        name = String(name ?? '').toUpperCase();
        const values = parseWorkOffsetLine(line, name);
        if (values) {
            offsets[name] = values;
            if (offsets[activeWcs] && offsets.G92) resolveOffset();
        }
    };
    const unsubscribe = machine.onParsed(parserId, (report) => collect(report.groups?.name, report.line));
    try {
        const result = await machine.query('$#', { until: 'ok-or-error', timeout: 8000, maxLines: 100 });
        if (!result.complete || result.error || !result.ok) throw new Error(`Could not read work offsets ($#): ${result.error ?? result.reason}`);
        for (const line of result.lines) {
            for (const name of ['G54', 'G55', 'G56', 'G57', 'G58', 'G59', 'G92']) collect(name, line);
        }
        if (!offsets[activeWcs] || !offsets.G92) {
            // Some controllers may send coordinate records after their `ok`; keep the
            // temporary line parser armed briefly to collect that late tail.
            await Promise.race([
                offsetReport,
                pause(2000),
            ]);
        }
        if (!offsets[activeWcs] || !offsets.G92) {
            const received = result.lines.map((line) => String(line).trim()).join(' | ') || '(no response lines)';
            throw new Error(`Could not read ${activeWcs} and G92 offsets from the controller's $# response. Expected [${activeWcs}:X,Y,Z,...] and [G92:X,Y,Z,...]. Received: ${received}`);
        }
        await pause(250);
        return offsets;
    } finally {
        unsubscribe();
        try { await machine.unregisterParser(parserId); } catch { /* connection may have closed */ }
    }
}

async function refreshUi() {
    let connected = false;
    try { connected = Boolean((await machine.getContext())?.connected); } catch { /* disconnected or SDK denied */ }
    if (!connected) {
        state.homeMachineZ = null;
        state.origin = null;
    }
    const homed = connected && Number.isFinite(state.homeMachineZ);
    $('connection').textContent = connected ? 'Connected' : 'Not connected';
    $('connection').dataset.connected = String(connected);
    $('captureOrigin').disabled = !homed || state.busy;
    $('home').disabled = !connected || state.busy;
    $('goToStart').disabled = !homed || state.busy;
    $('startX').disabled = !homed || state.busy;
    $('startY').disabled = !homed || state.busy;
    $('calibrate').disabled = !homed || state.busy || !state.origin;
    $('stop').disabled = !state.busy;
    $('compensate').disabled = !state.map || !state.file || state.busy;
    $('clearMap').disabled = !state.map || state.busy;
    $('exportStl').disabled = !state.map || state.busy;
    $('originLabel').textContent = state.origin ? `X${state.origin.x.toFixed(3)}  Y${state.origin.y.toFixed(3)}` : 'Origin not captured';
    $('homeLabel').textContent = homed ? `Homed at Z${state.homeMachineZ.toFixed(3)}` : 'Machine not homed';
    $('mapSummary').textContent = state.map
        ? `${state.map.lengthX} × ${state.map.lengthY} mm · ${state.map.pointsX} × ${state.map.pointsY} points · captured at machine X${state.map.originX.toFixed(3)} Y${state.map.originY.toFixed(3)} · ${new Date(state.map.createdAt).toLocaleString()}`
        : 'No height map saved.';
    drawSurfaceMap();
}

function readProbePosition(result) {
    const line = result.lines.map((entry) => String(entry).trim()).find((entry) => /^\[PRB:/i.test(entry));
    const position = line && parseProbePosition(line);
    if (!position) throw new Error(`Probe did not trigger successfully. Response: ${result.lines.join(' ') || result.reason}`);
    return position;
}

async function exportSurfaceStl() {
    const button = $('exportStl');
    button.disabled = true;
    try {
        if (!state.map) throw new Error('Calibrate or load a saved height map before exporting an STL.');
        const record = makeStlExportRecord(state.map);
        await storage.set('stlExport', record);
        state.stlExport = record;
        renderStlExport();
        $('stlStatus').textContent = `STL text saved in gSender plugin storage as ${record.filename}. Use Copy STL text, then paste it into a plain-text editor and save the file with the .stl extension.`;
        $('stlStatus').className = 'success';
    } catch (error) {
        $('stlStatus').textContent = error.message;
        $('stlStatus').className = 'error';
    } finally {
        button.disabled = !state.map || state.busy;
    }
}

async function copyStlText() {
    const output = state.stlExport;
    if (!output?.text) return;
    const field = $('stlText');
    try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard write is unavailable in this gSender build.');
        await navigator.clipboard.writeText(output.text);
        $('copyStlStatus').textContent = 'STL text copied. Paste it into a plain-text editor and save with the .stl extension.';
        $('copyStlStatus').className = 'success';
    } catch {
        field.focus();
        field.select();
        field.setSelectionRange(0, field.value.length);
        $('copyStlStatus').textContent = 'Clipboard access was blocked. The STL text is selected; press Ctrl+C, paste it into a plain-text editor, and save with the .stl extension.';
        $('copyStlStatus').className = '';
    }
}

async function queryProbe(line, timeout, stage) {
    const parserId = `surface-height-map-probe-${++state.probeParserSequence}`;
    const registration = await machine.registerParser({
        id: parserId,
        mode: 'line',
        match: /^\[PRB:(?<x>[-\d.]+),(?<y>[-\d.]+),(?<z>[-\d.]+)(?:,[-\d.]+)*:(?<success>[01])\]\s*$/i,
    });
    if (!registration.registered.includes(parserId) || registration.errors.length) {
        throw new Error(`Could not listen for the ${stage.toLowerCase()} probe report: ${registration.errors.map((entry) => entry.error ?? 'parser registration failed').join('; ')}`);
    }

    let resolveReport;
    const reportPromise = new Promise((resolve) => { resolveReport = resolve; });
    const unsubscribe = machine.onParsed(parserId, (report) => {
        try { resolveReport({ position: parseProbePosition(report.line) }); }
        catch (error) { resolveReport({ error }); }
    });
    try {
        const result = await machine.query(line, { until: 'ok-or-error', timeout, maxLines: 50 });
        if (!result.complete || !result.ok || result.error) {
            throw new Error(`${stage} probe was not accepted. Controller response: ${result.error ?? result.lines.join(' ') ?? result.reason}`);
        }
        const reportLine = result.lines.map((entry) => String(entry).trim()).find((entry) => /^\[PRB:/i.test(entry));
        if (reportLine) return readProbePosition({ lines: [reportLine] });

        setNotice(`${stage} probe was acknowledged. Waiting for its position report…`);
        let reportTimeout;
        const timeoutPromise = new Promise((_, reject) => {
            reportTimeout = setTimeout(() => reject(new Error('The controller acknowledged the probe with “ok” but no [PRB:...] position report arrived. Check the probe reporting stream and controller connection.')), 5000);
        });
        const outcome = await Promise.race([reportPromise, timeoutPromise]).finally(() => clearTimeout(reportTimeout));
        if (outcome.error) throw outcome.error;
        if (!outcome.position) throw new Error(`${stage} probe report did not contain a valid position.`);
        return outcome.position;
    } finally {
        unsubscribe();
        try { await machine.unregisterParser(parserId); } catch { /* connection may have closed */ }
    }
}

async function probeAt(settings, point, index, total) {
    const pointLabel = `point ${index + 1}/${total} (X${point.x.toFixed(3)} Y${point.y.toFixed(3)})`;
    setNotice(`Fast probe on ${pointLabel}… keep hands clear.`);
    await queryProbe(`G91 G38.2 Z-${settings.probeTravel} F${settings.fastFeed}`, 45000, `Fast probe on ${pointLabel}`);
    setNotice(`Fast contact found on ${pointLabel}. Retracting ${settings.retract} mm before the slow touch…`);
    await sendAndWait(`G91 G0 Z${settings.retract}`);
    setNotice(`Slow probe on ${pointLabel}…`);
    await queryProbe(`G91 G38.2 Z-${settings.slowTravel} F${settings.slowFeed}`, 30000, `Slow probe on ${pointLabel}`);
    setNotice(`Slow probe contact registered on ${pointLabel}. Reading the stopped Z position…`);
    const status = await statusSnapshot();
    return {
        z: status.mpos[2] - (settings.surfaceType === 'puck' ? settings.puckThickness : 0),
        machineZ: status.mpos[2],
    };
}

function confirmUser(message, title, buttonLabel = 'Continue') {
    $('dialogTitle').textContent = title;
    $('puckPrompt').textContent = message;
    $('continuePuck').textContent = buttonLabel;
    $('puckDialog').showModal();
    return new Promise((resolve, reject) => {
        state.abortPuck = () => { $('puckDialog').close(); reject(new Error('Calibration cancelled by user.')); };
        $('continuePuck').onclick = () => { state.abortPuck = null; $('puckDialog').close(); resolve(); };
        $('cancelPuck').onclick = () => state.abortPuck?.();
    });
}

function promptPuck(point, index, total) {
    return confirmUser(`Place the probe puck at grid point ${index + 1} of ${total} (machine X${point.x.toFixed(3)}, Y${point.y.toFixed(3)}), then confirm. Keep hands clear before continuing.`, 'Move the probe puck', 'Puck is in place');
}

function confirmG54Alignment(bounds, oldG54, targetG54) {
    const dialog = $('alignDialog');
    $('alignPrompt').textContent = `This will save G54 X/Y to ${targetG54.x.toFixed(3)}, ${targetG54.y.toFixed(3)} mm so the file's minimum X${bounds.minX.toFixed(3)} Y${bounds.minY.toFixed(3)} lands at the map origin X${state.map.originX.toFixed(3)} Y${state.map.originY.toFixed(3)}. Current G54 is X${oldG54[0].toFixed(3)} Y${oldG54[1].toFixed(3)}. The saved offsets affect other G54 jobs until changed again.`;
    dialog.showModal();
    return new Promise((resolve) => {
        const finish = (accepted) => {
            dialog.close();
            dialog.oncancel = null;
            resolve(accepted);
        };
        $('confirmAlign').onclick = () => finish(true);
        $('cancelAlign').onclick = () => finish(false);
        dialog.oncancel = (event) => { event.preventDefault(); finish(false); };
    });
}

function validateSettings(s, limits) {
    for (const id of fields) if (!Number.isFinite(s[id])) throw new Error(`Enter a valid number for ${id}.`);
    if (s.postProbeRetract <= 0 || s.postProbeRetract > limits.maxZ) throw new Error(`Post-probe retract must be greater than zero and no more than the Z travel limit ${limits.maxZ} mm.`);
    if (s.probeTravel <= 0 || s.probeTravel > limits.maxZ) throw new Error(`Probe travel must be greater than zero and no more than the Z travel limit ${limits.maxZ} mm.`);
    if (s.slowTravel <= s.retract) throw new Error('Slow probe travel must be greater than the retract distance.');
    if (s.fastFeed <= 0 || s.slowFeed <= 0 || s.retract <= 0) throw new Error('Feeds and retract must be greater than zero.');
    if (s.puckThickness < 0) throw new Error('Probe puck thickness cannot be negative.');
}

async function homeMachine() {
    if (state.busy) return;
    state.homeMachineZ = null;
    state.busy = true; await refreshUi(); setNotice('Homing… keep clear of the machine.');
    try {
        const result = await machine.query('$H', { until: 'ok-or-error', timeout: 120000, maxLines: 80 });
        if (!result.complete || !result.ok || result.error) throw new Error(`Homing failed: ${result.error ?? result.lines.join(' ') ?? result.reason}`);
        const homeStatus = await waitIdle(30000);
        state.homeMachineZ = round(homeStatus.mpos[2]);
        state.origin = null;
        await refreshUi();
        setNotice('Homing complete. Jog to the lower-left map corner and capture the origin.', 'success');
    } catch (err) { setNotice(err.message, 'error'); }
    finally { state.busy = false; await refreshUi(); }
}

async function captureOrigin() {
    try {
        if (!Number.isFinite(state.homeMachineZ)) throw new Error('Home the machine using this plugin before setting the map origin.');
        const snapshot = await statusSnapshot();
        if (snapshot.state !== 'Idle') throw new Error(`Machine must be idle to capture origin (current state: ${snapshot.state}).`);
        state.origin = { x: round(snapshot.mpos[0]), y: round(snapshot.mpos[1]) };
        await refreshUi();
        setNotice('Origin captured from machine coordinates.', 'success');
    } catch (err) { setNotice(err.message, 'error'); }
}

async function goToStart() {
    if (state.busy) return;
    if (!Number.isFinite(state.homeMachineZ)) {
        setNotice('Home the machine using this plugin before moving to the map start position.', 'error');
        return;
    }
    const xValue = $('startX').value.trim();
    const yValue = $('startY').value.trim();
    if (xValue === '' || yValue === '') {
        setNotice('Enter valid machine-coordinate X and Y positions for the start point.', 'error');
        return;
    }
    const x = Number(xValue);
    const y = Number(yValue);
    state.busy = true;
    await refreshUi();
    setNotice('Checking machine travel and moving to the requested start position…');
    try {
        const snapshot = await statusSnapshot();
        if (snapshot.state !== 'Idle') throw new Error(`Machine must be idle before moving to the start position (current state: ${snapshot.state}).`);
        const limits = await readTravelLimits();
        const target = validateMachineTarget({ x, y }, limits);
        await machine.setBusy(true, 'Move to height-map start position');
        await sendAndWait(`G90 G53 G0 X${target.x} Y${target.y}`);
        await waitIdle();
        setNotice(`At machine X${target.x.toFixed(3)} Y${target.y.toFixed(3)}; Z was left unchanged. Capture the current position as the map origin when ready.`, 'success');
    } catch (err) {
        setNotice(err.message, 'error');
    } finally {
        try { await machine.setBusy(false); } catch { /* machine disconnected during cleanup */ }
        state.busy = false;
        await refreshUi();
    }
}

async function calibrate() {
    if (state.busy || !state.origin) return;
    if (!Number.isFinite(state.homeMachineZ)) {
        setNotice('Home machine using the plugin before starting calibration.', 'error');
        return;
    }
    state.busy = true; state.stopRequested = false; $('progress').hidden = false; $('progress').value = 0;
    await refreshUi(); setNotice('Reading controller travel limits and validating the complete grid…');
    try {
        const initialStatus = await statusSnapshot();
        if (initialStatus.state !== 'Idle') throw new Error(`Machine must be idle before calibration (current state: ${initialStatus.state}).`);
        if (Math.abs(initialStatus.mpos[2] - state.homeMachineZ) > 0.1) {
            throw new Error('Return Z to its homed position before calibration. The plugin will keep Z there while moving to the first point.');
        }
        const settings = currentSettings();
        const limits = await readTravelLimits();
        validateSettings(settings, limits);
        const grid = validateMap({ originX: state.origin.x, originY: state.origin.y, lengthX: settings.lengthX, lengthY: settings.lengthY, pointsX: settings.pointsX, pointsY: settings.pointsY }, limits);
        const flat = grid.flat();
        const measured = Array.from({ length: settings.pointsY }, () => Array(settings.pointsX));
        if (settings.surfaceType === 'conductive') {
            await confirmUser('Attach the probe clip to the conductive work surface. The probe will move automatically through the full grid; keep clear of the machine.', 'Prepare conductive probe', 'Clip is attached');
        }
        await machine.setBusy(true, 'Surface height-map calibration');
        let firstZ = null;
        for (let index = 0; index < flat.length; index += 1) {
            if (state.stopRequested) break;
            const point = flat[index];
            setNotice(`Moving to map point ${index + 1}/${flat.length}: X${point.x.toFixed(3)} Y${point.y.toFixed(3)}. Keep hands clear.`);
            if (state.stopRequested) break;
            await sendAndWait(`G90 G53 G0 X${point.x.toFixed(3)} Y${point.y.toFixed(3)}`);
            await waitIdle();
            if (state.stopRequested) break;
            if (settings.surfaceType === 'puck') await promptPuck(point, index, flat.length);
            if (state.stopRequested) break;
            const probe = await probeAt(settings, point, index, flat.length);
            const retractDistance = computePostProbeRetract(probe.machineZ, state.homeMachineZ, settings.postProbeRetract);
            setNotice(`Probe complete at point ${index + 1}/${flat.length} (X${point.x.toFixed(3)} Y${point.y.toFixed(3)}). Retracting ${retractDistance.toFixed(3)} mm toward the recorded home Z…`);
            await sendAndWait(`G91 G0 Z${retractDistance}`);
            await waitIdle();
            setNotice(`Point ${index + 1}/${flat.length} saved. Retract complete; moving to the next point…`);
            measured[point.iy][point.ix] = round(probe.z);
            if (firstZ === null) firstZ = probe.z;
            $('progress').value = (index + 1) / flat.length;
        }
        if (state.stopRequested) throw new Error('Calibration stopped at a point boundary. Partial measurements were discarded; the previous saved map remains available.');
        if (measured.flat().some((value) => !Number.isFinite(value))) throw new Error('Calibration ended with missing measurements; no new map was saved.');
        setNotice('All probe points measured. Retracting to machine Z0, then moving to machine X0 Y0…');
        await sendAndWait('G90 G53 G0 Z0');
        await waitIdle();
        await sendAndWait('G90 G53 G0 X0 Y0');
        await waitIdle();
        state.map = {
            originX: state.origin.x, originY: state.origin.y,
            lengthX: settings.lengthX, lengthY: settings.lengthY,
            pointsX: settings.pointsX, pointsY: settings.pointsY,
            surfaceType: settings.surfaceType, puckThickness: settings.puckThickness,
            referenceZ: round(firstZ), z: measured, createdAt: new Date().toISOString(),
        };
        await storage.set('heightMap', state.map);
        await storage.delete('stlExport');
        state.stlExport = null;
        renderStlExport();
        $('stlStatus').textContent = '';
        $('copyStlStatus').textContent = '';
        setNotice(`Calibration saved (${settings.pointsX * settings.pointsY} points).`, 'success');
    } catch (err) {
        setNotice(err.message, 'error');
    } finally {
        $('progress').hidden = true; state.busy = false;
        try { await machine.setBusy(false); } catch { /* machine disconnected during cleanup */ }
        await refreshUi();
    }
}

async function compensateFile() {
    if (!state.file || !state.map || state.busy) return;
    setApplyStatus('Preparing compensated copy…');
    try {
        const snapshot = await statusSnapshot();
        if (snapshot.state !== 'Idle') throw new Error('Stop the machine and wait for Idle before aligning G54 for a file.');
        const modal = await machine.query('$G', { until: 'ok-or-error', timeout: 5000, maxLines: 20 });
        const modalLine = modal.lines.find((line) => /^\[GC:/i.test(line));
        const activeWcs = modalLine?.match(/(?:^|\s)(G5[4-9])(?:\s|\])/i)?.[1]?.toUpperCase();
        if (!activeWcs) throw new Error('Could not determine the active work coordinate system from $G.');
        const source = await state.file.text();
        const bounds = parseAbsoluteXYBounds(source);
        if (activeWcs !== 'G54') throw new Error(`Select G54 in gSender before applying the map. This workflow aligns G54 to the toolpath's minimum X/Y coordinates; the active coordinate system is ${activeWcs}.`);
        const offsets = await readCoordinateOffsets('G54');
        const oldG54 = offsets.G54;
        const g92 = offsets.G92;
        const targetG54 = computeG54ForMapOrigin({ x: state.map.originX, y: state.map.originY }, bounds, g92);
        const targetWorkOffset = { x: targetG54.x + g92[0], y: targetG54.y + g92[1] };
        if (bounds.maxX - bounds.minX > state.map.lengthX + 1e-6 || bounds.maxY - bounds.minY > state.map.lengthY + 1e-6) {
            throw new Error(`Toolpath size ${ (bounds.maxX - bounds.minX).toFixed(3) } × ${ (bounds.maxY - bounds.minY).toFixed(3) } mm is larger than the mapped area ${state.map.lengthX} × ${state.map.lengthY} mm.`);
        }
        // Preflight before updating the persistent controller offset, so invalid or
        // unsupported files cannot leave G54 changed without a usable output file.
        const compensated = compensateGcode(source, state.map, targetWorkOffset, 'G54', null);
        const output = [
            '(Retract to machine Z0 before positioning to the file start)',
            'G21 G90 G53 G0 Z0',
            appendMachineOriginReturn(compensated),
        ].join('\n');
        const offsetChanged = Math.abs(oldG54[0] - targetG54.x) > 0.0001 || Math.abs(oldG54[1] - targetG54.y) > 0.0001;
        if (offsetChanged) {
            const accepted = await confirmG54Alignment(bounds, oldG54, targetG54);
            if (!accepted) {
                setApplyStatus('Canceled. No compensated file was loaded.');
                return;
            }
            const command = `G21 G10 L2 P1 X${targetG54.x.toFixed(4)} Y${targetG54.y.toFixed(4)}`;
            await sendAndWait(command, 10000);
            const updated = await readCoordinateOffsets('G54');
            if (Math.abs(updated.G54[0] - targetG54.x) > 0.001 || Math.abs(updated.G54[1] - targetG54.y) > 0.001) {
                throw new Error(`Controller accepted the G54 update but readback did not match. Expected X${targetG54.x.toFixed(3)} Y${targetG54.y.toFixed(3)}; received X${updated.G54[0].toFixed(3)} Y${updated.G54[1].toFixed(3)}. No compensated file was loaded.`);
            }
        }
        const outputName = state.file.name.replace(/(\.[^.]+)?$/, '-heightmapped$1');
        await gcode.loadToVisualizer(output, outputName);
        if (typeof workspace.navigateToCarve !== 'function') {
            setApplyStatus(`Loaded “${outputName}”. This gSender build does not support automatic navigation; open Carve to review the copy.`, 'success');
            return;
        }
        setApplyStatus(`Loaded “${outputName}”. Returning to Carve…`, 'success');
        await pause(1200);
        try {
            await workspace.navigateToCarve();
        } catch (err) {
            setApplyStatus(`Loaded “${outputName}”, but automatic navigation to Carve failed: ${err.message}`, 'error');
        }
    } catch (err) { setApplyStatus(err.message, 'error'); }
}

async function start() {
    try {
        populateSettings(await storage.get('settings', DEFAULTS));
        state.map = await storage.get('heightMap', null);
        state.stlExport = await storage.get('stlExport', null);
        renderStlExport();
        $('exaggeration').addEventListener('input', drawSurfaceMap);
        if (window.ResizeObserver) new ResizeObserver(drawSurfaceMap).observe($('surfaceCanvas'));
        for (const id of fields) $(id).addEventListener('change', saveSettings);
        for (const input of document.querySelectorAll('input[name="surfaceType"]')) input.addEventListener('change', () => {
            updatePuckThicknessVisibility();
            saveSettings();
        });
        $('home').addEventListener('click', homeMachine);
        $('captureOrigin').addEventListener('click', captureOrigin);
        $('goToStart').addEventListener('click', goToStart);
        $('calibrate').addEventListener('click', calibrate);
        $('stop').addEventListener('click', () => { state.stopRequested = true; state.abortPuck?.(); setNotice('Stop requested. The current controller move/probe will finish before calibration stops.'); });
        $('clearMap').addEventListener('click', async () => { state.map = null; state.stlExport = null; await storage.delete('heightMap'); await storage.delete('stlExport'); renderStlExport(); $('stlStatus').textContent = ''; await refreshUi(); setNotice('Saved height map and STL export deleted.', 'success'); });
        $('exportStl').addEventListener('click', exportSurfaceStl);
        $('copyStlText').addEventListener('click', copyStlText);
        $('file').addEventListener('change', (event) => {
            state.file = event.target.files?.[0] ?? null;
            $('fileLabel').textContent = state.file ? `${state.file.name} · ${(state.file.size / 1024).toFixed(1)} KB` : 'No file selected.';
            refreshUi();
        });
        $('compensate').addEventListener('click', compensateFile);
        machine.addListener('controller:state', () => refreshUi());
        $('puckDialog').addEventListener('cancel', (event) => { event.preventDefault(); state.abortPuck?.(); });
        await refreshUi();
    } catch (err) { setNotice(`Plugin initialization failed: ${err.message}`, 'error'); }
}

start();

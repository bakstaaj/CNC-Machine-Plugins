import { storage } from '@sienci/gsender-plugin-sdk';
import { analyzeGcode, formatDuration } from './analyze.js';
import './style.css';

const $ = (id) => document.getElementById(id);
const DEFAULTS = {
  rapidRate: 3000,
  machineHourlyCost: 12,
  materialCost: 0,
  toolMode: 'manual',
  manualToolSeconds: 90,
  autoToolSeconds: 15,
  pauseSeconds: 30,
  motionFactor: 1.15,
  safeZ: 5,
  xyRapidReduction: 25,
};
const state = { fileName: '', fileText: '', result: null, settings: { ...DEFAULTS }, revision: 0 };

document.querySelector('#app').innerHTML = `
  <header class="page-header">
    <div class="eyebrow">Plan and price a CNC job</div>
    <h1>G-code Job Cost Estimator</h1>
    <p>Estimate machine time and job cost from a G-code file before you run it.</p>
  </header>

  <section class="panel file-panel">
    <div class="section-heading"><div><div class="step">01 · JOB FILE</div><h2>Choose a G-code file</h2></div><span class="status" id="fileStatus">No file loaded</span></div>
    <label>G-code file<input id="gcodeFile" type="file" accept=".nc,.gcode,.ngc,.tap,.txt,text/plain"></label>
    <p id="fileSummary" class="hint">The file is read locally in this browser, not uploaded.</p>
  </section>

  <section class="panel settings-panel">
    <div class="section-heading"><div><div class="step">02 · COST MODEL</div><h2>Set your shop rates</h2></div></div>
    <div class="settings-grid">
      <label>Material cost for this job<input id="materialCost" type="number" min="0" step="0.01"></label>
      <label>Machine run cost per hour<input id="machineHourlyCost" type="number" min="0" step="0.25"></label>
      <label>Rapid feed rate (mm/min)<input id="rapidRate" type="number" min="1" step="100"></label>
      <label>Motion-time allowance<select id="motionFactor"><option value="1">1.00× · ideal motion</option><option value="1.1">1.10× · light machine overhead</option><option value="1.15">1.15× · typical starting estimate</option><option value="1.25">1.25× · conservative estimate</option><option value="1.4">1.40× · high overhead</option></select></label>
      <label>Tool change style<select id="toolMode"><option value="manual">Manual tool changes</option><option value="automatic">Automatic tool changer</option></select></label>
      <label id="manualToolField">Manual time per tool change (seconds)<input id="manualToolSeconds" type="number" min="0" step="5"></label>
      <label id="autoToolField" hidden>Automatic time per tool change (seconds)<input id="autoToolSeconds" type="number" min="0" step="1"></label>
      <label>Programmed pause time (seconds each)<input id="pauseSeconds" type="number" min="0" step="5"></label>
      <label>Safe Z to compare (mm from work zero)<input id="safeZ" type="number" step="0.5"></label>
      <label>XY rapid what-if reduction<select id="xyRapidReduction"><option value="0">0% · show without scenario</option><option value="10">10% · modest scenario</option><option value="25">25% · moderate scenario</option><option value="50">50% · ambitious scenario</option></select></label>
    </div>
    <p class="hint">Shop rates and estimator settings are saved on this device. Material cost is per job. The machine rate is multiplied by estimated machine hours.</p>
  </section>

  <div class="actions"><button id="analyzeButton" class="primary large" disabled>Analyze G-code</button><span id="savedStatus" class="hint">Settings are stored locally.</span></div>
  <div id="notice" class="notice" role="status" aria-live="polite">Load a file to estimate time and cost.</div>

  <section id="results" hidden>
    <div class="section-heading results-heading"><div><div class="step">03 · ESTIMATE</div><h2 id="jobTitle">Job estimate</h2></div><span class="status" id="confidenceLabel">Estimate</span></div>
    <div class="summary-grid">
      <article class="summary-card featured"><span>Estimated run time</span><strong id="runTime">—</strong><small>Includes motion allowance, dwells, pauses, and tool changes</small></article>
      <article class="summary-card featured"><span>Estimated job cost</span><strong id="jobCost">—</strong><small>Material cost plus estimated machine runtime cost</small></article>
      <article class="summary-card"><span>Machine time cost</span><strong id="machineCost">—</strong><small id="machineHours">—</small></article>
      <article class="summary-card"><span>Material cost</span><strong id="materialResult">—</strong><small>Entered job value</small></article>
    </div>

    <section class="panel breakdown-panel">
      <div class="section-heading"><div><div class="step">TIME BREAKDOWN</div><h2>What contributes to the estimate</h2></div></div>
      <div class="breakdown-grid" id="breakdown"></div>
      <div class="stats-row" id="jobStats"></div>
    </section>

    <section class="panel opportunity-panel">
      <div class="section-heading"><div><div class="step">04 · TIME SAVINGS REVIEW</div><h2>Potential safe-height opportunity</h2></div></div>
      <div id="safeOpportunity" class="opportunity-copy"></div>
      <p class="caution">This is a what-if estimate, not a G-code edit. Only lower a clearance after confirming stock thickness, clamps, fixtures, and every travel path. The safer fix is usually to adjust clearance/retract settings in CAM and regenerate the file.</p>
    </section>

    <section class="panel path-panel">
      <div class="section-heading"><div><div class="step">05 · PATH REVIEW</div><h2>XY rapid travel opportunities</h2></div></div>
      <div id="pathOpportunity" class="opportunity-copy"></div>
      <div id="rapidMoveList" class="rapid-move-list"></div>
      <p class="caution">The scenario is illustrative, not a predicted or guaranteed saving. The estimator does not reorder moves or change G-code. Only reorder independent operations in CAM after reviewing their depths, tool sequence, tabs, finish passes, workholding, and other dependencies.</p>
    </section>

    <section class="panel details-panel">
      <div class="section-heading"><div><div class="step">PARSER NOTES</div><h2>Warnings and assumptions</h2></div></div>
      <ul id="warnings" class="warning-list"></ul>
      <p class="hint">This is a planning estimate, not a machine-time guarantee. Acceleration, controller look-ahead, workholding pauses, setup, tool wear, and operator labor can change actual runtime.</p>
    </section>
  </section>
  <footer>Read-only estimator · source G-code is never modified · no job is sent to the CNC</footer>
`;

function money(value) {
  const currency = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });
  return currency.format(Number.isFinite(value) ? value : 0);
}

function settingsFromForm() {
  const next = { toolMode: $('toolMode').value };
  for (const key of ['rapidRate', 'machineHourlyCost', 'materialCost', 'manualToolSeconds', 'autoToolSeconds', 'pauseSeconds', 'motionFactor', 'safeZ', 'xyRapidReduction']) {
    next[key] = Number($(key).value);
  }
  return next;
}

function fillSettings() {
  for (const [key, value] of Object.entries(state.settings)) {
    if ($(key)) $(key).value = value;
  }
  updateToolFields();
}

function updateToolFields() {
  $('manualToolField').hidden = state.settings.toolMode === 'automatic';
  $('autoToolField').hidden = state.settings.toolMode !== 'automatic';
}

async function saveSettings() {
  const next = settingsFromForm();
  for (const key of Object.keys(next)) {
    if (key === 'toolMode') {
      if (!['manual', 'automatic'].includes(next[key])) next[key] = DEFAULTS.toolMode;
      continue;
    }
    if (!Number.isFinite(next[key])) next[key] = DEFAULTS[key];
    if (key !== 'safeZ') next[key] = Math.max(0, next[key]);
  }
  next.rapidRate = Math.max(1, next.rapidRate);
  state.settings = next;
  try {
    await storage.set('estimatorSettings', next);
    $('savedStatus').textContent = 'Saved on this device';
  } catch (error) {
    $('savedStatus').textContent = `Could not save settings: ${error.message}`;
  }
}

function setNotice(message, kind = '') {
  $('notice').textContent = message;
  $('notice').className = `notice ${kind}`;
}

function renderResults(result) {
  $('results').hidden = false;
  $('jobTitle').textContent = state.fileName || 'Job estimate';
  $('runTime').textContent = formatDuration(result.totalSeconds);
  $('jobCost').textContent = money(result.estimatedTotalCost);
  $('machineCost').textContent = money(result.machineCost);
  $('machineHours').textContent = `${(result.totalSeconds / 3600).toFixed(2)} machine hours × ${money(result.machineHourlyCost)}/hr`;
  $('materialResult').textContent = money(result.materialCost);
  $('confidenceLabel').textContent = result.warnings.length ? 'Review warnings' : 'Parsed estimate';
  const breakdown = [
    ['Cutting moves', result.cuttingMinutes * 60 * result.efficiency],
    ['Rapid moves', result.rapidMinutes * 60 * result.efficiency],
    ['Tool changes', result.toolChangeSeconds],
    ['Program pauses', result.pauseTimeSeconds],
    ['Dwell commands', result.dwellSeconds],
  ];
  $('breakdown').innerHTML = breakdown.map(([label, seconds]) => `<div class="breakdown-item"><span>${label}</span><strong>${formatDuration(seconds)}</strong></div>`).join('');
  const envelope = result.xyBounds
    ? `${(result.xyBounds.maxX - result.xyBounds.minX).toFixed(1)} × ${(result.xyBounds.maxY - result.xyBounds.minY).toFixed(1)} mm XY`
    : 'XY envelope unavailable';
  const toolList = result.tools.length ? `Tools: ${result.tools.map((tool) => `T${tool}`).join(', ')}` : 'No T words found';
  $('jobStats').textContent = `${result.motionBlocks.toLocaleString()} motion blocks · ${result.cuttingDistance.toFixed(0)} mm cutting path · ${result.rapidDistance.toFixed(0)} mm rapid path · ${result.toolChanges} M6 tool changes · ${toolList} · ${envelope}`;
  const possibleMinutes = result.safeZPotentialSeconds / 60;
  $('safeOpportunity').innerHTML = !result.safeZAnalysisValid
    ? 'The file contains coordinate modes or motion that prevent a reliable safe-height comparison. Use the CAM preview and verify the retract settings manually.'
    : result.highSafeZMoves
    ? `<strong>${result.highSafeZMoves}</strong> absolute rapid Z moves rise above the comparison height of <strong>${Number(state.settings.safeZ).toFixed(1)} mm</strong>. If that clearance is safe for this setup, the simplified model estimates up to <strong>${formatDuration(result.safeZPotentialSeconds)}</strong> could be saved by reducing those retracts in CAM. The file has not been changed.`
    : `No absolute rapid Z-only moves above ${Number(state.settings.safeZ).toFixed(1)} mm were found for the current comparison. Set the comparison height to match your material zero and rerun the estimate.`;
  const reduction = Math.min(50, Math.max(0, Number(state.settings.xyRapidReduction) || 0));
  const xySeconds = result.xyRapidMinutes * 60 * result.efficiency;
  const potentialCost = result.xyRapidPotentialSeconds / 3600 * result.machineHourlyCost;
  $('pathOpportunity').innerHTML = result.xyRapidMoveCount
    ? `<strong>${result.xyRapidMoveCount.toLocaleString()}</strong> horizontal rapid reposition moves total <strong>${result.xyRapidDistance.toFixed(0)} mm</strong> and about <strong>${formatDuration(xySeconds)}</strong> of estimated time. With the selected ${reduction}% reduction scenario, that would represent about <strong>${formatDuration(result.xyRapidPotentialSeconds)}</strong> (${money(potentialCost)}) if CAM path ordering can actually remove that much travel. This is a comparison scenario, not a recommendation to reorder these moves.`
    : `No horizontal rapid reposition moves were found in the supported motion subset. The path-order scenario is illustrative and does not alter the source file.`;
  $('rapidMoveList').innerHTML = result.longestRapidXYMoves.length
    ? `<h3>Longest horizontal rapid moves</h3><ol>${result.longestRapidXYMoves.map((move) => `<li><span>Line ${move.line}: ${move.distance.toFixed(1)} mm</span><small>${move.from.x.toFixed(1)}, ${move.from.y.toFixed(1)} → ${move.to.x.toFixed(1)}, ${move.to.y.toFixed(1)} mm · ${move.seconds.toFixed(1)} s ideal rapid time</small></li>`).join('')}</ol>`
    : '';
  $('warnings').innerHTML = result.warnings.length
    ? result.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')
    : '<li>No parser limitations were detected in the supported motion subset. Real runtime can still differ from the estimate.</li>';
  $('breakdown').setAttribute('aria-label', 'Estimated time by category');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

async function analyze() {
  if (!state.fileText) return;
  await saveSettings();
  try {
    const result = analyzeGcode(state.fileText, state.settings);
    state.result = result;
    renderResults(result);
    setNotice(`Analysis complete for ${state.fileName}. The source file remains unchanged.`, 'success');
  } catch (error) {
    state.result = null;
    $('results').hidden = true;
    setNotice(error.message, 'error');
  }
}

async function initialize() {
  try {
    const saved = await storage.get('estimatorSettings');
    if (saved && typeof saved === 'object') state.settings = { ...DEFAULTS, ...saved };
  } catch (error) {
    setNotice(`Using defaults; saved settings could not be loaded: ${error.message}`);
  }
  fillSettings();
}

$('gcodeFile').onchange = async () => {
  const file = $('gcodeFile').files?.[0];
  if (!file) return;
  if (file.size > 30 * 1024 * 1024) {
    setNotice('G-code files larger than 30 MB are not supported.', 'error');
    return;
  }
  try {
    state.fileText = await file.text();
    state.fileName = file.name;
    state.result = null;
    $('fileStatus').textContent = 'File ready';
    $('fileSummary').textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB · read locally`;
    $('analyzeButton').disabled = false;
    $('results').hidden = true;
    setNotice('File loaded. Review your cost assumptions, then analyze the job.');
  } catch (error) {
    setNotice(`Could not read the selected file: ${error.message}`, 'error');
  }
};

$('toolMode').onchange = async () => {
  state.settings.toolMode = $('toolMode').value;
  updateToolFields();
  await saveSettings();
};
document.querySelectorAll('.settings-grid input, .settings-grid select').forEach((control) => {
  control.addEventListener('change', async () => {
    await saveSettings();
    if (state.fileText) await analyze();
  });
});
$('analyzeButton').onclick = analyze;
initialize();

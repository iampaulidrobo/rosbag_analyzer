/**
 * Drives media/main.js inside jsdom, backed by the real Python bridge, and
 * asserts the DOM it produces. Plotly is stubbed; everything else is real.
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const EXT = new URL('..', import.meta.url).pathname;
const F = new URL('./fixtures', import.meta.url).pathname;

// ── Real Python bridge ─────────────────────────────────────────────────────
const proc = spawn('python3', ['-u', `${EXT}python/rosbag_bridge.py`]);
proc.stdout.setEncoding('utf8');
let buf = '';
const waiting = new Map();
proc.stdout.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const entry = waiting.get(msg.id);
    waiting.delete(msg.id);
    entry?.(msg);
  }
});
let pid = 0;
function bridge(cmd, args) {
  return new Promise((resolve) => {
    const id = ++pid;
    waiting.set(id, resolve);
    proc.stdin.write(JSON.stringify({ id, cmd, args }) + '\n');
  });
}

// ── jsdom environment ──────────────────────────────────────────────────────
const dom = new JSDOM(
  `<!DOCTYPE html><html><body data-plotly="true"><div id="app"></div></body></html>`,
  { runScripts: 'outside-only', pretendToBeVisual: true },
);
const { window } = dom;
const doc = window.document;

const sentToHost = [];
let savedState = null;
window.acquireVsCodeApi = () => ({
  postMessage: (m) => sentToHost.push(m),
  getState: () => savedState,
  setState: (s) => (savedState = s),
});

const plotCalls = [];
window.Plotly = {
  react: (el, traces, layout) => {
    plotCalls.push({ id: el.id, traces: traces.length, layout });
    el.data = traces;
  },
  Plots: { resize: () => {} },
};

// jsdom lacks getComputedStyle custom-property support for our vars; return blanks
// so the code exercises its fallbacks.
window.eval(readFileSync(`${EXT}media/main.js`, 'utf8'));

// ── Message plumbing: forward webview requests to the real bridge ──────────
function toWebview(msg) {
  window.dispatchEvent(new window.MessageEvent('message', { data: msg }));
}

async function pump() {
  // Service every pending request the webview made, until it stops asking.
  for (let round = 0; round < 40; round++) {
    const requests = sentToHost.filter((m) => m.type === 'request' && !m._done);
    if (!requests.length) {
      await new Promise((r) => setTimeout(r, 15));
      const again = sentToHost.filter((m) => m.type === 'request' && !m._done);
      if (!again.length) return;
      continue;
    }
    for (const req of requests) {
      req._done = true;
      const res = await bridge(req.cmd, req.args);
      toWebview({
        type: 'response',
        id: req.id,
        ok: res.ok,
        result: res.result,
        error: res.error,
        hint: res.hint,
      });
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ── Assertions ─────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
function check(label, condition, detail) {
  if (condition) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
const $ = (sel) => doc.querySelector(sel);
const $$ = (sel) => Array.from(doc.querySelectorAll(sel));
const text = () => doc.getElementById('app').textContent;

function clickAct(act) {
  const el = $$('[data-act]').find((e) => e.dataset.act === act);
  if (!el) throw new Error(`no [data-act="${act}"]`);
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}
function clickTab(id) {
  $(`[data-tab="${id}"]`).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}
function setSelect(name, value) {
  const el = $(`[data-select="${name}"]`);
  if (!el) throw new Error(`no select ${name}`);
  el.value = value;
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
}
function toggleCheck(name) {
  const el = $(`[data-check="${name}"]`);
  el.checked = !el.checked;
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
}
function setInput(name, value) {
  const el = $(`[data-input="${name}"]`);
  if (!el) throw new Error(`no input ${name}`);
  el.value = value;
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
}

// ── Run ────────────────────────────────────────────────────────────────────
console.log('== boot: ready handshake ==');
check('webview posted ready', sentToHost.some((m) => m.type === 'ready'));
// jsdom's canvas throws "Not implemented" on getContext() with no `canvas`
// package installed — a real stand-in for an environment with no WebGL at
// all. The app boots and reports it without ever surfacing an error.
const webglLog = sentToHost.filter((m) => m.type === 'log' && m.text?.includes('WebGL available')).pop();
check('WebGL absence is detected and logged, not thrown as an error',
  webglLog?.text === 'WebGL available: false (unused — all charts render via SVG/Canvas 2D)', webglLog?.text);
check('no fatal WebGL error at boot', !$('.notice.error'));

const probe = (await bridge('probe', {})).result;
toWebview({
  type: 'init',
  probe,
  settings: { maxPlotPoints: 20000 },
  request: { primary: `${F}/test.bag` },
});
await pump();

console.log('\n== Contents tab ==');
check('renders tabs', $$('nav.tabs button').length === 4);
check('shows the bag name in header', text().includes('test.bag'));
check('lists both topics', text().includes('/ground_truth/odom') && text().includes('/ekf/odom'));
check('shows message type', text().includes('nav_msgs/msg/Odometry'));
check('shows rate column', text().includes('20.05 Hz'), text().slice(0, 200));
check('shows ROS 1 format card', text().includes('ROS 1'));
check('no error notice', !$('.notice.error'), $('.notice.error')?.textContent);

console.log('\n== header: Add source and interpreter chip ==');
const addBtn = $('[data-act="add"]');
check('Add source is styled as a primary action, not a washed-out ghost button',
  addBtn?.classList.contains('action'), addBtn?.className);
clickAct('add');
const pickFileMsg = sentToHost.filter((m) => m.type === 'pickFile').pop();
check('Add source requests a file picker', Boolean(pickFileMsg));

toWebview({ type: 'sourcePicked', role: 'any', path: `${F}/test_ros2` });
await pump();
check('adding a 2nd source shows a confirmation toast', Boolean($('.toast')), doc.body.innerHTML.slice(-300));
check('adding a 2nd source is reflected in the source list', text().includes('test_ros2'));

const interpChip = $('[data-act="choose-interpreter"]');
check('python version chip is clickable to change interpreter', interpChip?.tagName === 'BUTTON');
interpChip?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const chooseInterpMsg = sentToHost.filter((m) => m.type === 'chooseInterpreter').pop();
check('interpreter chip requests the interpreter picker', Boolean(chooseInterpMsg));

console.log('\n== Signals tab ==');
clickTab('signals');
await pump();
check('field list rendered', $$('[data-field-toggle]').length > 20,
  `${$$('[data-field-toggle]').length} fields`);
check('auto-picked a time axis', $('[data-select="signal-time"]')?.value === '_time_s',
  $('[data-select="signal-time"]')?.value);
check('auto-selected x/y/z fields', $$('[data-field-toggle]:checked').length === 3,
  `${$$('[data-field-toggle]:checked').length} checked`);
check('drew a chart', plotCalls.some((c) => c.id === 'signal-chart'));
const sigCall = plotCalls.filter((c) => c.id === 'signal-chart').pop();
check('chart has 3 traces', sigCall?.traces === 3, `${sigCall?.traces}`);
check('stats table rendered', text().includes('Median') && text().includes('Statistics'));

const before = $$('[data-field-toggle]:checked').length;
const toggle = $$('[data-field-toggle]').find((e) => !e.checked);
toggle.checked = true;
toggle.dispatchEvent(new window.Event('change', { bubbles: true }));
await pump();
check('toggling a field updates selection', $$('[data-field-toggle]:checked').length === before + 1);

toggleCheck('subplots');
await pump();
const subCall = plotCalls.filter((c) => c.id === 'signal-chart').pop();
check('subplot mode builds a grid', Boolean(subCall?.layout?.grid),
  JSON.stringify(subCall?.layout?.grid));
check('subplot y-axes are titled', Boolean(subCall?.layout?.yaxis2));

console.log('\n== Trajectory tab ==');
clickTab('traj');
await pump();
check('auto-picked X column', $('[data-select="traj-x"]')?.value === 'pose.pose.position.x',
  $('[data-select="traj-x"]')?.value);
check('auto-picked Y column', $('[data-select="traj-y"]')?.value === 'pose.pose.position.y',
  $('[data-select="traj-y"]')?.value);
check('drew trajectory', plotCalls.some((c) => c.id === 'traj-chart'));
check('path length card', text().includes('Path length'));
check('start to end card', text().includes('Start to end'));
const trajCall = plotCalls.filter((c) => c.id === 'traj-chart').pop();
check('2D uses equal aspect', trajCall?.layout?.yaxis?.scaleanchor === 'x');
// Two sources are present, so the tab opens already overlaying them:
// each contributes a path trace plus a start/end marker trace.
check('overlays both sources by default', trajCall?.traces === 4, `${trajCall?.traces}`);
check('second source preselected', $('[data-select="traj-b"]')?.value.endsWith('/ekf/odom'),
  $('[data-select="traj-b"]')?.value);

// Z is depth-as-colour on an ordinary 2D chart, never a WebGL 'scatter3d'
// scene — Plotly's own capability probe can't be trusted to rule out its
// "WebGL is not supported" placeholder, so no WebGL trace type is used at all.
setSelect('traj-z', 'pose.pose.position.z');
await pump();
const trajZ = plotCalls.filter((c) => c.id === 'traj-chart').pop();
const trajZTraces = $('#traj-chart')?.data || [];
check('Z selection does not build a WebGL scene', !trajZ?.layout?.scene, JSON.stringify(trajZ?.layout));
check('Z selection never emits a scatter3d trace', trajZTraces.every((t) => t.type !== 'scatter3d'),
  JSON.stringify(trajZTraces.map((t) => t.type)));
check('Z selection still uses the 2D equal-aspect layout', trajZ?.layout?.yaxis?.scaleanchor === 'x');
check('Z is encoded as marker colour instead', trajZTraces.some((t) => t.marker?.colorscale === 'Viridis'));

check('comparison shows endpoint gap card', text().includes('Endpoint gap'));

setSelect('traj-b', '');
await pump();
const trajSolo = plotCalls.filter((c) => c.id === 'traj-chart').pop();
check('clearing the comparison drops to one path', trajSolo?.traces === 2, `${trajSolo?.traces}`);
check('endpoint gap card removed', !text().includes('Endpoint gap'));

console.log('\n== Accuracy tab: prepares TUM inputs and runs the real evo CLI ==');
clickTab('accuracy');
await pump();
check('ground truth guessed from the topic name',
  $('[data-select="acc-gt"]')?.value.endsWith('/ground_truth/odom'),
  $('[data-select="acc-gt"]')?.value);
check('estimate guessed from the topic name',
  $('[data-select="acc-est"]')?.value.endsWith('/ekf/odom'),
  $('[data-select="acc-est"]')?.value);
check('EVO command defaults to APE', $('[data-select="acc-evo-command"]')?.value === 'ape');
check('pose relation defaults to translation', $('[data-select="acc-pose-relation"]')?.value === 'trans_part');
check('alignment defaults to none', $('[data-select="acc-alignment"]')?.value === 'none');
const codeTexts = () => $$('code.inline').map((el) => el.textContent);
check('command preview shows the real CLI invocation',
  codeTexts().some((t) => /^evo_ape tum \S+\.tum \S+\.tum -r trans_part\b/.test(t)),
  JSON.stringify(codeTexts()));
check('no evo-missing warning when evo is installed', !text().includes("isn't importable"));

// This actually spawns the real evo_ape executable through the bridge —
// not a mock — so the parsed numbers are whatever evo itself reports.
clickAct('run-evo');
await pump();
check('no error after running evo', !$('.notice.error'), $('.notice.error')?.textContent);
check('command executed is shown', text().includes('Command executed'));
check('"Source: EVO" label shown, not "evo-style"', text().includes('Source: EVO') && !text().includes('evo-style'));
check('APE cards rendered from evo stats', $$('.cards .card').length >= 8, `${$$('.cards .card').length} cards`);
check('error-over-time chart drawn from evo per-pose data', plotCalls.some((c) => c.id === 'acc-err-chart'));
check('histogram drawn', plotCalls.some((c) => c.id === 'acc-hist-chart'));
check('export evaluation button appears once a result exists', Boolean($('[data-act="export-evaluation"]')));

clickAct('copy-command');
const copyMsg = sentToHost.filter((m) => m.type === 'copy').pop();
check('copy posts the exact command evo ran', copyMsg?.text?.split(' ')[0].endsWith('evo_ape'), copyMsg?.text);

clickAct('toggle-evo-output');
await pump();
check('raw evo stdout shown once toggled', $$('.output-box').length > 0);

clickAct('export-evaluation');
const evalMsg = sentToHost.filter((m) => m.type === 'exportEvaluation').pop();
check('evaluation package export requested', Boolean(evalMsg));
check('evaluation export carries the evo command', evalMsg?.args?.evoCommand === 'ape', JSON.stringify(evalMsg?.args));

console.log('\n== SE(3) alignment changes the constructed command ==');
setSelect('acc-alignment', 'se3');
await pump();
check('command preview includes -a once SE3 is selected',
  codeTexts().some((t) => / -a(\s|$)/.test(t)), JSON.stringify(codeTexts()));
clickAct('run-evo');
await pump();
check('no error after aligned run', !$('.notice.error'), $('.notice.error')?.textContent);
check('the command evo actually ran included -a',
  codeTexts().some((t) => t.startsWith('/') && / -a(\s|$)/.test(t)), JSON.stringify(codeTexts()));

console.log('\n== RPE ==');
setSelect('acc-evo-command', 'rpe');
await pump();
check('delta field appears for RPE', Boolean($('[data-input="acc-delta"]')));
check('delta unit field appears for RPE', Boolean($('[data-select="acc-delta-unit"]')));
check('point distance error ratio only offered for RPE',
  Array.from($('[data-select="acc-pose-relation"]').options).some((o) => o.value === 'point_distance_error_ratio'));
clickAct('run-evo');
await pump();
check('no error after RPE run', !$('.notice.error'), $('.notice.error')?.textContent);
check('RPE label rendered with Source: EVO', text().includes('RPE') && text().includes('Source: EVO'));
check('RPE command actually ran evo_rpe', codeTexts().some((t) => t.endsWith('evo_rpe') || t.includes('/evo_rpe ')));

console.log('\n== custom evo arguments ==');
setSelect('acc-evo-command', 'ape');
await pump();
toggleCheck('acc-use-custom-args');
check('pose relation hidden once custom args are enabled', !$('[data-select="acc-pose-relation"]'));
check('alignment hidden once custom args are enabled', !$('[data-select="acc-alignment"]'));
setInput('acc-custom-args', '-r trans_part -a --t_max_diff 0.02');
check('command preview reflects the typed custom args',
  codeTexts().some((t) => t.includes('-r trans_part -a --t_max_diff 0.02')), JSON.stringify(codeTexts()));
clickAct('run-evo');
await pump();
check('no error after a custom-args run', !$('.notice.error'), $('.notice.error')?.textContent);
check('the command evo actually ran used the typed custom args',
  codeTexts().some((t) => t.startsWith('/') && t.includes('-r trans_part -a --t_max_diff 0.02')),
  JSON.stringify(codeTexts()));
toggleCheck('acc-use-custom-args');
check('pose relation reappears once custom args are disabled', Boolean($('[data-select="acc-pose-relation"]')));

console.log('\n== evo_traj ==');
setSelect('acc-evo-command', 'traj');
await pump();
check('pose relation hidden for traj', !$('[data-select="acc-pose-relation"]'));
check('alignment hidden for traj', !$('[data-select="acc-alignment"]'));
clickAct('run-evo');
await pump();
check('no error after traj run', !$('.notice.error'), $('.notice.error')?.textContent);
check('evo_traj raw output shown', text().includes('evo_traj output'));

console.log('\n== CSV source ==');
toWebview({ type: 'sourcePicked', role: 'any', path: `${F}/gt.csv` });
await pump();
clickTab('topics');
await pump();
check('CSV file listed', text().includes('gt.csv'));
check('CSV columns listed', text().includes('pos_x') && text().includes('CSV table'));

console.log('\n== export a topic as CSV ==');
const exportBtn = $$('[data-act="export-topic"]')[0];
exportBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const topicExportMsg = sentToHost.filter((m) => m.type === 'exportTopic').pop();
check('topic export requested', Boolean(topicExportMsg));
check('topic export names the source topic', Boolean(topicExportMsg?.source?.topic));
check('topic export filename derived from the topic name', topicExportMsg?.filename.endsWith('.csv'),
  topicExportMsg?.filename);

console.log('\n== export a topic as TUM ==');
const tumBtn = $$('[data-act="export-tum"]')[0];
tumBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const tumExportMsg = sentToHost.filter((m) => m.type === 'exportTum').pop();
check('TUM export requested', Boolean(tumExportMsg));
check('TUM export filename ends in .tum', tumExportMsg?.filename.endsWith('.tum'), tumExportMsg?.filename);

console.log('\n== create a derived topic (manual reference) ==');
clickAct('create-derived');
await pump();
check('derive form opened', Boolean($('[data-act="derive-submit"]')));
setInput('derive-name', '/gt_offset_manual');
setInput('derive-tx', '1');
setInput('derive-ty', '2');
setInput('derive-tz', '0');
clickAct('derive-submit');
await pump();
check('no error after manual derive', !$('.derive-form .notice.error'), $('.derive-form .notice.error')?.textContent);
check('derived topic listed in Contents', text().includes('/gt_offset_manual'));
check('derive form closed on success', !$('[data-act="derive-submit"]'));
check('confirmation toast shown', doc.body.innerHTML.includes('toast'));

console.log('\n== create a derived topic (TF reference) ==');
clickAct('create-derived');
await pump();
setSelect('derive-topic', '/ground_truth/odom');
setInput('derive-name', '/gt_in_map');
setSelect('derive-ref-type', 'tf');
await pump();
check('TF frame pickers populated from list_frames', $$('[data-select="derive-tf-parent"] option').length >= 2,
  text().slice(0, 400));
setSelect('derive-tf-parent', 'map');
setSelect('derive-tf-child', 'odom');
check('known edges hint shown', text().includes('map') && text().includes('odom') && text().includes('static'));
clickAct('derive-submit');
await pump();
check('no error after TF derive', !$('.derive-form .notice.error'), $('.derive-form .notice.error')?.textContent);
check('TF-derived topic listed in Contents', text().includes('/gt_in_map'));

console.log('\n== derived topic rejects a duplicate name ==');
clickAct('create-derived');
await pump();
setInput('derive-name', '/gt_in_map');
clickAct('derive-submit');
await pump();
check('duplicate name surfaces an inline error', Boolean($('.derive-form .notice.error')),
  'form: ' + (doc.querySelector('.derive-form')?.textContent || '(closed)'));
check('form stays open on error so the user can fix the name', Boolean($('[data-act="derive-submit"]')));
clickAct('derive-cancel');
check('cancel closes the form', !$('[data-act="derive-submit"]'));

console.log('\n== ROS 2 bag folder ==');
toWebview({ type: 'sourcePicked', role: 'any', path: `${F}/test_ros2` });
await pump();
check('ROS 2 folder added', text().includes('test_ros2'));
check('ROS 2 format card', text().includes('ROS 2'));

console.log('\n== error handling ==');
toWebview({ type: 'fatal', error: 'Simulated failure', hint: 'Try again' });
check('fatal renders an error notice', Boolean($('.notice.error')));
check('hint shown', text().includes('Try again'));
clickAct('dismiss');
check('dismiss clears it', !$('.notice.error'));

console.log('\n== state persistence ==');
check('tab persisted to host state', savedState?.tab === 'topics', JSON.stringify(savedState));
clickTab('traj');
await pump();
check('persisted tab follows navigation', savedState?.tab === 'traj', JSON.stringify(savedState));

console.log(`\n${pass} passed, ${fail} failed`);
proc.stdin.end();
process.exit(fail ? 1 : 0);

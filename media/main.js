/* Rosbag Analyzer — webview application.
   Plain DOM, no framework: the panel is small enough that a build step for the
   UI would cost more than it saves. */

(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const hasPlotly = document.body.dataset.plotly === 'true' && typeof Plotly !== 'undefined';

  // Every chart (Signals, Trajectory, APE/RPE) renders with Plotly's plain
  // SVG 'scatter'/'histogram' traces — nothing in this file ever requests
  // 'scatter3d', 'scattergl', or a WebGL `scene` layout. That's deliberate:
  // Plotly's own capability probe (`canvas.getContext('webgl')` returning a
  // context object) can say "yes" in an environment where its actual gl3d/gl2d
  // renderer still fails, in which case Plotly silently swaps the chart for
  // its own "WebGL is not supported" placeholder — a false positive no
  // upfront check can fully rule out. Avoiding every WebGL-only trace type
  // sidesteps that failure mode entirely instead of trying to predict it.
  // This flag is kept only as a one-line diagnostic (see the `ready` message
  // below) — no rendering decision in this file branches on it.
  const webglAvailable = (() => {
    try {
      const canvas = document.createElement('canvas');
      return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
    } catch (err) {
      return false;
    }
  })();

  const SERIES_COLORS = [
    '#4c8bf5', '#22a06b', '#e2554e', '#8a63d2',
    '#e08b2f', '#d1568f', '#2aa8b0', '#9aa524',
  ];

  // ── State ────────────────────────────────────────────────────────────────

  const state = {
    probe: null,
    settings: { maxPlotPoints: 20000 },
    files: [],
    tab: 'topics',
    busy: false,
    error: null,
    fields: new Map(),
    signals: { key: null, time: null, fields: [], subplots: false },
    traj: { keyA: null, keyB: null, x: null, y: null, z: '', colorByTime: true },
    // The Accuracy tab is a thin GUI around the real evo CLI: it prepares
    // TUM inputs and runs evo_ape/evo_rpe/evo_traj, then displays exactly
    // what evo reports. No APE/RPE/sync/rotation-error math happens here.
    acc: {
      gt: null, est: null,
      evoCommand: 'ape', poseRelation: 'trans_part', alignment: 'none',
      tMaxDiff: 0.01, delta: 1, deltaUnit: 'f', allPairs: false, pairsFromReference: false,
      // Escape hatch for evo flags the GUI doesn't expose (--correct_scale,
      // --n_to_align, --plot_mode, ...): when set, these replace every
      // GUI-built flag above rather than merging with them — evo still runs
      // as the real executable against the same exported TUM files.
      useCustomArgs: false, customArgs: '',
      result: null, showOutput: false,
    },
    // Create-derived-topic form: transforms an existing bag topic into a new
    // one, expressed in a different frame (a manual offset, or one looked up
    // from the bag's own /tf + /tf_static data). Session-only — never
    // touches the original bag file. `path` null means the form is closed.
    derive: {
      path: null, topic: null, name: '', refType: 'manual',
      manual: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
      tfParent: null, tfChild: null, invert: false,
      frames: null, framesError: null, busy: false, error: null,
    },
  };

  const saved = vscode.getState();
  if (saved && saved.tab) {
    state.tab = saved.tab;
  }

  function persist() {
    vscode.setState({ tab: state.tab });
  }

  // ── RPC ──────────────────────────────────────────────────────────────────

  let rpcId = 0;
  const inflight = new Map();

  function rpc(cmd, args) {
    const id = ++rpcId;
    return new Promise((resolve, reject) => {
      inflight.set(id, { resolve, reject });
      vscode.postMessage({ type: 'request', id, cmd, args: args || {} });
    });
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'init':
        state.probe = msg.probe;
        state.settings = Object.assign(state.settings, msg.settings || {});
        render();
        void bootstrap(msg.request || {});
        break;

      case 'settings':
        state.settings = Object.assign(state.settings, msg.settings || {});
        render();
        break;

      case 'response': {
        const entry = inflight.get(msg.id);
        if (!entry) {
          return;
        }
        inflight.delete(msg.id);
        if (msg.ok) {
          entry.resolve(msg.result);
        } else {
          const err = new Error(msg.error);
          err.hint = msg.hint;
          entry.reject(err);
        }
        break;
      }

      case 'sourcePicked':
        // Adding a 2nd/3rd source doesn't change the header (which only ever
        // shows the first file's path) or switch tabs, so without an explicit
        // confirmation here, a successful "Add source" looks like it did
        // nothing at all.
        void addFile(msg.path).then((file) => {
          if (file) {
            toast('Added ' + file.name);
          } else if (!state.error) {
            toast('Already open: ' + msg.path.split(/[\\/]/).pop());
          }
          render();
        });
        break;

      case 'fatal':
        state.error = { message: msg.error, hint: msg.hint };
        render();
        break;

      case 'reload':
        // A restarted bag reader (new interpreter, managed-env setup
        // finishing, etc.) can flip whether rosbags/pandas/numpy/evo are
        // importable — without refreshing state.probe here, the header chip
        // and "rosbags missing" banner would stay stuck on whatever was true
        // when the panel first opened until it's fully closed and reopened.
        if (msg.probe !== undefined) {
          state.probe = msg.probe;
        }
        state.fields.clear();
        state.acc.result = null;
        void reloadAll();
        break;

      case 'toast':
        toast(msg.text);
        break;
    }
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
    );
  }

  function bytes(n) {
    if (!n) {
      return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
    return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + units[i];
  }

  function num(v, digits) {
    if (v === null || v === undefined || Number.isNaN(v)) {
      return '—';
    }
    const d = digits === undefined ? 4 : digits;
    if (v !== 0 && Math.abs(v) < 1e-4) {
      return v.toExponential(2);
    }
    return v.toFixed(d);
  }

  function toast(text) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }

  function cssVar(name, fallback) {
    const value = getComputedStyle(document.body).getPropertyValue(name).trim();
    return value || fallback;
  }

  /** Plotly layout that follows the active VS Code theme. */
  function plotLayout(extra) {
    const fg = cssVar('--vscode-foreground', '#ccc');
    const grid = cssVar('--vscode-panel-border', 'rgba(128,128,128,0.25)');
    const base = {
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { color: fg, family: cssVar('--vscode-font-family', 'sans-serif'), size: 11 },
      margin: { l: 58, r: 18, t: 26, b: 40 },
      xaxis: { gridcolor: grid, zerolinecolor: grid, linecolor: grid },
      yaxis: { gridcolor: grid, zerolinecolor: grid, linecolor: grid },
      showlegend: true,
      legend: { orientation: 'h', y: 1.12, x: 0, font: { size: 10 } },
      hovermode: 'x unified',
    };
    return Object.assign(base, extra || {});
  }

  const PLOT_CONFIG = {
    displaylogo: false,
    responsive: true,
    modeBarButtonsToRemove: ['select2d', 'lasso2d'],
    toImageButtonOptions: { format: 'png', scale: 2 },
  };

  function draw(id, traces, layout) {
    const el = document.getElementById(id);
    if (!el) {
      return;
    }
    if (!hasPlotly) {
      el.innerHTML =
        '<div class="empty">Charts need the bundled plotly.js. Run <code class="inline">npm run vendor</code> in the extension folder, then reload the window.</div>';
      return;
    }
    Plotly.react(el, traces, plotLayout(layout), PLOT_CONFIG);
  }

  // ── Sources ──────────────────────────────────────────────────────────────

  function keyOf(path, topic) {
    return path + '::' + (topic || '');
  }

  function parseKey(key) {
    const at = key.lastIndexOf('::');
    return { path: key.slice(0, at), topic: key.slice(at + 2) || undefined };
  }

  function sourceList() {
    const out = [];
    for (const file of state.files) {
      if (file.kind === 'csv') {
        out.push({ key: keyOf(file.path, ''), label: file.name, sub: file.info.rows + ' rows' });
      } else {
        for (const topic of file.info.topics) {
          out.push({
            key: keyOf(file.path, topic.topic),
            label: (state.files.length > 1 ? file.name + ' · ' : '') + topic.topic,
            sub: topic.messages + ' msgs',
          });
        }
      }
    }
    return out;
  }

  function labelFor(key) {
    const found = sourceList().find((s) => s.key === key);
    return found ? found.label : key;
  }

  async function addFile(path) {
    if (!path || state.files.some((f) => f.path === path)) {
      return null;
    }
    state.busy = true;
    render();
    try {
      const info = await rpc('inspect', { path });
      const file = { path: info.path, name: info.name, kind: info.kind, info };
      state.files.push(file);
      return file;
    } catch (err) {
      state.error = { message: err.message, hint: err.hint };
      return null;
    } finally {
      state.busy = false;
    }
  }

  async function refreshFile(path) {
    const index = state.files.findIndex((f) => f.path === path);
    if (index < 0) {
      return;
    }
    try {
      const info = await rpc('inspect', { path });
      state.files[index] = { path: info.path, name: info.name, kind: info.kind, info };
    } catch (err) {
      state.error = { message: err.message, hint: err.hint };
    }
  }

  async function fieldsFor(key) {
    if (!key) {
      return null;
    }
    if (state.fields.has(key)) {
      return state.fields.get(key);
    }
    const { path, topic } = parseKey(key);
    const result = await rpc('fields', topic ? { path, topic } : { path });
    state.fields.set(key, result);
    return result;
  }

  async function reloadAll() {
    const paths = state.files.map((f) => f.path);
    state.files = [];
    for (const path of paths) {
      await addFile(path);
    }
    render();
  }

  // Which of two topics is the reference and which is the thing being measured
  // is guessable from the name, and guessing wrong inverts the sign of every
  // bias in the report.
  const TRUTH_WORDS = ['ground_truth', 'groundtruth', 'ground truth', 'truth', '/gt', 'gt_', 'vicon',
    'mocap', 'optitrack', 'reference', '/ref', 'leica', 'rtk'];
  const ESTIMATE_WORDS = ['ekf', 'ukf', 'estimate', 'estimated', 'predict', 'slam', 'vio', 'lio',
    'fused', 'filtered', 'localization', 'amcl'];

  function rank(source, words) {
    const label = source.label.toLowerCase();
    const index = words.findIndex((word) => label.indexOf(word) >= 0);
    return index < 0 ? words.length : index;
  }

  function guessRoles(sources) {
    if (sources.length < 2) {
      return { gt: sources[0] && sources[0].key, est: sources[0] && sources[0].key };
    }
    const truth = sources.slice().sort((a, b) => rank(a, TRUTH_WORDS) - rank(b, TRUTH_WORDS))[0];
    const others = sources.filter((s) => s.key !== truth.key);
    const estimate = others.slice().sort((a, b) => rank(a, ESTIMATE_WORDS) - rank(b, ESTIMATE_WORDS))[0];
    const truthMatched = rank(truth, TRUTH_WORDS) < TRUTH_WORDS.length;
    const estimateMatched = rank(estimate, ESTIMATE_WORDS) < ESTIMATE_WORDS.length;
    if (truthMatched || estimateMatched) {
      return { gt: truth.key, est: estimate.key };
    }
    return { gt: sources[0].key, est: sources[1].key };
  }

  async function bootstrap(request) {
    if (request.primary) {
      await addFile(request.primary);
    }
    if (request.secondary) {
      await addFile(request.secondary);
    }
    const sources = sourceList();
    if (sources.length) {
      const roles = guessRoles(sources);
      state.signals.key = sources[0].key;
      state.traj.keyA = roles.gt;
      state.traj.keyB = sources.length > 1 ? roles.est : null;
      state.acc.gt = roles.gt;
      state.acc.est = roles.est;
    }
    render();
    await enterTab();
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  const TABS = [
    { id: 'topics', label: 'Contents' },
    { id: 'signals', label: 'Signals' },
    { id: 'traj', label: 'Trajectory' },
    { id: 'accuracy', label: 'Accuracy' },
  ];

  function render() {
    const file = state.files[0];
    const parts = [];

    parts.push('<header class="bar">');
    parts.push('<h1>Rosbag Analyzer</h1>');
    if (file) {
      parts.push('<span class="path" title="' + esc(file.path) + '">' + esc(file.path) + '</span>');
    }
    parts.push('<span class="spacer"></span>');
    if (state.busy) {
      parts.push('<span class="chip"><span class="spinner"></span> working</span>');
    }
    if (state.probe && !state.probe.rosbags) {
      parts.push('<span class="chip warn">rosbags missing</span>');
    }
    // Always show the interpreter chip, even when there's no probe yet (the
    // bag reader hasn't started, or failed to start with a broken
    // interpreter) — that's exactly when the user most needs a visible,
    // clickable way to fix it, not the moment to hide the chip entirely.
    parts.push(
      '<button class="chip' + (state.probe ? '' : ' warn') + '" data-act="choose-interpreter" title="' +
      (state.probe
        ? esc(state.probe.versions.executable || '') + ' — click to use a different interpreter'
        : 'No working Python interpreter yet — click to choose one') +
      '">' +
      (state.probe ? 'python ' + esc(state.probe.versions.python) : 'python: not detected') +
      '</button>',
    );
    parts.push('<button class="action" data-act="add">Add source…</button>');
    parts.push('</header>');

    parts.push('<nav class="tabs" role="tablist">');
    for (const tab of TABS) {
      parts.push(
        '<button role="tab" data-tab="' + tab.id + '" aria-selected="' +
          (state.tab === tab.id) + '">' + tab.label + '</button>',
      );
    }
    parts.push('</nav>');

    parts.push('<main>');
    if (state.error) {
      parts.push(renderError(state.error));
    }
    if (state.probe && !state.probe.rosbags) {
      parts.push(renderMissingRosbags());
    }
    if (!state.files.length) {
      parts.push(renderWelcome());
    } else {
      switch (state.tab) {
        case 'topics':
          parts.push(renderContents());
          break;
        case 'signals':
          parts.push(renderSignals());
          break;
        case 'traj':
          parts.push(renderTrajectory());
          break;
        case 'accuracy':
          parts.push(renderAccuracy());
          break;
      }
    }
    parts.push('</main>');

    app.innerHTML = parts.join('');
    wire();
    paint();
  }

  function renderError(err) {
    return (
      '<div class="notice error"><h4>' + esc(err.message) + '</h4>' +
      (err.hint ? '<p>' + esc(err.hint) + '</p>' : '') +
      '<div class="actions">' +
      '<button class="ghost" data-act="dismiss">Dismiss</button>' +
      '<button class="ghost" data-act="log">Show log</button>' +
      '</div></div>'
    );
  }

  function renderMissingRosbags() {
    const exe = state.probe.versions.executable || 'python3';
    return (
      '<div class="notice warn"><h4>This interpreter cannot read bags yet</h4>' +
      '<p>CSV files work now. Reading <code>.bag</code>, <code>.db3</code> and <code>.mcap</code> needs the ' +
      '<code>rosbags</code> package in <code>' + esc(exe) + '</code>.</p>' +
      '<div class="actions">' +
      '<button class="ghost" data-act="install">Install rosbags</button>' +
      '<button class="ghost" data-act="choose-interpreter">Choose a different interpreter</button>' +
      '</div></div>'
    );
  }

  function renderWelcome() {
    return (
      '<div class="notice"><h4>Open a bag or a table to begin</h4>' +
      '<p>Reads ROS 1 <code>.bag</code>, ROS 2 bag folders, <code>.db3</code>, <code>.mcap</code>, ' +
      'and CSV exported with <code>rostopic echo -p</code> — no ROS installation needed.</p>' +
      '<div class="actions"><button class="action" data-act="add">Choose a file…</button></div></div>'
    );
  }

  // ── Tab: Contents ────────────────────────────────────────────────────────

  function renderContents() {
    const out = [];
    for (const file of state.files) {
      const info = file.info;
      out.push('<h3 class="section">' + esc(file.name) + '</h3>');

      if (file.kind === 'csv') {
        const numeric = info.columns.filter((c) => c.numeric).length;
        out.push(
          '<div class="cards">' +
            card('Kind', 'CSV table') +
            card('Rows', info.rows.toLocaleString()) +
            card('Columns', info.columns.length, numeric + ' numeric') +
            card('Size', bytes(info.sizeBytes)) +
            '</div>',
        );
        out.push('<div class="table-wrap"><table><thead><tr>');
        out.push('<th>Column</th><th>Type</th><th class="num">Plot</th>');
        out.push('</tr></thead><tbody>');
        for (const column of info.columns) {
          out.push(
            '<tr><td class="name">' + esc(column.name) + '</td>' +
              '<td class="type">' + esc(column.dtype) + '</td>' +
              '<td class="num">' +
              (column.numeric
                ? '<button class="link" data-act="plot" data-key="' + esc(keyOf(file.path, '')) +
                  '" data-field="' + esc(column.name) + '">plot</button>'
                : '—') +
              '</td></tr>',
          );
        }
        out.push('</tbody></table></div>');
        continue;
      }

      out.push(
        '<div class="cards">' +
          card('Format', info.kind === 'ros2' ? 'ROS 2' : 'ROS 1') +
          card('Topics', info.topics.length) +
          card('Messages', info.totalMessages.toLocaleString()) +
          card('Duration', info.duration.toFixed(2) + ' s') +
          card('Size', bytes(info.sizeBytes)) +
          '</div>',
      );

      out.push(
        '<button class="action" data-act="create-derived" data-path="' + esc(file.path) +
        '" title="Re-express an existing pose topic in a different frame and add it as a new topic">' +
        'Create derived topic…</button>',
      );
      if (state.derive.path === file.path) {
        out.push(renderDeriveForm(file));
      }

      out.push('<div class="table-wrap"><table><thead><tr>');
      out.push('<th>Topic</th><th>Message type</th><th class="num">Messages</th>');
      out.push('<th class="num">Rate</th><th class="num">Duration</th><th></th><th></th><th></th>');
      out.push('</tr></thead><tbody>');
      for (const topic of info.topics) {
        const key = keyOf(file.path, topic.topic);
        out.push(
          '<tr><td class="name" title="' + esc(topic.topic) + '">' + esc(topic.topic) + '</td>' +
            '<td class="type">' + esc(topic.type) + '</td>' +
            '<td class="num">' + topic.messages.toLocaleString() + '</td>' +
            '<td class="num">' + (topic.hz ? topic.hz + ' Hz' : '—') + '</td>' +
            '<td class="num">' + topic.duration.toFixed(2) + ' s</td>' +
            '<td class="num">' +
            '<button class="link" data-act="inspect-topic" data-key="' + esc(key) + '">open</button>' +
            '</td><td class="num">' +
            '<button class="link" data-act="export-topic" data-key="' + esc(key) +
            '" title="Decode every field of this topic and save it as a CSV file">csv</button>' +
            '</td><td class="num">' +
            '<button class="link" data-act="export-tum" data-key="' + esc(key) +
            '" title="Export this topic as a standard TUM trajectory file (timestamp x y z qx qy qz qw), usable directly with evo_ape/evo_rpe">tum</button>' +
            '</td></tr>',
        );
      }
      out.push('</tbody></table></div>');
    }
    return out.join('');
  }

  function renderDeriveForm(file) {
    const d = state.derive;
    const topics = file.info.topics.map((t) => t.topic);
    const out = ['<div class="derive-form">'];

    out.push('<div class="controls">');
    out.push(
      '<div class="field grow"><label>Source topic</label>' +
      columnSelect('derive-topic', topics, d.topic, false) + '</div>',
    );
    out.push(
      '<div class="field grow"><label>New topic name</label>' +
      '<input data-input="derive-name" value="' + esc(d.name) + '" placeholder="/topic_in_map"></div>',
    );
    out.push('</div>');

    out.push('<div class="controls">');
    out.push(
      '<div class="field"><label>Reference</label><select data-select="derive-ref-type">' +
      '<option value="manual"' + (d.refType === 'manual' ? ' selected' : '') + '>Manual transform</option>' +
      '<option value="tf"' + (d.refType === 'tf' ? ' selected' : '') + '>From this bag’s /tf</option>' +
      '</select></div>',
    );
    out.push(
      '<div class="field"><label style="visibility:hidden">Invert</label>' +
      '<label class="check"><input type="checkbox" data-check="derive-invert"' +
      (d.invert ? ' checked' : '') + '> Invert (express result in the other frame)</label></div>',
    );
    out.push('</div>');

    if (d.refType === 'manual') {
      out.push('<div class="controls">');
      for (const axis of ['tx', 'ty', 'tz', 'qx', 'qy', 'qz', 'qw']) {
        out.push(
          '<div class="field"><label>' + axis + '</label>' +
          '<input type="number" step="any" data-input="derive-' + axis + '" value="' + d.manual[axis] + '"></div>',
        );
      }
      out.push('</div>');
      out.push(
        '<div class="hint">Result = R(q) · original + t. Leave at the identity (0,0,0,0,0,0,1) and it’s a no-op ' +
        '— useful for previewing before you enter a real offset.</div>',
      );
    } else {
      out.push('<div class="controls">');
      out.push(
        '<div class="field grow"><label>Parent frame (the topic’s new frame)</label>' +
        columnSelect('derive-tf-parent', (d.frames && d.frames.frames) || [], d.tfParent, false) + '</div>',
      );
      out.push(
        '<div class="field grow"><label>Child frame (the frame this topic is in now)</label>' +
        columnSelect('derive-tf-child', (d.frames && d.frames.frames) || [], d.tfChild, false) + '</div>',
      );
      out.push('</div>');
      if (d.framesError) {
        out.push('<div class="hint">Could not read /tf: ' + esc(d.framesError) + '</div>');
      } else if (!d.frames) {
        out.push('<div class="hint">Reading /tf…</div>');
      } else if (!d.frames.frames.length) {
        out.push('<div class="hint">No /tf or /tf_static data found in this bag — use a manual transform instead.</div>');
      } else if (d.frames.edges.length) {
        out.push(
          '<div class="hint">Known edges: ' +
          d.frames.edges
            .map((e) => esc(e.parent) + ' → ' + esc(e.child) + (e.static ? ' (static)' : ' (' + e.count + ' samples, dynamic)'))
            .join(', ') +
          '. Only directly-published edges are supported, not a multi-hop chain.</div>',
        );
      }
    }

    if (d.error) {
      out.push('<div class="notice error"><h4>' + esc(d.error) + '</h4></div>');
    }

    out.push('<div class="controls">');
    out.push(
      '<button class="action" data-act="derive-submit"' + (d.busy ? ' disabled' : '') + '>' +
      (d.busy ? 'Creating…' : 'Create') + '</button>',
    );
    out.push('<button class="ghost" data-act="derive-cancel">Cancel</button>');
    out.push('</div>');

    out.push('</div>');
    return out.join('');
  }

  function card(k, v, sub) {
    return (
      '<div class="card"><div class="k">' + esc(k) + '</div><div class="v" title="' + esc(v) + '">' +
      esc(v) + '</div>' + (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') + '</div>'
    );
  }

  function sourceSelect(id, selected) {
    const options = sourceList()
      .map(
        (s) =>
          '<option value="' + esc(s.key) + '"' + (s.key === selected ? ' selected' : '') + '>' +
          esc(s.label) + ' (' + esc(s.sub) + ')</option>',
      )
      .join('');
    return '<select data-select="' + id + '">' + options + '</select>';
  }

  function columnSelect(id, columns, selected, allowNone) {
    const options = (allowNone ? '<option value="">— none —</option>' : '') +
      columns
        .map(
          (c) =>
            '<option value="' + esc(c) + '"' + (c === selected ? ' selected' : '') + '>' + esc(c) +
            '</option>',
        )
        .join('');
    return '<select data-select="' + id + '">' + options + '</select>';
  }

  // ── Tab: Signals ─────────────────────────────────────────────────────────

  function renderSignals() {
    const meta = state.fields.get(state.signals.key);
    const out = [];

    out.push('<div class="controls">');
    out.push('<div class="field grow"><label>Source</label>' + sourceSelect('signal-source', state.signals.key) + '</div>');
    if (meta) {
      out.push(
        '<div class="field"><label>X axis</label>' +
          columnSelect('signal-time', meta.timeCandidates.concat(
            meta.numeric.filter((c) => meta.timeCandidates.indexOf(c) < 0),
          ), state.signals.time) +
          '</div>',
      );
      out.push(
        '<div class="field"><label style="visibility:hidden">Layout</label>' +
          '<label class="check"><input type="checkbox" data-check="subplots"' +
          (state.signals.subplots ? ' checked' : '') + '> One subplot per field</label></div>',
      );
    }
    out.push('</div>');

    if (!meta) {
      out.push('<div class="empty">Reading fields…</div>');
      return out.join('');
    }

    const plottable = meta.numeric.filter((c) => c !== state.signals.time);
    out.push('<h3 class="section">Fields — ' + state.signals.fields.length + ' of ' + plottable.length + ' selected</h3>');
    out.push('<div class="field-list">');
    plottable.forEach((column) => {
      const index = state.signals.fields.indexOf(column);
      const colour = index >= 0 ? SERIES_COLORS[index % SERIES_COLORS.length] : 'transparent';
      out.push(
        '<label title="' + esc(column) + '"><input type="checkbox" data-field-toggle="' + esc(column) + '"' +
          (index >= 0 ? ' checked' : '') + '>' +
          '<span class="swatch" style="background:' + colour + '"></span>' +
          '<span>' + esc(column) + '</span></label>',
      );
    });
    out.push('</div>');

    out.push('<div class="row" style="margin-top:12px">');
    out.push('<button class="ghost" data-act="signal-clear">Clear all</button>');
    out.push('<span class="hint" style="margin:0">' + meta.rows.toLocaleString() + ' samples</span>');
    out.push('</div>');

    if (state.signals.fields.length) {
      out.push('<div class="chart" id="signal-chart" style="height:' +
        (state.signals.subplots ? Math.max(240, 150 * state.signals.fields.length) : 380) + 'px"></div>');
      out.push('<h3 class="section">Statistics</h3>');
      out.push('<div id="signal-stats"></div>');
    } else {
      out.push('<div class="empty">Select a field above to plot it.</div>');
    }
    return out.join('');
  }

  async function prepareSignals() {
    const sources = sourceList();
    if (!state.signals.key && sources.length) {
      state.signals.key = sources[0].key;
    }
    if (!state.signals.key) {
      return;
    }
    const needsFetch = !state.fields.has(state.signals.key);
    if (needsFetch) {
      state.busy = true;
      render();
    }
    try {
      const meta = await fieldsFor(state.signals.key);
      if (!state.signals.time || meta.numeric.indexOf(state.signals.time) < 0) {
        state.signals.time = meta.timeColumn || meta.numeric[0];
      }
      state.signals.fields = state.signals.fields.filter((f) => meta.numeric.indexOf(f) >= 0);
      if (!state.signals.fields.length) {
        const preferred = ['x', 'y', 'z'].map((a) => meta.suggested[a]).filter(Boolean);
        state.signals.fields = (preferred.length
          ? preferred
          : meta.numeric.filter((c) => c !== state.signals.time).slice(0, 3)
        ).slice(0, 6);
      }
    } catch (err) {
      state.error = { message: err.message, hint: err.hint };
    } finally {
      state.busy = false;
      render();
    }
  }

  async function paintSignals() {
    if (!state.signals.fields.length || !state.signals.key) {
      return;
    }
    const { path, topic } = parseKey(state.signals.key);
    const fields = state.signals.fields.concat([state.signals.time]);
    try {
      const data = await rpc('series', {
        path,
        topic,
        fields: Array.from(new Set(fields)),
        maxPoints: state.settings.maxPlotPoints,
      });
      const x = data.series[state.signals.time];
      const traces = state.signals.fields.map((field, i) => ({
        type: 'scatter',
        mode: 'lines',
        name: field.length > 30 ? '…' + field.slice(-28) : field,
        x,
        y: data.series[field],
        line: { width: 1.4, color: SERIES_COLORS[i % SERIES_COLORS.length] },
        yaxis: state.signals.subplots ? (i === 0 ? 'y' : 'y' + (i + 1)) : 'y',
        hovertemplate: '%{y:.5g}<extra>' + esc(field) + '</extra>',
      }));

      let layout;
      if (state.signals.subplots) {
        layout = { showlegend: false, grid: { rows: state.signals.fields.length, columns: 1, pattern: 'independent' } };
        const grid = cssVar('--vscode-panel-border', 'rgba(128,128,128,0.25)');
        state.signals.fields.forEach((field, i) => {
          layout['yaxis' + (i ? i + 1 : '')] = {
            title: { text: field.length > 18 ? '…' + field.slice(-16) : field, font: { size: 9 } },
            gridcolor: grid,
            zerolinecolor: grid,
          };
          layout['xaxis' + (i ? i + 1 : '')] = { gridcolor: grid, matches: 'x', showticklabels: i === state.signals.fields.length - 1 };
        });
        layout.margin = { l: 70, r: 18, t: 12, b: 34 };
      } else {
        layout = { xaxis: Object.assign(plotLayout().xaxis, { title: { text: state.signals.time, font: { size: 10 } } }) };
      }

      draw('signal-chart', traces, layout);

      const statsEl = document.getElementById('signal-stats');
      if (statsEl) {
        const rows = state.signals.fields
          .map((field) => {
            const s = data.stats[field];
            if (!s) {
              return '';
            }
            return (
              '<tr><td class="name">' + esc(field) + '</td>' +
              ['count', 'mean', 'std', 'min', 'p50', 'max']
                .map((k) => '<td class="num">' + (k === 'count' ? s[k].toLocaleString() : num(s[k])) + '</td>')
                .join('') +
              '</tr>'
            );
          })
          .join('');
        statsEl.innerHTML =
          '<div class="table-wrap"><table><thead><tr><th>Field</th><th class="num">Count</th>' +
          '<th class="num">Mean</th><th class="num">Std</th><th class="num">Min</th>' +
          '<th class="num">Median</th><th class="num">Max</th></tr></thead><tbody>' +
          rows + '</tbody></table></div>' +
          (data.decimated
            ? '<p class="hint" style="margin-top:8px">Chart shows ' + data.returned.toLocaleString() +
              ' of ' + data.rows.toLocaleString() +
              ' samples; statistics use every sample. Raise <code class="inline">rosbagAnalyzer.maxPlotPoints</code> to draw more.</p>'
            : '');
      }
    } catch (err) {
      state.error = { message: err.message, hint: err.hint };
      render();
    }
  }

  // ── Tab: Trajectory ──────────────────────────────────────────────────────

  function renderTrajectory() {
    const metaA = state.fields.get(state.traj.keyA);
    const out = [];

    out.push('<div class="controls">');
    out.push('<div class="field grow"><label>Path</label>' + sourceSelect('traj-a', state.traj.keyA) + '</div>');
    out.push(
      '<div class="field grow"><label>Compare against (optional)</label>' +
        '<select data-select="traj-b"><option value="">— none —</option>' +
        sourceList()
          .map(
            (s) =>
              '<option value="' + esc(s.key) + '"' + (s.key === state.traj.keyB ? ' selected' : '') +
              '>' + esc(s.label) + '</option>',
          )
          .join('') +
        '</select></div>',
    );
    out.push('</div>');

    if (!metaA) {
      out.push('<div class="empty">Reading fields…</div>');
      return out.join('');
    }

    out.push('<div class="controls">');
    out.push('<div class="field"><label>X</label>' + columnSelect('traj-x', metaA.numeric, state.traj.x) + '</div>');
    out.push('<div class="field"><label>Y</label>' + columnSelect('traj-y', metaA.numeric, state.traj.y) + '</div>');
    out.push(
      '<div class="field"><label>Z (colour)</label>' +
        columnSelect('traj-z', metaA.numeric, state.traj.z, true) +
        '</div>',
    );
    out.push(
      '<div class="field"><label style="visibility:hidden">Colour</label>' +
        '<label class="check"><input type="checkbox" data-check="colorByTime"' +
        (state.traj.colorByTime ? ' checked' : '') + '> Colour by time</label></div>',
    );
    out.push('</div>');

    out.push('<div id="traj-summary"></div>');
    out.push('<div class="chart" id="traj-chart" style="height:460px"></div>');
    return out.join('');
  }

  async function prepareTrajectory() {
    const sources = sourceList();
    if (!state.traj.keyA && sources.length) {
      state.traj.keyA = sources[0].key;
    }
    if (!state.traj.keyA) {
      return;
    }
    const needsFetch = !state.fields.has(state.traj.keyA) ||
      (state.traj.keyB && !state.fields.has(state.traj.keyB));
    if (needsFetch) {
      state.busy = true;
      render();
    }
    try {
      const meta = await fieldsFor(state.traj.keyA);
      if (!state.traj.x || meta.numeric.indexOf(state.traj.x) < 0) {
        state.traj.x = meta.suggested.x || meta.numeric[0];
      }
      if (!state.traj.y || meta.numeric.indexOf(state.traj.y) < 0) {
        state.traj.y = meta.suggested.y || meta.numeric[1] || meta.numeric[0];
      }
      if (state.traj.keyB) {
        await fieldsFor(state.traj.keyB);
      }
    } catch (err) {
      state.error = { message: err.message, hint: err.hint };
    } finally {
      state.busy = false;
      render();
    }
  }

  async function paintTrajectory() {
    if (!state.traj.keyA || !state.traj.x || !state.traj.y) {
      return;
    }
    // Z is depth information, not a 3D scene: Plotly's true 3D ('scatter3d' +
    // a `scene` layout) is WebGL-only with no SVG equivalent, and relying on
    // a capability probe to decide when it's "safe" doesn't fully work (see
    // the comment on `webglAvailable` above). Encoding Z as marker colour on
    // an ordinary 2D scatter gets the same depth information across without
    // ever touching a WebGL trace type.
    const hasZ = Boolean(state.traj.z);

    async function fetchPath(key) {
      if (!key) {
        return null;
      }
      const meta = await fieldsFor(key);
      const { path, topic } = parseKey(key);
      const pick = (wanted, axis) =>
        meta.numeric.indexOf(wanted) >= 0 ? wanted : meta.suggested[axis] || null;
      const xf = pick(state.traj.x, 'x');
      const yf = pick(state.traj.y, 'y');
      const zf = hasZ ? pick(state.traj.z, 'z') : null;
      if (!xf || !yf) {
        return null;
      }
      const fields = [xf, yf].concat(zf ? [zf] : []);
      const data = await rpc('series', { path, topic, fields, maxPoints: state.settings.maxPlotPoints });
      return { x: data.series[xf], y: data.series[yf], z: zf ? data.series[zf] : null, rows: data.rows };
    }

    try {
      const a = await fetchPath(state.traj.keyA);
      const b = await fetchPath(state.traj.keyB);
      if (!a) {
        return;
      }

      const traces = [];
      const entries = [
        { data: a, label: labelFor(state.traj.keyA), colour: SERIES_COLORS[0] },
        b ? { data: b, label: labelFor(state.traj.keyB), colour: SERIES_COLORS[2] } : null,
      ].filter(Boolean);

      entries.forEach((entry, index) => {
        // Colour by time takes priority when both are on — one gradient at a
        // time reads far more clearly than two fighting over the same marker.
        const timeGradient = state.traj.colorByTime && index === 0;
        const zGradient = !timeGradient && hasZ && entry.data.z;
        const gradient = timeGradient || zGradient;
        const marker = timeGradient
          ? {
              size: 4,
              color: entry.data.x.map((_, i) => i),
              colorscale: 'Viridis',
              showscale: true,
              colorbar: { title: { text: 'sample', font: { size: 9 } }, thickness: 10 },
            }
          : zGradient
            ? {
                size: 4,
                color: entry.data.z,
                colorscale: 'Viridis',
                showscale: true,
                colorbar: { title: { text: state.traj.z, font: { size: 9 } }, thickness: 10 },
              }
            : { size: 3, color: entry.colour };

        traces.push({
          type: 'scatter',
          name: entry.label,
          mode: gradient ? 'lines+markers' : 'lines',
          line: { width: 1.6, color: entry.colour },
          marker,
          x: entry.data.x,
          y: entry.data.y,
        });

        // Start and end markers: knowing which end is which is most of the
        // value of looking at a path at all.
        const last = entry.data.x.length - 1;
        traces.push({
          type: 'scatter',
          name: entry.label + ' start/end',
          mode: 'markers+text',
          text: ['start', 'end'],
          textposition: 'top center',
          textfont: { size: 9 },
          marker: { size: 9, symbol: ['circle', 'x'], color: entry.colour, line: { width: 1 } },
          showlegend: false,
          hoverinfo: 'skip',
          x: [entry.data.x[0], entry.data.x[last]],
          y: [entry.data.y[0], entry.data.y[last]],
        });
      });

      const grid = cssVar('--vscode-panel-border', 'rgba(128,128,128,0.25)');
      const layout = {
        xaxis: { title: { text: state.traj.x, font: { size: 10 } }, gridcolor: grid },
        yaxis: {
          title: { text: state.traj.y, font: { size: 10 } },
          gridcolor: grid,
          scaleanchor: 'x',
          scaleratio: 1,
        },
      };

      draw('traj-chart', traces, layout);

      const summary = document.getElementById('traj-summary');
      if (summary) {
        const length = pathLength(a.x, a.y, a.z);
        const straight = distance(
          [a.x[0], a.y[0], a.z ? a.z[0] : 0],
          [a.x[a.x.length - 1], a.y[a.y.length - 1], a.z ? a.z[a.z.length - 1] : 0],
        );
        const cards = [
          card('Path length', num(length, 3) + ' m', hasZ ? 'XY + Z' : 'XY plane'),
          card('Start to end', num(straight, 3) + ' m', 'straight line'),
          card('Samples', a.rows.toLocaleString()),
        ];
        if (b) {
          const gap = endpointGap(a, b, hasZ);
          cards.push(card('Endpoint gap', num(gap, 3) + ' m', 'final divergence'));
        }
        summary.innerHTML = '<div class="cards">' + cards.join('') + '</div>';
      }
    } catch (err) {
      state.error = { message: err.message, hint: err.hint };
      render();
    }
  }

  function distance(p, q) {
    return Math.hypot(q[0] - p[0], q[1] - p[1], (q[2] || 0) - (p[2] || 0));
  }

  // Path length and endpoint gap still fold Z into the Euclidean distance
  // when a Z axis is mapped — only the chart's rendering changed (2D + colour
  // instead of a WebGL 3D scene), not this arithmetic.
  function pathLength(x, y, z) {
    let total = 0;
    for (let i = 1; i < x.length; i++) {
      if (x[i] == null || y[i] == null || x[i - 1] == null || y[i - 1] == null) {
        continue;
      }
      total += distance(
        [x[i - 1], y[i - 1], z ? z[i - 1] : 0],
        [x[i], y[i], z ? z[i] : 0],
      );
    }
    return total;
  }

  function endpointGap(a, b, hasZ) {
    const ai = a.x.length - 1;
    const bi = b.x.length - 1;
    return distance(
      [a.x[ai], a.y[ai], hasZ && a.z ? a.z[ai] : 0],
      [b.x[bi], b.y[bi], hasZ && b.z ? b.z[bi] : 0],
    );
  }

  // ── Tab: Accuracy ────────────────────────────────────────────────────────
  // This tab computes nothing. It prepares TUM inputs and runs the real
  // evo_ape / evo_rpe / evo_traj executable, then displays exactly what evo
  // reports — evo is the single source of truth for every number shown.

  const POSE_RELATIONS = [
    ['trans_part', 'Translation'],
    ['rot_part', 'Rotation'],
    ['full', 'Full transformation'],
    ['angle_deg', 'Rotation angle (deg)'],
    ['angle_rad', 'Rotation angle (rad)'],
    ['point_distance', 'Point distance'],
  ];
  const RPE_ONLY_POSE_RELATION = ['point_distance_error_ratio', 'Point distance error ratio'];

  function poseRelationOptions(evoCommand, selected) {
    const options = evoCommand === 'rpe' ? POSE_RELATIONS.concat([RPE_ONLY_POSE_RELATION]) : POSE_RELATIONS;
    return options
      .map(([value, label]) => '<option value="' + value + '"' + (value === selected ? ' selected' : '') + '>' +
        esc(label) + '</option>')
      .join('');
  }

  function sourceShortName(key) {
    if (!key) {
      return 'trajectory';
    }
    const label = labelFor(key);
    return label.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+/, '') || 'trajectory';
  }

  function evoAlignmentFlags(alignment) {
    if (alignment === 'se3') {
      return ['-a'];
    }
    if (alignment === 'sim3') {
      return ['-a', '-s'];
    }
    if (alignment === 'origin') {
      return ['--align_origin'];
    }
    return [];
  }

  // Mirrors `_build_evo_argv` in the Python bridge so the preview shown
  // before running matches the command that will actually execute. The
  // executed command that gets displayed after Run comes from the bridge
  // itself, not from this preview.
  function buildCommandPreview() {
    const refFile = sourceShortName(state.acc.gt) + '.tum';
    const estFile = sourceShortName(state.acc.est) + '.tum';
    if (state.acc.useCustomArgs) {
      const parts = ['evo_' + state.acc.evoCommand, 'tum', refFile];
      if (state.acc.evoCommand !== 'traj') {
        parts.push(estFile);
      }
      if (state.acc.customArgs.trim()) {
        parts.push(state.acc.customArgs.trim());
      }
      return parts.join(' ');
    }
    if (state.acc.evoCommand === 'traj') {
      return 'evo_traj tum ' + refFile + ' --full_check';
    }
    const parts = ['evo_' + state.acc.evoCommand, 'tum', refFile, estFile, '-r', state.acc.poseRelation];
    parts.push(...evoAlignmentFlags(state.acc.alignment));
    if (state.acc.evoCommand === 'rpe') {
      parts.push('-d', String(state.acc.delta), '-u', state.acc.deltaUnit);
      if (state.acc.allPairs) {
        parts.push('--all_pairs');
      }
      if (state.acc.pairsFromReference) {
        parts.push('--pairs_from_reference');
      }
    }
    if (state.acc.tMaxDiff) {
      parts.push('--t_max_diff', String(state.acc.tMaxDiff));
    }
    return parts.join(' ');
  }

  function renderAccuracy() {
    const out = [];
    out.push('<div class="controls">');
    out.push('<div class="field grow"><label>Reference</label>' + sourceSelect('acc-gt', state.acc.gt) + '</div>');
    out.push('<div class="field grow"><label>Estimate</label>' + sourceSelect('acc-est', state.acc.est) + '</div>');
    out.push('</div>');

    out.push('<div class="controls">');
    out.push(
      '<div class="field"><label>EVO command</label><select data-select="acc-evo-command">' +
        '<option value="ape"' + (state.acc.evoCommand === 'ape' ? ' selected' : '') + '>APE — evo_ape</option>' +
        '<option value="rpe"' + (state.acc.evoCommand === 'rpe' ? ' selected' : '') + '>RPE — evo_rpe</option>' +
        '<option value="traj"' + (state.acc.evoCommand === 'traj' ? ' selected' : '') + '>Trajectory — evo_traj</option>' +
        '</select></div>',
    );
    out.push(
      '<div class="field"><label style="visibility:hidden">Custom</label>' +
      '<label class="check"><input type="checkbox" data-check="acc-use-custom-args"' +
      (state.acc.useCustomArgs ? ' checked' : '') +
      '> Use custom evo arguments</label></div>',
    );
    if (!state.acc.useCustomArgs && state.acc.evoCommand !== 'traj') {
      out.push(
        '<div class="field"><label>Pose relation</label><select data-select="acc-pose-relation">' +
          poseRelationOptions(state.acc.evoCommand, state.acc.poseRelation) + '</select></div>',
      );
      out.push(
        '<div class="field"><label>Alignment</label><select data-select="acc-alignment">' +
          '<option value="none"' + (state.acc.alignment === 'none' ? ' selected' : '') + '>None</option>' +
          '<option value="se3"' + (state.acc.alignment === 'se3' ? ' selected' : '') + '>SE(3)</option>' +
          '<option value="sim3"' + (state.acc.alignment === 'sim3' ? ' selected' : '') + '>Sim(3)</option>' +
          '<option value="origin"' + (state.acc.alignment === 'origin' ? ' selected' : '') + '>Origin</option>' +
          '</select></div>',
      );
    }
    out.push('</div>');

    if (state.acc.useCustomArgs) {
      out.push('<div class="controls">');
      out.push(
        '<div class="field grow"><label>Custom evo arguments</label>' +
        '<input data-input="acc-custom-args" value="' + esc(state.acc.customArgs) +
        '" placeholder="-r trans_part -a --t_max_diff 0.02" spellcheck="false"></div>',
      );
      out.push('</div>');
      out.push(
        '<div class="hint">Replaces every option above — typed exactly as you\'d pass them on the command ' +
        'line after "evo_' + esc(state.acc.evoCommand) + ' tum ref.tum' +
        (state.acc.evoCommand === 'traj' ? '' : ' est.tum') + '". `--save_results` is always ours; ' +
        'anything you type there is ignored.</div>',
      );
    }

    if (!state.acc.useCustomArgs && state.acc.evoCommand === 'rpe') {
      out.push('<div class="controls">');
      out.push(
        '<div class="field"><label>Delta</label><input type="number" step="any" data-input="acc-delta" value="' +
        esc(state.acc.delta) + '"></div>',
      );
      out.push(
        '<div class="field"><label>Delta unit</label><select data-select="acc-delta-unit">' +
          '<option value="f"' + (state.acc.deltaUnit === 'f' ? ' selected' : '') + '>frames</option>' +
          '<option value="d"' + (state.acc.deltaUnit === 'd' ? ' selected' : '') + '>degrees</option>' +
          '<option value="r"' + (state.acc.deltaUnit === 'r' ? ' selected' : '') + '>radians</option>' +
          '<option value="m"' + (state.acc.deltaUnit === 'm' ? ' selected' : '') + '>meters</option>' +
          '</select></div>',
      );
      out.push(
        '<div class="field"><label class="check"><input type="checkbox" data-check="acc-all-pairs"' +
          (state.acc.allPairs ? ' checked' : '') + '> All pairs</label></div>',
      );
      out.push(
        '<div class="field"><label class="check"><input type="checkbox" data-check="acc-pairs-from-reference"' +
          (state.acc.pairsFromReference ? ' checked' : '') + '> Pairs from reference</label></div>',
      );
      out.push('</div>');
    }

    if (!state.acc.useCustomArgs && state.acc.evoCommand !== 'traj') {
      out.push('<div class="controls">');
      out.push(
        '<div class="field"><label>Max time diff (s)</label><input type="number" min="0.0001" step="0.001" ' +
        'data-input="acc-t-max-diff" value="' + esc(state.acc.tMaxDiff) +
        '" title="evo\'s --t_max_diff — the widest gap allowed between two matched timestamps."></div>',
      );
      out.push('</div>');
    }

    out.push('<div class="row" style="align-items:center">');
    out.push('<span>Command:</span> <code class="inline" style="user-select:text">' +
      esc(buildCommandPreview()) + '</code>');
    out.push('<button class="ghost" data-act="copy-command-preview">Copy</button>');
    out.push('</div>');

    const canRun = state.acc.gt && (state.acc.evoCommand === 'traj' || state.acc.est);
    out.push('<div class="row">');
    out.push('<button class="action" data-act="run-evo"' + (canRun ? '' : ' disabled') + '>Run EVO</button>');
    out.push('</div>');

    if (!state.probe || !state.probe.evo) {
      out.push(
        '<div class="notice warn"><p style="margin:0">The <code class="inline">evo</code> package isn\'t ' +
        'importable in the configured Python interpreter. Install it with <code class="inline">pip install evo</code> ' +
        '— this tab runs the real evo_ape/evo_rpe/evo_traj executables and has no calculation of its own to fall ' +
        'back on.</p></div>',
      );
    }

    if (state.acc.result) {
      out.push(renderEvoResult(state.acc.result));
    }
    return out.join('');
  }

  function renderEvoResult(result) {
    const out = [];
    out.push('<h3 class="section">Command executed</h3>');
    out.push('<div class="row" style="align-items:center">');
    out.push('<code class="inline" style="user-select:text">' + esc(result.commandText) + '</code>');
    out.push('<button class="ghost" data-act="copy-command">Copy</button>');
    out.push('</div>');
    out.push('<p class="hint">evo ' + esc(result.evoVersion) + '</p>');

    if (result.evoCommand === 'traj') {
      out.push('<h3 class="section">evo_traj output</h3>');
      out.push('<pre class="output-box">' + esc(result.stdout || '(no output)') + '</pre>');
      if (result.stderr) {
        out.push('<h4 class="section">stderr</h4>');
        out.push('<pre class="output-box">' + esc(result.stderr) + '</pre>');
      }
      return out.join('');
    }

    const stats = result.stats || {};
    const title = (result.info && result.info.title) || '';
    out.push(
      '<h3 class="section">' + (result.evoCommand === 'ape' ? 'APE' : 'RPE') +
      ' <span class="chip" title="Every number here comes directly from evo\'s own output, not a custom calculation">Source: EVO</span></h3>',
    );
    if (title) {
      out.push('<p class="hint">' + esc(title.replace(/\n/g, ' — ')) + '</p>');
    }
    out.push(
      '<div class="cards">' +
        card('RMSE', num(stats.rmse, 5)) +
        card('Mean', num(stats.mean, 5)) +
        card('Median', num(stats.median, 5)) +
        card('Std', num(stats.std, 5)) +
        card('Max', num(stats.max, 5)) +
        card('Min', num(stats.min, 5)) +
        card('SSE', num(stats.sse, 5)) +
        card('N', result.n.toLocaleString()) +
        '</div>',
    );

    out.push('<h3 class="section">Error over time</h3>');
    out.push('<p class="hint">Plotted from evo\'s own per-pose result data (--save_results), not recomputed.</p>');
    out.push('<div class="chart" id="acc-err-chart" style="height:260px"></div>');
    out.push('<h3 class="section">Error distribution</h3>');
    out.push('<div class="chart" id="acc-hist-chart" style="height:230px"></div>');

    out.push('<div class="row">');
    out.push('<button class="ghost" data-act="export-evaluation">Export evaluation package</button>');
    out.push(
      '<button class="ghost" data-act="toggle-evo-output">' +
      (state.acc.showOutput ? 'Hide' : 'Show') + ' raw evo output</button>',
    );
    out.push('</div>');

    if (state.acc.showOutput) {
      out.push('<h4 class="section">stdout</h4>');
      out.push('<pre class="output-box">' + esc(result.stdout || '(empty)') + '</pre>');
      if (result.stderr) {
        out.push('<h4 class="section">stderr</h4>');
        out.push('<pre class="output-box">' + esc(result.stderr) + '</pre>');
      }
    }
    return out.join('');
  }

  function prepareAccuracy() {
    const sources = sourceList();
    if (!state.acc.gt && sources.length) {
      state.acc.gt = sources[0].key;
    }
    if (!state.acc.est && sources.length > 1) {
      state.acc.est = sources[1].key;
    }
    render();
  }

  function evoArgs() {
    const gt = state.acc.gt ? parseKey(state.acc.gt) : null;
    const est = state.acc.est ? parseKey(state.acc.est) : null;
    return {
      evoCommand: state.acc.evoCommand,
      gt: gt ? { path: gt.path, topic: gt.topic } : undefined,
      est: est ? { path: est.path, topic: est.topic } : undefined,
      sources: state.acc.evoCommand === 'traj'
        ? [gt, est].filter(Boolean).map((s) => ({ path: s.path, topic: s.topic }))
        : undefined,
      poseRelation: state.acc.poseRelation,
      alignment: state.acc.alignment,
      tMaxDiff: state.acc.tMaxDiff,
      delta: state.acc.delta,
      deltaUnit: state.acc.deltaUnit,
      allPairs: state.acc.allPairs,
      pairsFromReference: state.acc.pairsFromReference,
      customArgs: state.acc.useCustomArgs ? state.acc.customArgs : '',
      refLabel: state.acc.gt ? labelFor(state.acc.gt) : undefined,
      estLabel: state.acc.est ? labelFor(state.acc.est) : undefined,
    };
  }

  async function runEvo() {
    state.busy = true;
    state.error = null;
    render();
    try {
      state.acc.result = await rpc('run_evo', {
        ...evoArgs(),
        maxPoints: Math.min(state.settings.maxPlotPoints, 3000),
      });
    } catch (err) {
      state.acc.result = null;
      state.error = { message: err.message, hint: err.hint };
    } finally {
      state.busy = false;
      render();
    }
  }

  function exportEvaluationPackage() {
    vscode.postMessage({
      type: 'exportEvaluation',
      args: evoArgs(),
      dirName: 'SLAM Evaluation',
    });
  }

  function exportTopicCsv(key) {
    const { path, topic } = parseKey(key);
    const filename = (topic ? topic.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+/, '') : 'source') + '.csv';
    vscode.postMessage({
      type: 'exportTopic',
      source: { path, topic },
      filename,
    });
  }

  function exportTum(key) {
    const { path, topic } = parseKey(key);
    const filename = (topic ? topic.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+/, '') : 'source') + '.tum';
    vscode.postMessage({
      type: 'exportTum',
      source: { path, topic },
      filename,
    });
  }

  function paintAccuracy() {
    const result = state.acc.result;
    if (!result || result.evoCommand === 'traj' || !result.errorArray || !result.errorArray.length) {
      return;
    }
    const grid = cssVar('--vscode-panel-border', 'rgba(128,128,128,0.25)');
    const warn = cssVar('--vscode-editorWarning-foreground', '#cca700');
    const label = result.evoCommand === 'ape' ? 'APE' : 'RPE';
    const rmse = result.stats ? result.stats.rmse : null;

    draw(
      'acc-err-chart',
      // evo's own per-pose error/time arrays (from --save_results), not
      // anything recomputed here.
      [{
        type: 'scatter',
        mode: 'lines',
        x: result.timeArray,
        y: result.errorArray,
        line: { width: 1.2, color: SERIES_COLORS[0] },
        hovertemplate: '%{y:.5g}<extra></extra>',
      }],
      {
        showlegend: false,
        margin: { l: 52, r: 18, t: 10, b: 34 },
        xaxis: { title: { text: 'time (s)', font: { size: 10 } }, gridcolor: grid },
        yaxis: { title: { text: label + ' error', font: { size: 10 } }, gridcolor: grid, zerolinecolor: grid },
        shapes: rmse == null ? [] : [
          {
            type: 'line', xref: 'paper', x0: 0, x1: 1, yref: 'y', y0: rmse, y1: rmse,
            line: { color: warn, width: 1, dash: 'dot' },
          },
        ],
      },
    );

    draw(
      'acc-hist-chart',
      [{
        type: 'histogram',
        x: result.errorArray,
        nbinsx: 40,
        marker: { color: SERIES_COLORS[0], opacity: 0.75 },
      }],
      {
        showlegend: false,
        margin: { l: 46, r: 12, t: 10, b: 34 },
        xaxis: { title: { text: label + ' error', font: { size: 9 } }, gridcolor: grid },
        yaxis: { title: { text: 'count', font: { size: 9 } }, gridcolor: grid },
        shapes: rmse == null ? [] : [
          {
            type: 'line', x0: rmse, x1: rmse, yref: 'paper', y0: 0, y1: 1,
            line: { color: warn, width: 1.5 },
          },
        ],
      },
    );
  }

  // ── Event wiring ─────────────────────────────────────────────────────────

  function wire() {
    app.querySelectorAll('[data-tab]').forEach((el) => {
      el.addEventListener('click', () => {
        state.tab = el.dataset.tab;
        persist();
        render();
        void enterTab();
      });
    });

    app.querySelectorAll('[data-act]').forEach((el) => {
      el.addEventListener('click', () => void onAction(el.dataset.act, el.dataset));
    });

    app.querySelectorAll('[data-select]').forEach((el) => {
      el.addEventListener('change', () => void onSelect(el.dataset.select, el.value));
    });

    app.querySelectorAll('[data-check]').forEach((el) => {
      el.addEventListener('change', () => void onCheck(el.dataset.check, el.checked));
    });

    app.querySelectorAll('[data-input]').forEach((el) => {
      el.addEventListener('change', () => void onInput(el.dataset.input, el.value));
    });

    app.querySelectorAll('[data-field-toggle]').forEach((el) => {
      el.addEventListener('change', () => {
        const field = el.dataset.fieldToggle;
        const index = state.signals.fields.indexOf(field);
        if (el.checked && index < 0) {
          state.signals.fields.push(field);
        } else if (!el.checked && index >= 0) {
          state.signals.fields.splice(index, 1);
        }
        render();
      });
    });
  }

  async function onAction(action, data) {
    switch (action) {
      case 'add':
        vscode.postMessage({ type: 'pickFile', role: 'any' });
        return;
      case 'dismiss':
        state.error = null;
        render();
        return;
      case 'log':
        vscode.postMessage({ type: 'openLog' });
        return;
      case 'settings':
        vscode.postMessage({ type: 'openSettings', key: data.key });
        return;
      case 'install': {
        const exe = (state.probe && state.probe.versions.executable) || 'python3';
        vscode.postMessage({ type: 'runInTerminal', command: '"' + exe + '" -m pip install rosbags pandas numpy' });
        return;
      }
      case 'choose-interpreter':
        vscode.postMessage({ type: 'chooseInterpreter' });
        return;
      case 'inspect-topic':
        state.signals.key = data.key;
        state.signals.fields = [];
        state.tab = 'signals';
        persist();
        await prepareSignals();
        return;
      case 'plot':
        state.signals.key = data.key;
        state.signals.fields = [data.field];
        state.tab = 'signals';
        persist();
        await prepareSignals();
        return;
      case 'signal-clear':
        state.signals.fields = [];
        render();
        return;
      case 'export-topic':
        exportTopicCsv(data.key);
        return;
      case 'export-tum':
        exportTum(data.key);
        return;
      case 'run-evo':
        await runEvo();
        return;
      case 'export-evaluation':
        exportEvaluationPackage();
        return;
      case 'copy-command':
        vscode.postMessage({ type: 'copy', text: state.acc.result ? state.acc.result.commandText : '', label: 'Command copied' });
        return;
      case 'copy-command-preview':
        vscode.postMessage({ type: 'copy', text: buildCommandPreview(), label: 'Command copied' });
        return;
      case 'toggle-evo-output':
        state.acc.showOutput = !state.acc.showOutput;
        render();
        return;
      case 'create-derived': {
        const file = state.files.find((f) => f.path === data.path);
        state.derive = {
          path: data.path,
          topic: (file && file.info.topics[0] && file.info.topics[0].topic) || null,
          name: '', refType: 'manual',
          manual: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
          tfParent: null, tfChild: null, invert: false,
          frames: null, framesError: null, busy: false, error: null,
        };
        render();
        rpc('list_frames', { path: data.path }).then(
          (frames) => {
            if (state.derive.path !== data.path) {
              return; // form was closed/reopened elsewhere before this returned
            }
            state.derive.frames = frames;
            state.derive.tfParent = frames.frames[0] || null;
            state.derive.tfChild = frames.frames[1] || frames.frames[0] || null;
            render();
          },
          (err) => {
            if (state.derive.path === data.path) {
              state.derive.framesError = err.message;
              render();
            }
          },
        );
        return;
      }
      case 'derive-cancel':
        state.derive.path = null;
        render();
        return;
      case 'derive-submit':
        await submitDerivedTopic();
        return;
    }
  }

  async function submitDerivedTopic() {
    const d = state.derive;
    if (!d.path || !d.topic) {
      return;
    }
    if (!d.name.trim()) {
      d.error = 'Give the new topic a name.';
      render();
      return;
    }
    const reference =
      d.refType === 'manual'
        ? { type: 'manual', ...d.manual }
        : { type: 'tf', parent: d.tfParent, child: d.tfChild };
    if (d.refType === 'tf' && (!d.tfParent || !d.tfChild)) {
      d.error = 'Pick both a parent and a child frame.';
      render();
      return;
    }

    d.busy = true;
    d.error = null;
    render();
    try {
      const result = await rpc('create_derived_topic', {
        path: d.path, topic: d.topic, name: d.name.trim(), reference, invert: d.invert,
      });
      await refreshFile(d.path);
      state.derive.path = null;
      toast('Created ' + result.topic);
    } catch (err) {
      d.error = err.message;
    } finally {
      d.busy = false;
      render();
    }
  }

  async function onSelect(name, value) {
    if (name === 'signal-source') {
      state.signals.key = value;
      state.signals.fields = [];
      state.signals.time = null;
      await prepareSignals();
      return;
    }
    if (name === 'signal-time') {
      state.signals.time = value;
      render();
      return;
    }
    if (name === 'traj-a') {
      state.traj.keyA = value;
      state.traj.x = null;
      state.traj.y = null;
      await prepareTrajectory();
      return;
    }
    if (name === 'traj-b') {
      state.traj.keyB = value;
      await prepareTrajectory();
      return;
    }
    if (name === 'traj-x' || name === 'traj-y' || name === 'traj-z') {
      state.traj[name.slice(-1)] = value;
      render();
      return;
    }
    if (name === 'acc-gt' || name === 'acc-est') {
      state.acc[name === 'acc-gt' ? 'gt' : 'est'] = value;
      state.acc.result = null;
      render();
      return;
    }
    if (name === 'acc-evo-command') {
      state.acc.evoCommand = value;
      state.acc.result = null;
      if (value !== 'rpe' && state.acc.poseRelation === 'point_distance_error_ratio') {
        state.acc.poseRelation = 'trans_part';
      }
      render();
      return;
    }
    if (name === 'acc-pose-relation') {
      state.acc.poseRelation = value;
      render();
      return;
    }
    if (name === 'acc-alignment') {
      state.acc.alignment = value;
      render();
      return;
    }
    if (name === 'acc-delta-unit') {
      state.acc.deltaUnit = value;
      render();
      return;
    }
    if (name === 'derive-topic') {
      state.derive.topic = value;
      render();
      return;
    }
    if (name === 'derive-ref-type') {
      state.derive.refType = value;
      state.derive.error = null;
      render();
      return;
    }
    if (name === 'derive-tf-parent') {
      state.derive.tfParent = value;
      render();
      return;
    }
    if (name === 'derive-tf-child') {
      state.derive.tfChild = value;
      render();
      return;
    }
  }

  function onCheck(name, checked) {
    if (name === 'subplots') {
      state.signals.subplots = checked;
      render();
      return;
    }
    if (name === 'colorByTime') {
      state.traj.colorByTime = checked;
      render();
      return;
    }
    if (name === 'acc-all-pairs') {
      state.acc.allPairs = checked;
      render();
      return;
    }
    if (name === 'acc-pairs-from-reference') {
      state.acc.pairsFromReference = checked;
      render();
      return;
    }
    if (name === 'acc-use-custom-args') {
      state.acc.useCustomArgs = checked;
      state.acc.result = null;
      render();
      return;
    }
    if (name === 'derive-invert') {
      state.derive.invert = checked;
      render();
      return;
    }
  }

  const DERIVE_MANUAL_AXES = ['tx', 'ty', 'tz', 'qx', 'qy', 'qz', 'qw'];

  function onInput(name, value) {
    if (name === 'acc-delta') {
      state.acc.delta = parseFloat(value) || 1;
      render();
      return;
    }
    if (name === 'acc-t-max-diff') {
      state.acc.tMaxDiff = Math.max(0.0001, parseFloat(value) || 0.01);
      render();
      return;
    }
    if (name === 'acc-custom-args') {
      state.acc.customArgs = value;
      state.acc.result = null;
      render();
      return;
    }
    if (name === 'derive-name') {
      state.derive.name = value;
      return;
    }
    if (name.startsWith('derive-') && DERIVE_MANUAL_AXES.includes(name.slice('derive-'.length))) {
      state.derive.manual[name.slice('derive-'.length)] = parseFloat(value) || 0;
      return;
    }
  }

  async function enterTab() {
    if (!state.files.length) {
      return;
    }
    // Always run the tab's setup. Column auto-mapping lives there, and cached
    // field metadata must not cause it to be skipped — that leaves the pickers
    // showing whatever option happens to be first.
    if (state.tab === 'signals') {
      await prepareSignals();
    } else if (state.tab === 'traj') {
      await prepareTrajectory();
    } else if (state.tab === 'accuracy') {
      await prepareAccuracy();
    } else {
      paint();
    }
  }

  function paint() {
    if (state.tab === 'signals') {
      void paintSignals();
    } else if (state.tab === 'traj') {
      void paintTrajectory();
    } else if (state.tab === 'accuracy') {
      paintAccuracy();
    }
  }

  // Redraw charts when the user switches colour theme.
  const observer = new MutationObserver(() => paint());
  observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });

  window.addEventListener('resize', () => {
    if (!hasPlotly) {
      return;
    }
    document.querySelectorAll('.chart').forEach((el) => {
      if (el.data) {
        Plotly.Plots.resize(el);
      }
    });
  });

  // Diagnostic only (see the `webglAvailable` comment above): every chart in
  // this file already renders without WebGL regardless of this value, so
  // there is nothing here to fall back from — this just makes the detected
  // capability visible in "Rosbag: Show Log" if it's ever needed for support.
  vscode.postMessage({ type: 'log', text: 'WebGL available: ' + webglAvailable + ' (unused — all charts render via SVG/Canvas 2D)' });

  vscode.postMessage({ type: 'ready' });
})();

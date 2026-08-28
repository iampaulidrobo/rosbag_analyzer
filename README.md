# Rosbag Analyzer for VS Code

Inspect rosbags, plot topics, and measure trajectory accuracy inside the editor.
No ROS installation required — bag reading is done by the pure-Python
[`rosbags`](https://ternaris.gitlab.io/rosbags/) library.

Double-click a `.bag` and it opens as a panel instead of a wall of binary.

---

## Install

```bash
git clone <this repo> rosbag-analyzer-vscode
cd rosbag-analyzer-vscode
npm install
npm run vendor      # copies plotly.js into media/vendor
npm run compile
```

Then press <kbd>F5</kbd> in VS Code to launch an Extension Development Host, or
build an installable package:

```bash
npx vsce package
code --install-extension rosbag-analyzer-0.1.0.vsix
```

### Python environment — Option A: automatic (default, no setup needed)

The Python side needs four packages: `rosbags`, `pandas`, `numpy` (for
reading bags) and `evo` (for the Accuracy tab). **You don't need to install
any of these yourself.** The first time the extension activates and no
interpreter is configured, it quietly:

1. Creates a private virtual environment under its own extension storage
   (never touches your system Python or any project).
2. Installs `rosbags`, `pandas`, `numpy` and `evo` into it.
3. Points `rosbagAnalyzer.pythonPath` at that environment automatically.

A progress notification ("Rosbag Analyzer: setting up a Python environment")
shows while this runs — the first bag you open just works once it finishes.
This only runs once; after that (or if you ever set `rosbagAnalyzer.pythonPath`
yourself), it's never triggered again.

To use a **different** interpreter — a specific venv, a conda env, whatever —
click the **python x.x.x** chip in the panel's header, or run **Rosbag: Choose
Python Interpreter** from the Command Palette. It lists the managed
environment, the Python extension's active interpreter (if installed),
anything found on `PATH`, and a "Browse…" option, and updates the setting for
you — no hand-editing `pythonPath` required.

Run **Rosbag: Check Python Environment** any time to see what's actually
installed where, and to install anything missing into the *current*
interpreter.

If the managed environment ever ends up broken — most commonly `python3 -m
venv` succeeding at creating the folder but leaving it with no working `pip`,
which happens on Debian/Ubuntu systems missing the separate `python3-venv`/
`python3-pip` OS packages — reopening **Rosbag: Choose Python Interpreter**
and picking the managed-environment entry repairs it in place (bootstraps
pip via `ensurepip`, reinstalls the packages, and verifies they actually
import) rather than assuming the environment is fine just because the
interpreter file exists.

### Option B: set it up yourself with a manual virtual environment

If you'd rather manage the environment yourself (or the automatic setup
failed — e.g. no `python3` on `PATH`), create one manually:

```bash
python3 -m venv ~/.rosbag-analyzer-venv
~/.rosbag-analyzer-venv/bin/pip install rosbags pandas numpy evo
```

Then either click the **python x.x.x** chip (or run **Rosbag: Choose Python
Interpreter**) and pick **Browse…** to point at
`~/.rosbag-analyzer-venv/bin/python3`, or set it directly: open Settings
(`Ctrl+,`), search **Rosbag Analyzer**, and set **Python Path** to the full
absolute path (not `~`). Run **Rosbag: Restart Bag Reader** afterwards.

This is also the fix if `pip install` ever fails with
`externally-managed-environment` (common on Debian/Ubuntu, where the system
Python blocks plain `pip install`) — a venv sidesteps it entirely.

---

## Getting started

1. **Open the extension once** — if this is a fresh install with no
   interpreter configured, it sets up its own environment automatically (see
   Option A above); just wait for the one-time setup notification to finish.
2. **Open a file** — double-click a `.bag`/`.db3`/`.mcap` in the Explorer, or
   right-click any supported file and choose **Open in Rosbag Analyzer**, or
   run **Rosbag: Open Analyzer** from the Command Palette and pick a file or
   a ROS 2 bag folder.
3. **Contents tab** opens first — check the topic list looks right (message
   type, count, rate). Each topic has `csv`/`tum` export links here too.
   **Create derived topic…** re-expresses an existing pose topic in a
   different frame — a manually entered transform, or one looked up from the
   bag's own `/tf`/`/tf_static` data — and adds the result as a new topic for
   the rest of this session (usable everywhere a real topic is, including
   export; never written to the original bag file).
4. **Signals tab** — pick a topic, tick the numeric fields you want plotted
   against time.
5. **Trajectory tab** — pick X/Y columns for a path; optionally pick a second
   source under "Compare against" to overlay two paths (e.g. ground truth vs.
   an estimator) and see path length / endpoint drift.
6. **Accuracy tab**, to score one trajectory against another with real evo:
   - Pick **Reference** and **Estimate** sources.
   - Pick an **EVO command** (APE, RPE, or Trajectory) and its options — the
     exact command line that will run is shown live above the button.
   - Need a flag the GUI doesn't expose (`--correct_scale`, `--n_to_align`,
     `--plot_mode`, ...)? Tick **Use custom evo arguments** and type them
     directly — they replace every option above, still run against the same
     exported TUM files as the real `evo_ape`/`evo_rpe`/`evo_traj`. Whatever
     you type for `--save_results` is ignored; the extension always owns that
     path so it can parse the results back.
   - Click **Run EVO**. The numbers shown (RMSE, mean, median, ...) come
     straight from evo's own output.
   - **Export evaluation package** saves the TUM files, the exact command,
     evo's raw output, and the parsed results together — enough to redo the
     same evaluation from a bare terminal later.

If something looks wrong at any step, **Rosbag: Show Log** has the sidecar's
diagnostic output, and **Rosbag: Check Python Environment** re-checks which
packages are actually visible to the configured interpreter.

---

## Inputs

| Input | How to point at it |
|---|---|
| ROS 1 bag | the `.bag` file |
| ROS 2 bag | the bag **folder** (the one holding `metadata.yaml`) |
| ROS 2 SQLite / MCAP | the `.db3` or `.mcap` — resolves up to its bag folder automatically |
| CSV / TSV | any table with a header row, including `rostopic echo -b bag -p /topic` output |

Sources can be mixed: a CSV of ground truth compares against a live bag topic
in the same report.

---

## Tabs

**Contents** — topics, message types, counts, rate, duration, size. For CSVs,
columns and dtypes. `open` on any row jumps to Signals with that topic loaded.

**Signals** — plot any numeric field against time, overlaid or one subplot per
field, with per-field statistics computed on every sample even when the chart
is thinned.

**Trajectory** — 2D or 3D path, colour-coded by time, with start and end
markers. Two sources overlay for a visual GT-vs-estimate comparison; reports
path length, straight-line displacement, and final endpoint divergence.

**Accuracy** — a thin GUI around the real [`evo`](https://github.com/MichaelGrupp/evo)
CLI: pick a reference and an estimate source, pick `evo_ape` / `evo_rpe` /
`evo_traj` and its options (pose relation, alignment, delta, ...), and the
extension exports both sources as TUM files and runs the actual
`evo_ape`/`evo_rpe`/`evo_traj` executable. Every number shown — RMSE, mean,
median, min, max, SSE, std, N — comes straight from evo's own output; nothing
here recomputes APE, RPE, synchronization, or a rotation error. Requires
`pip install evo` in the configured Python interpreter.

---

## Commands

| Command | What it does |
|---|---|
| `Rosbag: Open Analyzer` | pick any supported file or folder |
| `Rosbag: Show Topics` | quick pick of topics without opening a panel; picking one copies its name |
| `Rosbag: Check Python Environment` | reports interpreter and package versions |
| `Rosbag: Restart Bag Reader` | restarts the sidecar and clears its parse cache |
| `Rosbag: Show Log` | the extension's log channel |

`Open in Rosbag Analyzer` and `Show Topics` also appear in the explorer
right-click menu for bag and table files, alongside per-topic `csv` and `tum`
export links in the Contents tab.

---

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `rosbagAnalyzer.pythonPath` | `""` | Interpreter to use. Empty means: ask the Python extension, then fall back to `python3`. |
| `rosbagAnalyzer.maxPlotPoints` | `20000` | Points drawn per series. |
| `rosbagAnalyzer.openBagsInAnalyzer` | `true` | Whether `.bag` opens here or in the binary editor. |

---

## Accuracy: evo is the only source of truth

The Accuracy tab does not calculate APE or RPE itself. It:

1. Exports the reference and estimate sources as standard TUM trajectory
   files (`timestamp tx ty tz qx qy qz qw`, one pose per line, no header).
   The timestamp is always an absolute clock (a ROS header stamp, or an
   already-TUM `timestamp`) — never the per-topic-relative `_time_s`, a row
   number, or a bare nanosecond count, since any of those would silently
   misalign two independently-recorded sources.
2. Builds the real `evo_ape` / `evo_rpe` / `evo_traj` command line from the
   options you picked (pose relation, alignment, delta, ...) — shown live
   above the Run button before you click it.
3. Runs that executable as a subprocess and reads back its own
   `--save_results` output (`stats.json`, the per-pose error array, and the
   time array) — the same numbers you'd get running the command yourself in
   a terminal.
4. Displays evo's numbers (labelled "Source: EVO"), the exact command that
   ran (with a copy button), and — on request — writes a self-contained
   evaluation package (TUM files, `command.txt`, `evo_output.txt`,
   `results.json`, `metadata.json`) that reproduces the result from a bare
   terminal with no VS Code involved.

If `evo` isn't importable in the configured interpreter, the tab says so
plainly rather than falling back to any calculation of its own — there isn't
one.

---

## Architecture

```
┌─ Extension host (TypeScript) ─────────────────┐
│  extension.ts  commands, menus, env check     │
│  panel.ts      webview + custom editor        │
│  bridge.ts     owns the sidecar process       │
└───────────────────┬───────────────────────────┘
                    │ line-delimited JSON on stdio
┌───────────────────┴───────────────────────────┐
│  python/rosbag_bridge.py                      │
│  rosbags · pandas · numpy · LRU parse cache   │
└───────────────────────────────────────────────┘
```

Bag parsing stays in Python because `rosbags` has no TypeScript equivalent and
reimplementing ROS 1 bag decoding would be a large project for no benefit.

One sidecar process is kept alive for the window and holds a small LRU cache of
decoded topics, so switching tabs doesn't re-decode the bag. Requests are
multiplexed by id, so a slow topic read doesn't block anything else.

`python/rosbag_bridge.py` has no VS Code dependency and speaks a documented
protocol, so it can be driven from a test script or reused elsewhere:

```bash
echo '{"id":1,"cmd":"inspect","args":{"path":"data.bag"}}' | python3 python/rosbag_bridge.py
```

Commands: `probe`, `inspect`, `fields`, `series`, `export`, `export_tum`,
`run_evo`, `export_evaluation`, `list_frames`, `create_derived_topic`, `clear`.
`run_evo` and `export_evaluation` are thin: they build a TUM export, spawn the
real `evo_ape`/`evo_rpe`/`evo_traj` executable found next to whichever Python
interpreter this bridge runs under, and parse back the `stats.json`/error
arrays evo itself wrote via `--save_results` — no APE/RPE/sync/rotation-error
math lives in this file. `create_derived_topic` composes a reference
transform (manual, or looked up from `/tf`/`/tf_static`) with an existing
topic's per-row pose using plain quaternion algebra — no matrix decomposition,
no external transform library.

---

## Notes and limits

- Charts need the vendored plotly. If they show a message instead of a plot,
  run `npm run vendor` and reload the window.
- `inspect` walks every message to count topics and compute rates, so the
  first open of a multi-GB bag takes a while. It's cached afterwards.
- Message arrays are flattened to their first 4 elements; sequences of
  sub-messages (such as `nav_msgs/Path`) expose only the first pose.
- Custom message types are registered from definitions carried inside the bag
  where available. Bags recorded without them cannot be decoded, and those
  topics are skipped with a count in the log.
- The webview inherits the active colour theme; charts redraw on theme change.
- The Accuracy tab needs `evo` installed in the configured Python interpreter
  (`pip install evo`) — it has no fallback calculation of its own.
- The automatically-provisioned environment (see Option A above) lives under
  this extension's own global storage directory, not inside this repo or any
  workspace — deleting it and reopening a bag re-provisions it from scratch.
- A derived topic's TF reference only resolves a **direct** `/tf`/`/tf_static`
  edge between the two frames you pick, not a multi-hop chain through an
  intermediate frame — run **Rosbag: Show Log** or check the error for the
  edges the bag actually publishes. A dynamic (non-static) edge is resolved
  per-row using the nearest-in-time sample, not interpolation.

## Licence

MIT

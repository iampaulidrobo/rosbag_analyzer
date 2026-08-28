"""Drive rosbag_bridge.py over stdio exactly like the extension does."""
import json, math, shutil, subprocess, sys, zipfile
from pathlib import Path
import numpy as np

BRIDGE = str(Path(__file__).parent.parent / "python" / "rosbag_bridge.py")
F = str(Path(__file__).parent / "fixtures")

proc = subprocess.Popen([sys.executable, "-u", BRIDGE], stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
_id = 0


def call(cmd, **args):
    global _id
    _id += 1
    proc.stdin.write(json.dumps({"id": _id, "cmd": cmd, "args": args}) + "\n")
    proc.stdin.flush()
    line = proc.stdout.readline()
    if not line:
        print("!! bridge died\n", proc.stderr.read())
        sys.exit(1)
    return json.loads(line)


def show(label, resp, keys=None):
    if not resp.get("ok"):
        print(f"  FAIL {label}: {resp.get('error')} | hint={resp.get('hint')}")
        return None
    r = resp["result"]
    if keys:
        print(f"  ok   {label}: " + ", ".join(f"{k}={r.get(k)}" for k in keys))
    else:
        print(f"  ok   {label}")
    return r


print("== probe ==")
show("probe", call("probe"), ["rosbags", "protocol"])

print("\n== inspect ROS1 .bag ==")
r = show("inspect bag", call("inspect", path=f"{F}/test.bag"),
         ["kind", "totalMessages", "duration", "sizeBytes"])
for t in r["topics"]:
    print(f"       {t['topic']:<24} {t['type']:<26} n={t['messages']:<5} {t['hz']} Hz")

print("\n== inspect ROS2 (folder) ==")
r = show("inspect folder", call("inspect", path=f"{F}/test_ros2"), ["kind", "totalMessages"])

print("\n== inspect ROS2 via .db3 (should resolve to parent) ==")
show("inspect db3", call("inspect", path=f"{F}/test_ros2/test_ros2.db3"), ["kind", "path"])

print("\n== inspect CSV ==")
r = show("inspect csv", call("inspect", path=f"{F}/gt.csv"), ["kind", "rows"])
print("       columns:", [c["name"] for c in r["columns"]])

print("\n== fields on a topic ==")
r = show("fields", call("fields", path=f"{F}/test.bag", topic="/ground_truth/odom"), ["rows"])
print("       numeric:", r["numeric"])
print("       time column:", r["timeColumn"], "| candidates:", r["timeCandidates"][:5])
print("       suggested axes:", r["suggested"])

print("\n== series ==")
r = show("series", call("series", path=f"{F}/test.bag", topic="/ekf/odom",
                        fields=["pose.pose.position.x", "pose.pose.position.y"], maxPoints=100),
         ["rows", "returned", "decimated"])
print("       stats x:", {k: round(v, 4) for k, v in r["stats"]["pose.pose.position.x"].items()})

print("\n== inspect TUM trajectory (headerless, no .csv header row) ==")
r = show("inspect tum", call("inspect", path=f"{F}/gt.tum"), ["kind", "rows"])
print("       columns:", [c["name"] for c in r["columns"]])

r = show("fields tum", call("fields", path=f"{F}/gt.tum"), ["rows"])
print("       time column:", r["timeColumn"], "| suggested axes:", r["suggested"])
assert r["timeColumn"] == "_time_s", "TUM source should carry a real time column, not fall back to index"
assert r["syncTimeColumn"] == "timestamp", (
    f"cross-source sync must default to the absolute `timestamp`, not a relative one, got {r['syncTimeColumn']!r}"
)

print("\n== headerless numeric CSV keeps its first data row ==")
r = show("inspect headerless", call("inspect", path=f"{F}/headerless.csv"), ["kind", "rows"])
assert r["rows"] == 3, f"expected 3 rows preserved, got {r['rows']}"
print("       columns:", [c["name"] for c in r["columns"]])

print("\n== TUM export uses an absolute timestamp, not _time_s ==")
tum_export_path = f"{F}/export_check.tum"
r = show("export_tum", call("export_tum", source={"path": f"{F}/test.bag", "topic": "/ground_truth/odom"},
                             target=tum_export_path), ["rows", "timeColumn"])
assert r["timeColumn"] != "_time_s"
exported_lines = Path(tum_export_path).read_text().strip().splitlines()
assert len(exported_lines) == r["rows"]
first_cols = exported_lines[0].split()
assert len(first_cols) == 8, f"TUM rows must have exactly 8 fields, got {len(first_cols)}"
# Re-load the export and confirm it round-trips through our own TUM loader.
reloaded = show("reload exported tum", call("inspect", path=tum_export_path), ["kind", "rows"])
assert reloaded["rows"] == r["rows"]
Path(tum_export_path).unlink()

# ── EVO is now the ONLY thing that computes APE/RPE. Everything below drives
# the real evo_ape/evo_rpe/evo_traj executables and checks the extension's
# numbers against evo run completely independently (a bare subprocess call,
# with no bridge code involved at all) — the actual acceptance criterion.
stag_gt = {"path": f"{F}/staggered_gt.tum"}
stag_est = {"path": f"{F}/staggered_est.tum"}
EVO_APE = shutil.which("evo_ape") or str(Path(sys.executable).parent / "evo_ape")
EVO_RPE = shutil.which("evo_rpe") or str(Path(sys.executable).parent / "evo_rpe")
have_evo = Path(EVO_APE).exists()

if not have_evo:
    print("\n== SKIPPED: evo is not installed in this interpreter (pip install evo) ==")
else:
    def run_evo_directly(exe, ref, est, extra_args, results_zip):
        proc = subprocess.run(
            [exe, "tum", ref, est, *extra_args, "--save_results", str(results_zip), "--no_warnings"],
            capture_output=True, text=True, timeout=60,
        )
        assert proc.returncode == 0, f"{exe} failed: {proc.stderr}"
        with zipfile.ZipFile(results_zip) as z:
            return json.loads(z.read("stats.json"))

    print("\n== run_evo (APE, not aligned) matches a bare `evo_ape` subprocess call ==")
    r = show("run_evo ape", call("run_evo", evoCommand="ape", gt=stag_gt, est=stag_est,
                                  poseRelation="trans_part", alignment="none", tMaxDiff=0.01),
             ["commandText", "n"])
    assert r["commandText"].split()[0].endswith("evo_ape")
    assert r["evoVersion"] and r["evoVersion"] != "unknown"
    assert len(r["errorArray"]) == r["n"] == len(r["timeArray"])

    direct_stats = run_evo_directly(EVO_APE, f"{F}/staggered_gt.tum", f"{F}/staggered_est.tum",
                                     ["-r", "trans_part", "--t_max_diff", "0.01"], f"{F}/direct_ape.zip")
    for key in ("rmse", "mean", "median", "min", "max", "sse", "std"):
        assert r["stats"][key] == direct_stats[key], (
            f"APE {key} from run_evo ({r['stats'][key]}) != direct evo_ape subprocess ({direct_stats[key]})"
        )
    print(f"       PASS: identical to a direct `evo_ape` call — rmse={r['stats']['rmse']:.6f} n={r['n']}")
    Path(f"{F}/direct_ape.zip").unlink()

    print("\n== run_evo (APE, SE(3) aligned) matches `evo_ape -a` directly ==")
    r_aligned = show("run_evo ape aligned", call("run_evo", evoCommand="ape", gt=stag_gt, est=stag_est,
                                                  poseRelation="trans_part", alignment="se3"),
                      ["commandText"])
    assert "-a" in r_aligned["commandText"].split()
    assert r_aligned["stats"]["rmse"] < r["stats"]["rmse"], "SE(3) alignment should reduce the reported RMSE here"
    direct_aligned = run_evo_directly(EVO_APE, f"{F}/staggered_gt.tum", f"{F}/staggered_est.tum",
                                       ["-r", "trans_part", "-a"], f"{F}/direct_ape_aligned.zip")
    for key in ("rmse", "mean", "median", "min", "max", "sse", "std"):
        assert r_aligned["stats"][key] == direct_aligned[key]
    print(f"       PASS: aligned rmse={r_aligned['stats']['rmse']:.6f} matches direct `evo_ape -a`")
    Path(f"{F}/direct_ape_aligned.zip").unlink()

    print("\n== run_evo (RPE) matches a bare `evo_rpe` subprocess call ==")
    r_rpe = show("run_evo rpe", call("run_evo", evoCommand="rpe", gt=stag_gt, est=stag_est,
                                      poseRelation="trans_part", alignment="none", delta=1, deltaUnit="f"),
                 ["commandText"])
    assert r_rpe["commandText"].split()[0].endswith("evo_rpe")
    direct_rpe = run_evo_directly(EVO_RPE, f"{F}/staggered_gt.tum", f"{F}/staggered_est.tum",
                                   ["-r", "trans_part", "-d", "1", "-u", "f"], f"{F}/direct_rpe.zip")
    for key in ("rmse", "mean", "median", "min", "max", "sse", "std"):
        assert r_rpe["stats"][key] == direct_rpe[key], (
            f"RPE {key} from run_evo ({r_rpe['stats'][key]}) != direct evo_rpe subprocess ({direct_rpe[key]})"
        )
    print(f"       PASS: identical to a direct `evo_rpe` call — rmse={r_rpe['stats']['rmse']:.6f}")
    Path(f"{F}/direct_rpe.zip").unlink()

    print("\n== run_evo (traj) runs the real evo_traj and returns its raw output ==")
    r_traj = show("run_evo traj", call("run_evo", evoCommand="traj", sources=[stag_gt, stag_est]),
                   ["commandText"])
    assert r_traj["commandText"].split()[0].endswith("evo_traj")
    assert "nr. of poses" in r_traj["stdout"]

    print("\n== run_evo: custom arguments replace the GUI-built flags ==")
    r_custom = show("run_evo ape (custom args)", call(
        "run_evo", evoCommand="ape", gt=stag_gt, est=stag_est,
        customArgs="-r trans_part -a --t_max_diff 0.01",
    ), ["commandText"])
    assert "-a" in r_custom["commandText"].split()
    assert r_custom["stats"]["rmse"] == r_aligned["stats"]["rmse"], (
        "custom args '-r trans_part -a --t_max_diff 0.01' should reproduce the same result as "
        "the GUI's alignment=se3 option, since they build the identical evo_ape invocation"
    )
    print(f"       PASS: custom args reproduced the GUI-built result — rmse={r_custom['stats']['rmse']:.6f}")

    print("\n== run_evo: a user-typed --save_results is stripped, not fought over ==")
    r_custom_save = show("run_evo ape (custom args with --save_results)", call(
        "run_evo", evoCommand="ape", gt=stag_gt, est=stag_est,
        customArgs="-r trans_part --save_results /tmp/should-be-ignored.zip",
    ), ["commandText", "n"])
    assert "/tmp/should-be-ignored.zip" not in r_custom_save["commandText"]
    assert r_custom_save["n"] > 0
    print("       PASS: the user's --save_results was stripped and ours was used instead")

    print("\n== run_evo: unparseable custom arguments surface a clear error ==")
    resp = call("run_evo", evoCommand="ape", gt=stag_gt, est=stag_est, customArgs="-r 'unclosed quote")
    print(f"       ok={resp['ok']} error={resp.get('error')!r}")
    assert not resp["ok"] and "custom evo arguments" in resp["error"]

    print("\n== export_evaluation writes a self-contained, reproducible package ==")
    eval_dir = f"{F}/evaluation_check"
    r_pkg = show("export_evaluation", call("export_evaluation", evoCommand="ape", gt=stag_gt, est=stag_est,
                                            refLabel="staggered_gt", estLabel="staggered_est", target=eval_dir),
                 ["path", "n"])
    for name in ("staggered_gt.tum", "staggered_est.tum", "command.txt", "evo_output.txt",
                 "results.json", "metadata.json"):
        assert (Path(eval_dir) / name).exists(), f"evaluation package is missing {name}"
    metadata = json.loads((Path(eval_dir) / "metadata.json").read_text())
    assert metadata["evoCommand"] == "evo_ape"
    assert metadata["command"][0].endswith("evo_ape")
    # The whole point: paste command.txt into a terminal and get the same numbers back.
    reproduced = subprocess.run(
        ["bash", "-c", (Path(eval_dir) / "command.txt").read_text()], capture_output=True, text=True, timeout=30,
    )
    assert reproduced.returncode == 0
    assert "rmse" in reproduced.stdout
    reproduced_rmse = float(reproduced.stdout.splitlines()[7].split()[-1])
    assert abs(reproduced_rmse - r_pkg["stats"]["rmse"]) < 1e-5, (
        f"re-running the saved command.txt gave a different rmse: {reproduced_rmse} vs {r_pkg['stats']['rmse']}"
    )
    print(f"       PASS: {eval_dir} reproduces rmse={r_pkg['stats']['rmse']:.6f} when command.txt is re-run standalone")
    shutil.rmtree(eval_dir)

print("\n== list_frames reports this bag's /tf + /tf_static edges ==")
r = show("list_frames", call("list_frames", path=f"{F}/test.bag"))
assert set(r["frames"]) >= {"map", "odom", "sensor_frame"}, r["frames"]
edges = {(e["parent"], e["child"]): e for e in r["edges"]}
assert edges[("map", "odom")]["static"] is True
assert edges[("odom", "sensor_frame")]["static"] is False and edges[("odom", "sensor_frame")]["count"] > 1
print(f"       frames={r['frames']}  edges={[(k, v['static']) for k, v in edges.items()]}")

print("\n== create_derived_topic: TF reference matches an independent scipy computation ==")
try:
    from scipy.spatial.transform import Rotation as R
    have_scipy = True
except ImportError:
    have_scipy = False

MAP_ODOM_T = np.array([5.0, 3.0, 0.0])
MAP_ODOM_YAW = 0.3

r = show("create_derived_topic (tf)", call(
    "create_derived_topic", path=f"{F}/test.bag", topic="/ground_truth/odom",
    reference={"type": "tf", "parent": "map", "child": "odom"}, invert=False, name="gt_in_map",
), ["topic", "rows", "sourceTopic"])
assert r["topic"] == "/gt_in_map"

base = show("fields (base, for comparison)", call("fields", path=f"{F}/test.bag", topic="/ground_truth/odom"))
derived = show("fields (derived)", call("fields", path=f"{F}/test.bag", topic="/gt_in_map"))
assert derived["rows"] == base["rows"]

series_base = show("series (base)", call(
    "series", path=f"{F}/test.bag", topic="/ground_truth/odom",
    fields=["pose.pose.position.x", "pose.pose.position.y", "pose.pose.position.z",
            "pose.pose.orientation.x", "pose.pose.orientation.y", "pose.pose.orientation.z", "pose.pose.orientation.w"],
    maxPoints=1_000_000,
))
series_derived = show("series (derived)", call(
    "series", path=f"{F}/test.bag", topic="/gt_in_map",
    fields=["pos_x", "pos_y", "pos_z", "qx", "qy", "qz", "qw"], maxPoints=1_000_000,
))

if have_scipy:
    bx = np.array(series_base["series"]["pose.pose.position.x"])
    by = np.array(series_base["series"]["pose.pose.position.y"])
    bz = np.array(series_base["series"]["pose.pose.position.z"])
    bq = np.stack([
        series_base["series"]["pose.pose.orientation.x"], series_base["series"]["pose.pose.orientation.y"],
        series_base["series"]["pose.pose.orientation.z"], series_base["series"]["pose.pose.orientation.w"],
    ], axis=-1)
    rot_ref = R.from_quat([0.0, 0.0, math.sin(MAP_ODOM_YAW / 2), math.cos(MAP_ODOM_YAW / 2)])
    expected_t = MAP_ODOM_T + rot_ref.apply(np.stack([bx, by, bz], axis=-1))
    expected_q = (rot_ref * R.from_quat(bq)).as_quat()

    dx = np.array(series_derived["series"]["pos_x"])
    dy = np.array(series_derived["series"]["pos_y"])
    dz = np.array(series_derived["series"]["pos_z"])
    dq = np.stack([series_derived["series"]["qx"], series_derived["series"]["qy"],
                   series_derived["series"]["qz"], series_derived["series"]["qw"]], axis=-1)

    assert np.allclose(dx, expected_t[:, 0], atol=1e-6), "derived X doesn't match an independent scipy transform"
    assert np.allclose(dy, expected_t[:, 1], atol=1e-6), "derived Y doesn't match an independent scipy transform"
    assert np.allclose(dz, expected_t[:, 2], atol=1e-6), "derived Z doesn't match an independent scipy transform"
    # Quaternion sign is only defined up to an overall +/-1 flip.
    same_sign = np.sign(np.sum(dq * expected_q, axis=-1, keepdims=True))
    assert np.allclose(dq * same_sign, expected_q, atol=1e-6), "derived orientation doesn't match scipy"
    print("       PASS: TF-derived topic matches an independent scipy Rotation computation")
else:
    print("       SKIPPED: scipy not importable in this interpreter — only structural checks ran")

print("\n== create_derived_topic: manual reference reproduces the same TF-based result ==")
r_manual = show("create_derived_topic (manual)", call(
    "create_derived_topic", path=f"{F}/test.bag", topic="/ground_truth/odom",
    reference={
        "type": "manual", "tx": 5.0, "ty": 3.0, "tz": 0.0,
        "qx": 0.0, "qy": 0.0, "qz": math.sin(MAP_ODOM_YAW / 2), "qw": math.cos(MAP_ODOM_YAW / 2),
    },
    invert=False, name="gt_in_map_manual",
), ["topic", "rows"])
series_manual = show("series (manual)", call(
    "series", path=f"{F}/test.bag", topic="/gt_in_map_manual", fields=["pos_x", "pos_y", "pos_z"], maxPoints=1_000_000,
))
assert np.allclose(series_manual["series"]["pos_x"], series_derived["series"]["pos_x"], atol=1e-9)
assert np.allclose(series_manual["series"]["pos_y"], series_derived["series"]["pos_y"], atol=1e-9)
print("       PASS: manual reference == TF-looked-up reference for the same underlying transform")

print("\n== create_derived_topic: invert round-trips back to the original pose ==")
show("create_derived_topic (invert back)", call(
    "create_derived_topic", path=f"{F}/test.bag", topic="/gt_in_map",
    reference={"type": "tf", "parent": "map", "child": "odom"}, invert=True, name="gt_roundtrip",
), ["topic", "rows"])
series_roundtrip = show("series (roundtrip)", call(
    "series", path=f"{F}/test.bag", topic="/gt_roundtrip", fields=["pos_x", "pos_y", "pos_z"], maxPoints=1_000_000,
))
assert np.allclose(series_roundtrip["series"]["pos_x"], series_base["series"]["pose.pose.position.x"], atol=1e-6)
assert np.allclose(series_roundtrip["series"]["pos_y"], series_base["series"]["pose.pose.position.y"], atol=1e-6)
print("       PASS: forward transform then its inverse reconstructs the original trajectory")

print("\n== create_derived_topic shows up as a real topic in inspect() ==")
r_inspect = show("inspect (with derived topics)", call("inspect", path=f"{F}/test.bag"))
by_name = {t["topic"]: t for t in r_inspect["topics"]}
assert by_name["/gt_in_map"]["derived"] is True
assert by_name["/gt_in_map"]["messages"] == base["rows"]
print(f"       PASS: /gt_in_map listed alongside real topics, type={by_name['/gt_in_map']['type']!r}")

print("\n== create_derived_topic: TUM export uses the real absolute clock, not a raw nanosecond one ==")
# Regression test: a derived topic has no `header.stamp_s`, and its internal
# TF-chaining clock must NOT be named `_stamp_ns` — that name outranks
# `timestamp` in TIME_RANK, so pick_sync_time_column would pick it for TUM
# export and write nanosecond-scale numbers as if they were seconds, leaving
# zero timestamp overlap with any other trajectory's real export.
derived_tum_path = f"{F}/gt_in_map_check.tum"
r_tum = show("export_tum (derived)", call(
    "export_tum", source={"path": f"{F}/test.bag", "topic": "/gt_in_map"}, target=derived_tum_path,
), ["rows", "timeColumn"])
assert r_tum["timeColumn"] not in ("_stamp_ns", "_derived_align_ns"), (
    f"derived-topic TUM export picked {r_tum['timeColumn']!r} as the time column — not an absolute-seconds clock"
)
first_t = float(Path(derived_tum_path).read_text().splitlines()[0].split()[0])
assert first_t < 1e12, f"derived-topic TUM timestamp looks like raw nanoseconds, not seconds: {first_t}"
Path(derived_tum_path).unlink()
print(f"       PASS: timeColumn={r_tum['timeColumn']!r}, first timestamp={first_t}")

if have_evo:
    print("\n== create_derived_topic: evo_ape actually runs against it (the reported failure mode) ==")
    r_evo_derived = show("run_evo ape (derived vs. real topic)", call(
        "run_evo", evoCommand="ape",
        gt={"path": f"{F}/test.bag", "topic": "/gt_in_map"},
        est={"path": f"{F}/test.bag", "topic": "/ekf/odom"},
        poseRelation="trans_part", alignment="none", tMaxDiff=0.05,
    ), ["commandText", "n"])
    assert r_evo_derived["n"] > 0, "evo_ape found no matching timestamps between a derived topic and a real one"
    print(f"       PASS: evo_ape matched {r_evo_derived['n']} poses, rmse={r_evo_derived['stats']['rmse']:.4f}")
else:
    print("\n== SKIPPED: evo not installed, can't exercise run_evo against a derived topic ==")

print("\n== create_derived_topic rejects a name collision ==")
resp = call("create_derived_topic", path=f"{F}/test.bag", topic="/ground_truth/odom",
            reference={"type": "manual", "tx": 0, "ty": 0, "tz": 0, "qx": 0, "qy": 0, "qz": 0, "qw": 1},
            invert=False, name="/gt_in_map")
print(f"       ok={resp['ok']} error={resp.get('error')!r}")
assert not resp["ok"] and "already exists" in resp["error"]

print("\n== create_derived_topic rejects a request with no direct TF edge ==")
resp = call("create_derived_topic", path=f"{F}/test.bag", topic="/ground_truth/odom",
            reference={"type": "tf", "parent": "map", "child": "sensor_frame"}, invert=False, name="/should_fail")
print(f"       ok={resp['ok']} error={resp.get('error')!r}")
assert not resp["ok"] and "No direct transform" in resp["error"]

print("\n== error paths ==")
for label, kwargs in [
    ("missing file", dict(path="/nope/absent.bag")),
    ("bad extension", dict(path=f"{F}/../make_fixtures.py")),
    ("unknown topic", dict(path=f"{F}/test.bag", topic="/does/not/exist")),
]:
    resp = call("inspect" if "topic" not in kwargs else "fields", **kwargs)
    print(f"  {label}: ok={resp['ok']} error={resp.get('error')!r} hint={resp.get('hint')!r}")

resp = call("bogus_command")
print(f"  unknown cmd: ok={resp['ok']} error={resp.get('error')!r}")

print("\n== cache ==")
show("clear", call("clear"), ["cleared"])

proc.stdin.close()
proc.wait(timeout=5)
print("\nstderr log:")
print("\n".join("  " + l for l in proc.stderr.read().strip().splitlines()))

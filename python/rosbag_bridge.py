#!/usr/bin/env python3
"""
rosbag_bridge.py — sidecar process for the Rosbag Analyzer VS Code extension.

Speaks line-delimited JSON over stdin/stdout. One request per line in, one
response per line out. Nothing is printed to stdout except responses; all
diagnostics go to stderr so the extension can surface them in its log.

Request   {"id": 1, "cmd": "inspect", "args": {...}}
Response  {"id": 1, "ok": true, "result": {...}}
          {"id": 1, "ok": false, "error": "message", "hint": "what to do"}

Commands
  probe             — report interpreter + library availability (incl. evo)
  inspect           — list topics (bag) or columns (csv) for a path
  fields            — numeric field names available on one topic
  series            — downsampled numeric columns for plotting
  export            — write a source's full decoded data to a CSV file on disk
  export_tum        — write a source as a standard TUM trajectory file
  run_evo           — run the real evo_ape/evo_rpe/evo_traj executable and parse its results
  export_evaluation — write a full reproducible evaluation package (TUM files, command,
                       raw evo output, parsed results, metadata) to a chosen folder
  list_frames       — frame names and /tf + /tf_static edges known for a bag
  create_derived_topic — re-express a pose topic in another frame (manual or TF-looked-up
                       reference) and register the result as a new, session-only topic
  clear             — drop the parse cache and any derived topics

Accuracy evaluation is intentionally NOT computed by this file. `run_evo` /
`export_evaluation` prepare TUM inputs and invoke the actual `evo_ape` /
`evo_rpe` / `evo_traj` executables installed alongside this interpreter, then
parse *their* output — evo is the single source of truth for every number
the Accuracy tab displays.
"""

from __future__ import annotations

import io
import json
import math
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
import zipfile
from collections import OrderedDict
from datetime import datetime
from pathlib import Path
from typing import Any

PROTOCOL_VERSION = 1
MAX_ARRAY_ELEMS = 4          # how many elements of a numeric array to flatten
CACHE_MAX_ENTRIES = 8        # parsed topics held in memory

# ── Optional dependencies ─────────────────────────────────────────────────────

try:
    import numpy as np
except ImportError:  # numpy is not optional in practice, but fail readably
    np = None  # type: ignore[assignment]

try:
    import pandas as pd
except ImportError:
    pd = None  # type: ignore[assignment]

ROSBAGS_ERROR: str | None = None
try:
    from rosbags.rosbag1 import Reader as Ros1Reader
    from rosbags.rosbag2 import Reader as Ros2Reader
    from rosbags.typesys import Stores, get_types_from_msg, get_typestore
    ROSBAGS_OK = True
except ImportError as exc:  # pragma: no cover - environment dependent
    ROSBAGS_OK = False
    ROSBAGS_ERROR = str(exc)


class BridgeError(Exception):
    """An error worth showing the user verbatim, with an optional next step."""

    def __init__(self, message: str, hint: str = "") -> None:
        super().__init__(message)
        self.hint = hint


def log(*parts: Any) -> None:
    print(*parts, file=sys.stderr, flush=True)


# ── Message flattening ────────────────────────────────────────────────────────

def _is_msg(val: Any) -> bool:
    return hasattr(val, "__slots__") or hasattr(val, "__dataclass_fields__")


def _slots(obj: Any) -> list[str]:
    slots = getattr(obj, "__slots__", None)
    if slots:
        return list(slots)
    return list(getattr(obj, "__dataclass_fields__", {}).keys())


def quat_to_euler(x: float, y: float, z: float, w: float) -> tuple[float, float, float]:
    """Quaternion to roll/pitch/yaw in radians (ZYX / aerospace convention)."""
    norm = math.sqrt(x * x + y * y + z * z + w * w)
    if norm == 0.0:
        return (0.0, 0.0, 0.0)
    x, y, z, w = x / norm, y / norm, z / norm, w / norm

    roll = math.atan2(2.0 * (w * x + y * z), 1.0 - 2.0 * (x * x + y * y))
    sinp = 2.0 * (w * y - z * x)
    pitch = math.copysign(math.pi / 2.0, sinp) if abs(sinp) >= 1.0 else math.asin(sinp)
    yaw = math.atan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z))
    return (roll, pitch, yaw)


def quat_to_euler_vec(x: Any, y: Any, z: Any, w: Any) -> tuple[Any, Any, Any]:
    """Array form of `quat_to_euler`, for deriving roll/pitch/yaw columns in bulk."""
    norm = np.sqrt(x * x + y * y + z * z + w * w)
    norm = np.where(norm == 0.0, 1.0, norm)
    x, y, z, w = x / norm, y / norm, z / norm, w / norm

    roll = np.arctan2(2.0 * (w * x + y * z), 1.0 - 2.0 * (x * x + y * y))
    sinp = np.clip(2.0 * (w * y - z * x), -1.0, 1.0)
    pitch = np.arcsin(sinp)
    yaw = np.arctan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z))
    return roll, pitch, yaw


def _quat_normalize(q: Any) -> Any:
    q = np.asarray(q, dtype=float)
    norm = np.linalg.norm(q, axis=-1, keepdims=True)
    norm = np.where(norm == 0.0, 1.0, norm)
    return q / norm


def _quat_conjugate(q: Any) -> Any:
    q = np.array(q, dtype=float, copy=True)
    q[..., :3] *= -1.0
    return q


def _quat_mul(a: Any, b: Any) -> Any:
    """Hamilton product a ⊗ b in (x, y, z, w) order, broadcasting over any
    leading batch dimensions — used to compose a reference transform with a
    per-row orientation without a Python loop."""
    a = np.asarray(a, dtype=float)
    b = np.asarray(b, dtype=float)
    ax, ay, az, aw = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    bx, by, bz, bw = b[..., 0], b[..., 1], b[..., 2], b[..., 3]
    x = aw * bx + ax * bw + ay * bz - az * by
    y = aw * by - ax * bz + ay * bw + az * bx
    z = aw * bz + ax * by - ay * bx + az * bw
    w = aw * bw - ax * bx - ay * by - az * bz
    return np.stack([x, y, z, w], axis=-1)


def _rotate_vectors(q: Any, v: Any) -> Any:
    """Rotate vector(s) v (..., 3) by unit quaternion(s) q (..., 4) in (x, y,
    z, w) order, broadcasting a single reference orientation against a whole
    trajectory or an already per-row orientation array."""
    q = _quat_normalize(q)
    qxyz = q[..., :3]
    qw = q[..., 3:4]
    v = np.asarray(v, dtype=float)
    t = 2.0 * np.cross(qxyz, v)
    return v + qw * t + np.cross(qxyz, t)


def _invert_transform(t_ref: Any, q_ref: Any) -> tuple[Any, Any]:
    """Inverse of the rigid transform (t_ref, q_ref): p -> R(q_ref) @ p + t_ref."""
    q_inv = _quat_conjugate(_quat_normalize(q_ref))
    t_inv = -_rotate_vectors(q_inv, t_ref)
    return t_inv, q_inv


def _compose_transform(t_ref: Any, q_ref: Any, t_orig: Any, q_orig: Any) -> tuple[Any, Any]:
    """Compose a reference transform with a per-row pose: result expresses the
    same trajectory in the reference transform's target frame. t_ref/q_ref may
    be a single (3,)/(4,) transform (a static or manual reference) or a
    per-row (N,3)/(N,4) array (nearest-in-time dynamic TF samples) — numpy
    broadcasting makes both cases fall out of the same formula."""
    new_q = _quat_mul(q_ref, q_orig)
    new_t = np.asarray(t_ref, dtype=float) + _rotate_vectors(q_ref, t_orig)
    return new_t, new_q


def flatten_msg(obj: Any, prefix: str = "") -> dict[str, float]:
    """
    Recursively flatten a ROS message into a flat dict of floats.

    Any quaternion found along the way also yields derived `.roll`, `.pitch`
    and `.yaw` columns in radians, so orientation error can be measured
    without post-processing.
    """
    out: dict[str, float] = {}
    quat: dict[str, float] = {}

    for attr in _slots(obj):
        val = getattr(obj, attr, None)
        key = f"{prefix}.{attr}".lstrip(".")

        if isinstance(val, bool):
            out[key] = float(val)
        elif isinstance(val, (int, float)) or (np is not None and isinstance(val, (np.floating, np.integer))):
            out[key] = float(val)
            if attr in ("x", "y", "z", "w"):
                quat[attr] = float(val)
        elif val is not None and _is_msg(val):
            out.update(flatten_msg(val, key))
        elif val is not None and hasattr(val, "__iter__") and not isinstance(val, (str, bytes)):
            try:
                arr = list(val)
            except Exception:
                continue
            if arr and _is_msg(arr[0]):
                # Sequence of sub-messages (e.g. nav_msgs/Path poses) — take the first
                # so that path-style topics still expose position columns.
                out.update(flatten_msg(arr[0], f"{key}[0]"))
            elif arr and isinstance(arr[0], (int, float)) or (
                arr and np is not None and isinstance(arr[0], (np.floating, np.integer))
            ):
                for j, v in enumerate(arr[:MAX_ARRAY_ELEMS]):
                    try:
                        out[f"{key}[{j}]"] = float(v)
                    except (TypeError, ValueError):
                        break

    if len(quat) == 4:
        roll, pitch, yaw = quat_to_euler(quat["x"], quat["y"], quat["z"], quat["w"])
        base = prefix or "orientation"
        out[f"{base}.roll"] = roll
        out[f"{base}.pitch"] = pitch
        out[f"{base}.yaw"] = yaw

    return out


# ── Path resolution ───────────────────────────────────────────────────────────

def classify(path_str: str) -> tuple[str, Path]:
    """
    Work out what kind of input this is and the path rosbags actually wants.

    A ROS 2 bag is a *directory* containing metadata.yaml, so pointing at a
    .db3 inside one resolves up to the folder rather than failing.
    """
    path = Path(path_str).expanduser()
    if not path.exists():
        raise BridgeError(f"No such file or folder: {path}", "Check the path and try again.")

    if path.is_dir():
        if (path / "metadata.yaml").exists():
            return ("ros2", path)
        db3s = sorted(path.glob("*.db3")) + sorted(path.glob("*.mcap"))
        if db3s:
            return ("ros2", path)
        raise BridgeError(
            f"{path.name} is a folder with no metadata.yaml or .db3 inside.",
            "Select the bag folder produced by `ros2 bag record`.",
        )

    suffix = path.suffix.lower()
    if suffix == ".bag":
        return ("ros1", path)
    if suffix in (".db3", ".mcap"):
        parent = path.parent
        if (parent / "metadata.yaml").exists():
            return ("ros2", parent)
        return ("ros2", parent)
    if suffix in (".csv", ".tsv", ".txt", ".tum"):
        return ("csv", path)

    raise BridgeError(
        f"Unrecognised file type: {path.suffix or path.name}",
        "Supported inputs are .bag, a ROS 2 bag folder, .db3, .mcap, .csv and .tum.",
    )


def _require_rosbags() -> None:
    if not ROSBAGS_OK:
        raise BridgeError(
            "The `rosbags` library is not installed in the selected interpreter.",
            "Run: pip install rosbags",
        )


def _require_pandas() -> None:
    if pd is None or np is None:
        raise BridgeError(
            "pandas and numpy are required.",
            "Run: pip install pandas numpy",
        )


def open_reader(kind: str, path: Path):
    _require_rosbags()
    return (Ros2Reader if kind == "ros2" else Ros1Reader)(path)


def build_typestore(kind: str, reader: Any) -> Any:
    """
    Typestore for the bag, with any custom message definitions carried in the
    bag itself registered on top. Without this step, bags recorded with
    non-standard messages fail to deserialize.
    """
    store = get_typestore(Stores.ROS2_HUMBLE if kind == "ros2" else Stores.ROS1_NOETIC)
    added = 0
    for conn in getattr(reader, "connections", []):
        msgdef = getattr(conn, "msgdef", None)
        if not msgdef or conn.msgtype in store.types:
            continue
        try:
            # conn.msgdef is a MessageDefinition wrapper, not the raw text —
            # get_types_from_msg needs .data. Passing the wrapper itself
            # always raised, so this registration silently never succeeded;
            # every bag with a genuinely custom message type had that topic
            # quietly skipped as "undecodable" instead of actually decoding.
            store.register(get_types_from_msg(msgdef.data, conn.msgtype))
            added += 1
        except Exception as exc:
            log(f"[bridge] could not register {conn.msgtype}: {exc}")
    if added:
        log(f"[bridge] registered {added} custom message type(s) from the bag")
    return store


# ── Parse cache ───────────────────────────────────────────────────────────────

_cache: OrderedDict[tuple, Any] = OrderedDict()

# Topics synthesised by `create_derived_topic` (a reference-frame transform of
# an existing topic), keyed by the bag's resolved path then the new topic
# name. These live only for the process lifetime — session-only by design, so
# nothing here ever writes to or otherwise touches the original bag file.
_derived_topics: dict[str, dict[str, Any]] = {}


def cache_get(key: tuple) -> Any | None:
    if key in _cache:
        _cache.move_to_end(key)
        return _cache[key]
    return None


def cache_put(key: tuple, value: Any) -> None:
    _cache[key] = value
    _cache.move_to_end(key)
    while len(_cache) > CACHE_MAX_ENTRIES:
        _cache.popitem(last=False)


def _stamp(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


# ── Data loading ──────────────────────────────────────────────────────────────

def _sniff_tum(path: Path) -> bool:
    """
    TUM trajectory format: `timestamp tx ty tz qx qy qz qw`, whitespace
    separated, no header row — what evo, ORB-SLAM and friends write.

    Detected by extension OR by shape, so a file merely renamed to .csv/.txt
    is still recognised instead of quietly eating its first pose as a header.
    """
    if path.suffix.lower() == ".tum":
        return True
    try:
        with open(path, "r") as fh:
            for line in fh:
                stripped = line.strip()
                if not stripped or stripped.startswith("#"):
                    continue
                parts = stripped.split()
                if len(parts) != 8:
                    return False
                try:
                    [float(p) for p in parts]
                except ValueError:
                    return False
                return True
    except OSError:
        return False
    return False


def load_tum(path: Path) -> Any:
    """
    Parse a TUM-format trajectory: one `timestamp tx ty tz qx qy qz qw` pose
    per line, no header. Columns are named to match the existing axis/time
    heuristics (`pos_x`, `_time_s`, derived `roll`/`pitch`/`yaw`) so the rest
    of the pipeline — auto-mapping, time alignment — treats it like any other
    source without special-casing.
    """
    _require_pandas()
    key = ("tum", str(path), _stamp(path))
    hit = cache_get(key)
    if hit is not None:
        return hit

    rows: list[list[float]] = []
    with open(path, "r") as fh:
        for line in fh:
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            parts = stripped.split()
            if len(parts) != 8:
                continue
            try:
                rows.append([float(p) for p in parts])
            except ValueError:
                continue

    if not rows:
        raise BridgeError(
            f"No TUM-format rows found in {path.name}.",
            "Expected one `timestamp tx ty tz qx qy qz qw` pose per line, whitespace separated.",
        )

    arr = np.asarray(rows, dtype=float)
    frame = pd.DataFrame({
        "timestamp": arr[:, 0],
        "pos_x": arr[:, 1],
        "pos_y": arr[:, 2],
        "pos_z": arr[:, 3],
        "qx": arr[:, 4],
        "qy": arr[:, 5],
        "qz": arr[:, 6],
        "qw": arr[:, 7],
    })
    frame["_time_s"] = frame["timestamp"] - frame["timestamp"].iloc[0]
    roll, pitch, yaw = quat_to_euler_vec(
        frame["qx"].to_numpy(), frame["qy"].to_numpy(), frame["qz"].to_numpy(), frame["qw"].to_numpy(),
    )
    frame["roll"], frame["pitch"], frame["yaw"] = roll, pitch, yaw

    cache_put(key, frame)
    return frame


def load_csv(path: Path) -> Any:
    if _sniff_tum(path):
        return load_tum(path)

    _require_pandas()
    key = ("csv", str(path), _stamp(path))
    hit = cache_get(key)
    if hit is not None:
        return hit
    try:
        sep = "\t" if path.suffix.lower() == ".tsv" else None
        frame = pd.read_csv(path, sep=sep, engine="python" if sep is None else "c")
    except Exception as exc:
        raise BridgeError(f"Could not read {path.name}: {exc}", "Check the delimiter and header row.")

    def _all_numeric(names: Any) -> bool:
        for name in names:
            try:
                float(name)
            except (TypeError, ValueError):
                return False
        return True

    if _all_numeric(frame.columns):
        # pandas assumed a header row, but every "column name" parses as a
        # number — this file has no header and its first pose just got eaten.
        try:
            frame = pd.read_csv(path, sep=sep, engine="python" if sep is None else "c", header=None)
        except Exception as exc:
            raise BridgeError(f"Could not read {path.name}: {exc}", "Check the delimiter and header row.")
        frame.columns = [f"col{i}" for i in range(len(frame.columns))]

    # `rostopic echo -p` writes numbers that pandas may leave as objects when a
    # row is ragged. Coerce column by column; `errors="ignore"` was removed in
    # pandas 3.0, so a per-column try is the portable form.
    for column in frame.columns:
        if frame[column].dtype == object:
            converted = pd.to_numeric(frame[column], errors="coerce")
            if converted.notna().sum() >= max(1, int(0.8 * len(frame))):
                frame[column] = converted

    frame.columns = [str(c).strip() for c in frame.columns]
    cache_put(key, frame)
    return frame


def load_topic(kind: str, path: Path, topic: str) -> Any:
    """Read every message on one topic into a flat DataFrame."""
    _require_pandas()
    derived = _derived_topics.get(str(path), {}).get(topic)
    if derived is not None:
        return derived
    key = ("topic", kind, str(path), topic, _stamp(path))
    hit = cache_get(key)
    if hit is not None:
        return hit

    rows: list[dict[str, float]] = []
    failures = 0
    started = time.time()

    with open_reader(kind, path) as reader:
        store = build_typestore(kind, reader)
        conns = [c for c in reader.connections if c.topic == topic]
        if not conns:
            raise BridgeError(
                f"Topic {topic} is not in this bag.",
                "Reopen the analyzer to refresh the topic list.",
            )
        t0: int | None = None
        for conn, timestamp, raw in reader.messages(connections=conns):
            try:
                msg = (
                    store.deserialize_cdr(raw, conn.msgtype)
                    if kind == "ros2"
                    else store.deserialize_ros1(raw, conn.msgtype)
                )
            except Exception:
                failures += 1
                continue
            row = flatten_msg(msg)
            if t0 is None:
                t0 = timestamp
            row["_time_s"] = (timestamp - t0) / 1e9
            row["_stamp_ns"] = float(timestamp)
            rows.append(row)

    if not rows:
        detail = f" ({failures} messages failed to deserialize)" if failures else ""
        raise BridgeError(
            f"No numeric data decoded from {topic}{detail}.",
            "This topic may carry only strings, images or an unregistered custom type.",
        )
    if failures:
        log(f"[bridge] {topic}: skipped {failures} undecodable message(s)")

    frame = pd.DataFrame(rows)

    # A message's own header stamp is often the honest clock for comparing two
    # sources. Recombine sec + nanosec into one full-resolution column, because
    # `header.stamp.sec` alone quantises everything to a whole second.
    sec_col = next((c for c in frame.columns if c.endswith("header.stamp.sec")), None)
    nsec_col = next(
        (c for c in frame.columns if c.endswith(("header.stamp.nanosec", "header.stamp.nsec"))), None
    )
    if sec_col is not None and nsec_col is not None:
        stamp = frame[sec_col].to_numpy(dtype=float) + frame[nsec_col].to_numpy(dtype=float) / 1e9
        if np.isfinite(stamp).any() and np.nanmax(stamp) > 0:
            frame["header.stamp_s"] = stamp

    log(f"[bridge] {topic}: {len(frame)} rows x {len(frame.columns)} cols in {time.time()-started:.2f}s")
    cache_put(key, frame)
    return frame


def load_source(spec: dict[str, Any]) -> Any:
    """A source is {"path": ..., "topic": ...}; topic is absent for CSV."""
    path_str = spec.get("path")
    if not path_str:
        raise BridgeError("Source is missing a path.")
    kind, resolved = classify(path_str)
    if kind == "csv":
        return load_csv(resolved)
    topic = spec.get("topic")
    if not topic:
        raise BridgeError("Source is missing a topic.", "Pick a topic for this bag.")
    return load_topic(kind, resolved, topic)


def numeric_columns(frame: Any) -> list[str]:
    return [c for c in frame.select_dtypes(include=[np.number]).columns.tolist()]


# ── Commands ──────────────────────────────────────────────────────────────────

def cmd_probe(_args: dict[str, Any]) -> dict[str, Any]:
    versions = {
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "numpy": getattr(np, "__version__", None),
        "pandas": getattr(pd, "__version__", None),
    }
    if ROSBAGS_OK:
        try:
            from importlib.metadata import version
            versions["rosbags"] = version("rosbags")
        except Exception:
            versions["rosbags"] = "unknown"
    evo_available = False
    try:
        import evo  # noqa: F401
        from importlib.metadata import version as _version
        versions["evo"] = _version("evo")
        evo_available = True
    except ImportError:
        pass
    return {
        "protocol": PROTOCOL_VERSION,
        "rosbags": ROSBAGS_OK,
        "rosbagsError": ROSBAGS_ERROR,
        "pandas": pd is not None,
        "evo": evo_available,
        "versions": versions,
    }


def cmd_inspect(args: dict[str, Any]) -> dict[str, Any]:
    kind, resolved = classify(args["path"])

    if kind == "csv":
        frame = load_csv(resolved)
        return {
            "kind": "csv",
            "path": str(resolved),
            "name": resolved.name,
            "sizeBytes": resolved.stat().st_size,
            "rows": int(len(frame)),
            "columns": [
                {"name": str(c), "numeric": bool(c in numeric_columns(frame)), "dtype": str(frame[c].dtype)}
                for c in frame.columns
            ],
            "preview": preview_rows(frame, 20),
        }

    counts: dict[str, int] = {}
    first: dict[str, int] = {}
    last: dict[str, int] = {}
    types: dict[str, str] = {}

    with open_reader(kind, resolved) as reader:
        for conn in reader.connections:
            types.setdefault(conn.topic, conn.msgtype)
        for conn, timestamp, _ in reader.messages():
            topic = conn.topic
            counts[topic] = counts.get(topic, 0) + 1
            if topic not in first:
                first[topic] = timestamp
            last[topic] = timestamp

    topics = []
    for topic, msgtype in sorted(types.items()):
        n = counts.get(topic, 0)
        span = (last.get(topic, 0) - first.get(topic, 0)) / 1e9
        topics.append({
            "topic": topic,
            "type": msgtype,
            "messages": n,
            "duration": round(span, 3),
            "hz": round(n / span, 2) if span > 0 and n > 1 else None,
        })

    # Topics created by `create_derived_topic` for this bag this session —
    # not on disk, so they never showed up in the reader walk above.
    for name, frame in _derived_topics.get(str(resolved), {}).items():
        n = int(len(frame))
        span = float(frame["_time_s"].iloc[-1] - frame["_time_s"].iloc[0]) if n > 1 else 0.0
        topics.append({
            "topic": name,
            "type": "derived",
            "messages": n,
            "duration": round(span, 3),
            "hz": round(n / span, 2) if span > 0 and n > 1 else None,
            "derived": True,
        })

    starts = [v for v in first.values()]
    ends = [v for v in last.values()]
    size = resolved.stat().st_size if resolved.is_file() else sum(
        f.stat().st_size for f in resolved.rglob("*") if f.is_file()
    )

    return {
        "kind": kind,
        "path": str(resolved),
        "name": resolved.name,
        "sizeBytes": size,
        "topics": topics,
        "totalMessages": sum(counts.values()),
        "duration": round((max(ends) - min(starts)) / 1e9, 3) if starts else 0.0,
        "startEpoch": min(starts) / 1e9 if starts else None,
    }


def preview_rows(frame: Any, limit: int) -> dict[str, Any]:
    head = frame.head(limit)
    return {
        "columns": [str(c) for c in head.columns],
        "rows": [
            [None if (isinstance(v, float) and not math.isfinite(v)) else (v if isinstance(v, (int, float, str)) else str(v))
             for v in row]
            for row in head.itertuples(index=False, name=None)
        ],
    }


def cmd_fields(args: dict[str, Any]) -> dict[str, Any]:
    frame = load_source(args)
    cols = numeric_columns(frame)
    return {
        "rows": int(len(frame)),
        "columns": [str(c) for c in frame.columns],
        "numeric": cols,
        "timeCandidates": time_candidates(frame),
        "timeColumn": pick_time_column(frame),
        # Separate from `timeColumn` above: that one is fine for a single
        # source's own plot axis, but cross-source sync (Accuracy tab) needs
        # an absolute clock — see `pick_sync_time_column`.
        "syncTimeCandidates": sync_time_candidates(frame),
        "syncTimeColumn": pick_sync_time_column(frame),
        "suggested": suggest_axes(cols),
        "angular": [c for c in cols if is_angular(c)],
        "preview": preview_rows(frame, 20),
    }


AXIS_HINTS = {
    "x": ("position.x", "pose.x", "pos_x", ".x", "east", "lon", "longitude"),
    "y": ("position.y", "pose.y", "pos_y", ".y", "north", "lat", "latitude"),
    "z": ("position.z", "pose.z", "pos_z", ".z", "alt", "altitude", "height"),
    "roll": ("roll",),
    "pitch": ("pitch",),
    "yaw": ("yaw", "heading", "theta"),
}


def suggest_axes(cols: list[str]) -> dict[str, str | None]:
    """Best guess at which column is which axis, so the UI opens pre-mapped."""
    out: dict[str, str | None] = {}
    for axis, hints in AXIS_HINTS.items():
        chosen = None
        for hint in hints:
            matches = [c for c in cols if hint in str(c).lower()]
            if matches:
                chosen = min(matches, key=len)
                break
        out[axis] = chosen
    return out


# Ranked, best first. A loose substring match is worse than useless here: "t"
# appears in nearly every field name, and picking `header.stamp.sec` over a
# full-resolution column silently quantises every timestamp to a whole second.
TIME_RANK = (
    "_time_s",          # synthesised, seconds from bag start, full resolution
    "header.stamp_s",   # synthesised from sec + nanosec
    "_stamp_ns",
    "time",
    "timestamp",
    "%time",            # rostopic echo -p writes this
    "t",
    "secs",
    "field.header.stamp",
)

_ANGLE_TOKENS = ("roll", "pitch", "yaw", "heading", "theta", "azimuth", "bearing")


def _time_score(name: str) -> int:
    """Lower is better; a large number means 'not a time column'."""
    low = str(name).lower().strip()
    tail = low.rsplit(".", 1)[-1]
    for i, hint in enumerate(TIME_RANK):
        if low == hint or tail == hint:
            return i
    if tail in ("sec", "nanosec", "nsecs", "nsec"):
        return len(TIME_RANK) + 1     # usable, but only as a last resort
    return 999


def _looks_like_time(name: str) -> bool:
    return _time_score(name) < 999


def pick_time_column(frame: Any) -> str | None:
    candidates = [c for c in numeric_columns(frame) if _looks_like_time(c)]
    if not candidates:
        return None
    return min(candidates, key=lambda c: (_time_score(c), len(str(c))))


def time_candidates(frame: Any) -> list[str]:
    ranked = [(c, _time_score(c)) for c in numeric_columns(frame)]
    return [c for c, score in sorted(ranked, key=lambda p: p[1]) if score < 999]


# `_time_s` is synthesised as "seconds since THIS topic's own first message",
# per source. It is fine as a single-source plotting axis (Signals tab), but
# using it to line up two *different* sources silently assumes both started
# publishing at the same instant — false whenever recording start times
# differ even slightly, which is the normal case for ground truth vs an
# estimator (or two independently exported TUM files). Cross-source
# synchronization must use an absolute (epoch) clock instead:
# `header.stamp_s` / `timestamp` / `_stamp_ns`, never `_time_s`.
_RELATIVE_ONLY_TIME_NAMES = {"_time_s"}


def _sync_time_score(name: str) -> int:
    if str(name).lower().strip() in _RELATIVE_ONLY_TIME_NAMES:
        return 999
    return _time_score(name)


def pick_sync_time_column(frame: Any) -> str | None:
    """Like `pick_time_column`, but for matching two sources against each
    other — excludes topic-relative columns that aren't a shared clock."""
    candidates = [c for c in numeric_columns(frame) if _sync_time_score(c) < 999]
    if not candidates:
        return None
    return min(candidates, key=lambda c: (_sync_time_score(c), len(str(c))))


def sync_time_candidates(frame: Any) -> list[str]:
    ranked = [(c, _sync_time_score(c)) for c in numeric_columns(frame)]
    return [c for c, score in sorted(ranked, key=lambda p: p[1]) if score < 999]


def is_angular(*names: str) -> bool:
    """True when a column name looks like an angle (roll/pitch/yaw/heading/...)."""
    return any(token in str(n).lower() for n in names for token in _ANGLE_TOKENS)


def _decimate(values: Any, max_points: int) -> Any:
    if max_points <= 0 or len(values) <= max_points:
        return values
    step = int(math.ceil(len(values) / max_points))
    return values[::step]


def cmd_series(args: dict[str, Any]) -> dict[str, Any]:
    frame = load_source(args)
    requested = args.get("fields") or numeric_columns(frame)[:6]
    max_points = int(args.get("maxPoints", 20000))

    missing = [f for f in requested if f not in frame.columns]
    if missing:
        raise BridgeError(f"Columns not found: {', '.join(missing)}")

    out: dict[str, list] = {}
    total = len(frame)
    for field in requested:
        col = frame[field].to_numpy(dtype=float, na_value=float("nan"))
        thinned = _decimate(col, max_points)
        out[field] = [None if not math.isfinite(v) else float(v) for v in thinned]

    stats = {}
    for field in requested:
        col = frame[field].to_numpy(dtype=float, na_value=float("nan"))
        finite = col[np.isfinite(col)]
        if finite.size:
            stats[field] = {
                "count": int(finite.size),
                "mean": float(finite.mean()),
                "std": float(finite.std()),
                "min": float(finite.min()),
                "max": float(finite.max()),
                "p50": float(np.percentile(finite, 50)),
            }

    return {
        "rows": total,
        "returned": len(next(iter(out.values()))) if out else 0,
        "decimated": bool(out and len(next(iter(out.values()))) < total),
        "series": out,
        "stats": stats,
    }



def cmd_export(args: dict[str, Any]) -> dict[str, Any]:
    """Write a source's full decoded data straight to a CSV file on disk —
    used for both `.bag` topics and CSV/TUM sources. Writing directly avoids
    piping a potentially large table through the JSON RPC channel."""
    target = Path(args["target"]).expanduser()
    frame = load_source(args["source"])
    frame.to_csv(target, index=False)
    return {"path": str(target), "rows": int(len(frame)), "columns": [str(c) for c in frame.columns]}


# ── TUM export ─────────────────────────────────────────────────────────────
# Every evo invocation below runs on files written here. There is exactly one
# place that decides what "the timestamp" and "the pose" are for a source —
# get this right once and evo does the rest correctly by construction.

def _safe_filename(name: str) -> str:
    return re.sub(r"[^a-zA-Z0-9._-]+", "_", str(name)).strip("_") or "trajectory"


def _resolve_quat_columns(frame: Any, yaw_col: str | None) -> list[str] | None:
    """
    Find the qx,qy,qz,qw columns that go with a resolved yaw column, so a
    full pose (not just position) can be written to TUM. Returns None when
    no quaternion is available on this source.
    """
    if yaw_col and yaw_col.endswith(".yaw"):
        prefix = yaw_col[: -len(".yaw")]
        candidates = [f"{prefix}.{a}" for a in ("x", "y", "z", "w")]
        if all(c in frame.columns for c in candidates):
            return candidates
    tum_candidates = ["qx", "qy", "qz", "qw"]
    if all(c in frame.columns for c in tum_candidates):
        return tum_candidates
    return None


def _resolve_pose_columns(frame: Any, *, require_quat: bool = True) -> dict[str, Any]:
    """
    Locate the absolute-time, X/Y/Z and quaternion columns that make a frame
    usable as a full 6-DoF pose — the same lookup TUM export and the derived-
    topic transform both need, kept in one place so "what counts as a pose on
    this source" can't drift between the two.
    """
    time_col = pick_sync_time_column(frame)
    if time_col is None:
        raise BridgeError(
            "No absolute timestamp column found on this source.",
            "This needs an absolute clock (a ROS header stamp, or an already-TUM `timestamp`).",
        )

    axes = suggest_axes(numeric_columns(frame))
    x_col, y_col, z_col, yaw_col = axes.get("x"), axes.get("y"), axes.get("z"), axes.get("yaw")
    if not (x_col and y_col):
        raise BridgeError(
            "Couldn't find X/Y position columns on this source.",
            "This source doesn't look like a trajectory.",
        )
    quat_cols = _resolve_quat_columns(frame, yaw_col)
    if require_quat and quat_cols is None:
        raise BridgeError(
            "No quaternion (orientation) found on this source.",
            "This needs qx,qy,qz,qw — a position-only source can't be used as a full pose.",
        )
    return {"time": time_col, "x": x_col, "y": y_col, "z": z_col, "quat": quat_cols}


def _export_source_to_tum(source: dict[str, Any], target: Path) -> dict[str, Any]:
    """
    Write a source as a standard TUM trajectory file: one
    `timestamp tx ty tz qx qy qz qw` pose per line, no header — directly
    usable with `evo_ape tum ...` / `evo_rpe tum ...`.

    The timestamp is an absolute clock (`header.stamp_s` = sec + nanosec *
    1e-9, or the source's own `timestamp` column if it's already TUM) —
    never `_time_s` (relative to this source's own start), a row number, or
    a bare nanosecond count with no seconds part.
    """
    frame = load_source(source)
    pose = _resolve_pose_columns(frame)
    time_col, x_col, y_col, z_col, quat_cols = pose["time"], pose["x"], pose["y"], pose["z"], pose["quat"]

    t = frame[time_col].to_numpy(dtype=float)
    x = frame[x_col].to_numpy(dtype=float)
    y = frame[y_col].to_numpy(dtype=float)
    z = frame[z_col].to_numpy(dtype=float) if z_col else np.zeros(len(frame))
    quat = frame[quat_cols].to_numpy(dtype=float)

    order = np.argsort(t, kind="stable")
    finite = np.isfinite(t[order]) & np.isfinite(x[order]) & np.isfinite(y[order]) & np.isfinite(z[order])
    order = order[finite]

    with open(target, "w") as fh:
        for i in order:
            qx, qy, qz, qw = quat[i]
            fh.write(f"{t[i]:.9f} {x[i]:.9f} {y[i]:.9f} {z[i]:.9f} {qx:.9f} {qy:.9f} {qz:.9f} {qw:.9f}\n")

    return {
        "path": str(target),
        "rows": int(len(order)),
        "timeColumn": time_col,
        "columns": {"x": x_col, "y": y_col, "z": z_col, "quat": quat_cols},
    }


def cmd_export_tum(args: dict[str, Any]) -> dict[str, Any]:
    return _export_source_to_tum(args["source"], Path(args["target"]).expanduser())


# ── Running the real evo CLI ─────────────────────────────────────────────────
# Nothing below computes APE, RPE, synchronization, or a rotation error.
# `evo_ape`/`evo_rpe`/`evo_traj` do that; this only builds their argv, runs
# them as a real subprocess, and reads back what THEY wrote.

def _find_evo_executable(name: str) -> str:
    """
    evo's console scripts (evo_ape, evo_rpe, evo_traj, ...) install next to
    whichever Python interpreter `pip install evo` ran under — the same
    interpreter this bridge is already running on (`sys.executable`), so
    check there first before falling back to PATH.
    """
    candidate = Path(sys.executable).parent / name
    if os.name == "nt":
        candidate = candidate.with_suffix(".exe")
    if candidate.exists():
        return str(candidate)
    found = shutil.which(name)
    if found:
        return found
    raise BridgeError(
        f"Could not find the `{name}` executable.",
        "Install evo in this interpreter with `pip install evo`, or check rosbagAnalyzer.pythonPath.",
    )


def _evo_version() -> str:
    try:
        from importlib.metadata import version
        return version("evo")
    except Exception:
        return "unknown"


def _alignment_flags(alignment: str) -> list[str]:
    """None/SE3/Sim3/Origin -> evo's actual `-a`/`-s`/`--align_origin` flags.
    SE3 and Sim3 are mutually exclusive with Origin in evo's own CLI."""
    if alignment == "se3":
        return ["-a"]
    if alignment == "sim3":
        return ["-a", "-s"]
    if alignment == "origin":
        return ["--align_origin"]
    return []


def _format_command(argv: list[str]) -> str:
    return " ".join(shlex.quote(part) for part in argv)


def _parse_custom_evo_args(raw: Any) -> list[str] | None:
    """
    Tokenize a user-typed custom argument string the way a shell would
    (quoting, escaping) WITHOUT ever invoking a shell — the tokens go
    straight into subprocess.run's argv list, so there's no injection risk
    regardless of what's typed. Returns None when no custom args were given,
    so callers can tell "use the GUI-built flags" from "use exactly these".
    """
    text = str(raw or "").strip()
    if not text:
        return None
    try:
        tokens = shlex.split(text)
    except ValueError as exc:
        raise BridgeError(f"Could not parse custom evo arguments: {exc}", "Check for unmatched quotes.")

    # --save_results is how results get parsed back (a known path evo itself
    # writes to) — strip any the user typed rather than silently conflicting
    # with our own, which is always appended by the caller.
    cleaned: list[str] = []
    skip_next = False
    for tok in tokens:
        if skip_next:
            skip_next = False
            continue
        if tok == "--save_results":
            skip_next = True
            continue
        if tok.startswith("--save_results="):
            continue
        cleaned.append(tok)
    return cleaned


def _build_evo_argv(
    evo_command: str, exe: str, ref_tum: str, est_tum: str, args: dict[str, Any], results_zip: str,
) -> list[str]:
    argv = [exe, "tum", ref_tum, est_tum]
    custom = _parse_custom_evo_args(args.get("customArgs"))
    if custom is not None:
        argv += custom
    else:
        argv += ["-r", args.get("poseRelation", "trans_part")]
        argv += _alignment_flags(args.get("alignment", "none"))
        if evo_command == "rpe":
            argv += ["-d", str(args.get("delta", 1.0)), "-u", args.get("deltaUnit", "f")]
            if args.get("allPairs"):
                argv.append("--all_pairs")
            if args.get("pairsFromReference"):
                argv.append("--pairs_from_reference")
        if args.get("tMaxDiff"):
            argv += ["--t_max_diff", str(args["tMaxDiff"])]
        if args.get("tOffset"):
            argv += ["--t_offset", str(args["tOffset"])]
    argv += ["--save_results", results_zip, "--no_warnings"]
    return argv


def _read_evo_results_zip(path: Path) -> dict[str, Any]:
    """Read back exactly what `--save_results` wrote — evo's own stats.json
    (the numbers displayed) and its own per-pose error/time arrays (the
    numbers charted). Nothing here is recomputed."""
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        stats = json.loads(z.read("stats.json")) if "stats.json" in names else {}
        info = json.loads(z.read("info.json")) if "info.json" in names else {}
        error_array = (
            np.load(io.BytesIO(z.read("error_array.npy"))) if "error_array.npy" in names else np.array([])
        )
        if "seconds_from_start.npy" in names:
            time_array = np.load(io.BytesIO(z.read("seconds_from_start.npy")))
        elif "timestamps.npy" in names:
            time_array = np.load(io.BytesIO(z.read("timestamps.npy")))
        else:
            time_array = np.arange(len(error_array), dtype=float)
    return {"stats": stats, "info": info, "errorArray": error_array, "timeArray": time_array, "n": int(len(error_array))}


def _run_evo_traj(args: dict[str, Any], workdir: Path) -> dict[str, Any]:
    sources = args.get("sources") or []
    if not sources:
        raise BridgeError("Select at least one trajectory to analyse.")
    tum_paths = []
    for i, source in enumerate(sources):
        p = workdir / f"traj_{i}.tum"
        _export_source_to_tum(source, p)
        tum_paths.append(str(p))
    exe = _find_evo_executable("evo_traj")
    custom = _parse_custom_evo_args(args.get("customArgs"))
    argv = [exe, "tum", *tum_paths, *(custom if custom is not None else ["--full_check"]), "--no_warnings"]
    proc = subprocess.run(argv, capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        raise BridgeError("evo_traj failed.", (proc.stderr or proc.stdout).strip()[:2000] or "No output.")
    return {
        "evoCommand": "traj",
        "commandArgv": argv,
        "commandText": _format_command(argv),
        "stdout": proc.stdout,
        "stderr": proc.stderr,
        "evoVersion": _evo_version(),
    }


def cmd_run_evo(args: dict[str, Any]) -> dict[str, Any]:
    """
    Prepare TUM inputs and invoke the real evo_ape / evo_rpe / evo_traj
    executable. Evo computes every reported number; this only builds the
    command, runs it, and parses evo's own result file — there is no
    independent APE/RPE/synchronization/rotation-error logic in this file.
    """
    evo_command = args.get("evoCommand", "ape")
    if evo_command not in ("ape", "rpe", "traj"):
        raise BridgeError(f"Unknown evo command: {evo_command!r}")

    workdir = Path(tempfile.mkdtemp(prefix="rosbag-analyzer-evo-"))
    try:
        if evo_command == "traj":
            return _run_evo_traj(args, workdir)

        ref_tum = workdir / "reference.tum"
        est_tum = workdir / "estimate.tum"
        _export_source_to_tum(args["gt"], ref_tum)
        _export_source_to_tum(args["est"], est_tum)

        exe = _find_evo_executable(f"evo_{evo_command}")
        results_zip = workdir / "results.zip"
        argv = _build_evo_argv(evo_command, exe, str(ref_tum), str(est_tum), args, str(results_zip))
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=120)
        if proc.returncode != 0:
            raise BridgeError(
                f"evo_{evo_command} failed.", (proc.stderr or proc.stdout).strip()[:2000] or "No output.",
            )

        parsed = _read_evo_results_zip(results_zip)
        max_points = int(args.get("maxPoints", 3000))
        return {
            "evoCommand": evo_command,
            "commandArgv": argv,
            "commandText": _format_command(argv),
            "stdout": proc.stdout,
            "stderr": proc.stderr,
            "stats": parsed["stats"],
            "n": parsed["n"],
            "info": parsed["info"],
            "errorArray": [float(v) for v in _decimate(parsed["errorArray"], max_points)],
            "timeArray": [float(v) for v in _decimate(parsed["timeArray"], max_points)],
            "evoVersion": _evo_version(),
        }
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def cmd_export_evaluation(args: dict[str, Any]) -> dict[str, Any]:
    """
    Write a fully self-contained, reproducible evaluation package: the exact
    TUM inputs, the exact command executed, evo's raw stdout/stderr, its
    parsed results, and metadata — enough to redo the whole evaluation from
    a terminal with no VS Code involved.
    """
    evo_command = args.get("evoCommand", "ape")
    if evo_command not in ("ape", "rpe"):
        raise BridgeError("Only APE and RPE evaluations can be exported as a package.")

    target_dir = Path(args["target"]).expanduser()
    target_dir.mkdir(parents=True, exist_ok=True)

    ref_name = _safe_filename(args.get("refLabel") or "reference")
    est_name = _safe_filename(args.get("estLabel") or "estimate")
    ref_tum = target_dir / f"{ref_name}.tum"
    est_tum = target_dir / f"{est_name}.tum"
    _export_source_to_tum(args["gt"], ref_tum)
    _export_source_to_tum(args["est"], est_tum)

    exe = _find_evo_executable(f"evo_{evo_command}")
    results_zip = target_dir / "results.zip"
    argv = _build_evo_argv(evo_command, exe, str(ref_tum), str(est_tum), args, str(results_zip))
    proc = subprocess.run(argv, capture_output=True, text=True, timeout=120)

    (target_dir / "command.txt").write_text(_format_command(argv) + "\n")
    output_text = proc.stdout + (f"\n--- stderr ---\n{proc.stderr}" if proc.stderr else "")
    (target_dir / "evo_output.txt").write_text(output_text)

    if proc.returncode != 0:
        raise BridgeError(
            f"evo_{evo_command} failed — see evo_output.txt in {target_dir}.",
            (proc.stderr or proc.stdout).strip()[:2000] or "No output.",
        )

    parsed = _read_evo_results_zip(results_zip)
    (target_dir / "results.json").write_text(
        json.dumps({"stats": parsed["stats"], "n": parsed["n"], "info": parsed["info"]}, indent=2),
    )
    (target_dir / "metadata.json").write_text(json.dumps({
        "evoVersion": _evo_version(),
        "evoCommand": f"evo_{evo_command}",
        "command": argv,
        "reference": ref_tum.name,
        "estimate": est_tum.name,
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
    }, indent=2))

    return {"path": str(target_dir), "stats": parsed["stats"], "n": parsed["n"]}


# ── Derived topics (frame-transform a topic into a new one) ─────────────────
# A derived topic re-expresses an existing pose topic in a different frame —
# either a manually entered constant transform, or one looked up from this
# bag's own /tf + /tf_static data — and registers the result as a new topic
# on the same bag, for the rest of this session only. Nothing here ever
# writes to the original bag file.

def _load_tf_records(kind: str, path: Path) -> list[dict[str, Any]]:
    """
    Parse every /tf and /tf_static message into flat records, one per
    transform. Deliberately not routed through load_topic/flatten_msg: those
    only ever expose the *first* element of a message array, but a single
    /tf message commonly carries several distinct parent/child pairs.
    """
    _require_rosbags()
    key = ("tf", kind, str(path), _stamp(path))
    hit = cache_get(key)
    if hit is not None:
        return hit

    records: list[dict[str, Any]] = []
    with open_reader(kind, path) as reader:
        store = build_typestore(kind, reader)
        conns = [c for c in reader.connections if c.topic in ("/tf", "/tf_static")]
        if conns:
            for conn, timestamp, raw in reader.messages(connections=conns):
                try:
                    msg = (
                        store.deserialize_cdr(raw, conn.msgtype)
                        if kind == "ros2"
                        else store.deserialize_ros1(raw, conn.msgtype)
                    )
                except Exception:
                    continue
                for tf in getattr(msg, "transforms", []):
                    try:
                        translation = tf.transform.translation
                        rotation = tf.transform.rotation
                        records.append({
                            "t_ns": int(timestamp),
                            "static": conn.topic == "/tf_static",
                            "parent": str(tf.header.frame_id),
                            "child": str(tf.child_frame_id),
                            "t": (float(translation.x), float(translation.y), float(translation.z)),
                            "q": (float(rotation.x), float(rotation.y), float(rotation.z), float(rotation.w)),
                        })
                    except Exception:
                        continue

    cache_put(key, records)
    return records


def cmd_list_frames(args: dict[str, Any]) -> dict[str, Any]:
    """Frame names and known parent/child edges from this bag's TF data, so
    the UI can offer a picker instead of the user having to already know the
    frame names by heart."""
    kind, resolved = classify(args["path"])
    if kind == "csv":
        return {"frames": [], "edges": []}

    frames: set[str] = set()
    edges: dict[tuple[str, str], dict[str, Any]] = {}
    for rec in _load_tf_records(kind, resolved):
        frames.add(rec["parent"])
        frames.add(rec["child"])
        edge_key = (rec["parent"], rec["child"])
        info = edges.setdefault(
            edge_key, {"parent": rec["parent"], "child": rec["child"], "static": False, "count": 0},
        )
        info["count"] += 1
        info["static"] = info["static"] or rec["static"]

    return {"frames": sorted(frames), "edges": [edges[k] for k in sorted(edges)]}


def _find_tf_edge(records: list[dict[str, Any]], parent: str, child: str) -> tuple[list[dict[str, Any]], bool]:
    """
    A direct edge only — no multi-hop traversal through an intermediate
    frame. If only the reverse direction was ever published, the records are
    inverted so the caller always gets parent->child regardless of which way
    the bag happened to publish it.
    """
    forward = [r for r in records if r["parent"] == parent and r["child"] == child]
    if forward:
        return forward, forward[0]["static"]

    reverse = [r for r in records if r["parent"] == child and r["child"] == parent]
    if reverse:
        inverted = []
        for r in reverse:
            t_inv, q_inv = _invert_transform(np.array(r["t"]), np.array(r["q"]))
            inverted.append({**r, "parent": parent, "child": child, "t": tuple(t_inv), "q": tuple(q_inv)})
        return inverted, inverted[0]["static"]

    raise BridgeError(
        f'No direct transform found between "{parent}" and "{child}".',
        "Only a directly-published /tf or /tf_static edge is supported, not a multi-hop chain through "
        "an intermediate frame. Run \"list_frames\" to see what's actually in this bag.",
    )


def _resolve_reference(
    args: dict[str, Any], kind: str, path: Path, row_times_ns: Any,
) -> tuple[Any, Any]:
    """
    The reference transform (t_ref, q_ref) for create_derived_topic. A manual
    or static-TF reference is a single (3,)/(4,) transform (numpy broadcasts
    it against every row); a dynamic TF edge returns one transform per row,
    the nearest-in-time sample for that row's own bag-recording timestamp.
    """
    reference = args.get("reference") or {}
    ref_type = reference.get("type")

    if ref_type == "manual":
        try:
            t_ref = np.array([float(reference["tx"]), float(reference["ty"]), float(reference["tz"])])
            q_ref = np.array(
                [float(reference["qx"]), float(reference["qy"]), float(reference["qz"]), float(reference["qw"])],
            )
        except (KeyError, TypeError, ValueError):
            raise BridgeError("A manual reference needs tx, ty, tz, qx, qy, qz, qw.")
        return t_ref, q_ref

    if ref_type == "tf":
        parent, child = reference.get("parent"), reference.get("child")
        if not parent or not child:
            raise BridgeError("A TF reference needs both a parent and a child frame.")
        if kind == "csv":
            raise BridgeError("TF references need a bag source — a CSV/TUM source has no /tf data.")
        records, static = _find_tf_edge(_load_tf_records(kind, path), parent, child)
        if static:
            r = records[-1]
            return np.array(r["t"]), np.array(r["q"])

        times = np.array([r["t_ns"] for r in records], dtype=float)
        order = np.argsort(times, kind="stable")
        times = times[order]
        t_arr = np.array([records[i]["t"] for i in order], dtype=float)
        q_arr = np.array([records[i]["q"] for i in order], dtype=float)

        idx = np.clip(np.searchsorted(times, row_times_ns), 0, len(times) - 1)
        left = np.clip(idx - 1, 0, len(times) - 1)
        use_left = np.abs(times[left] - row_times_ns) <= np.abs(times[idx] - row_times_ns)
        nearest = np.where(use_left, left, idx)
        return t_arr[nearest], q_arr[nearest]

    raise BridgeError(f"Unknown reference type: {ref_type!r}", "Expected 'manual' or 'tf'.")


def cmd_create_derived_topic(args: dict[str, Any]) -> dict[str, Any]:
    """
    Re-express an existing pose topic in a different frame and register the
    result as a new topic on the same bag. Session-only: kept in
    `_derived_topics`, never written to disk — reopening the bag later starts
    fresh without it.
    """
    kind, resolved = classify(args["path"])
    if kind == "csv":
        raise BridgeError(
            "Derived topics need a bag source.",
            "This transforms an existing bag topic into a new topic on the same bag.",
        )
    source_topic = args.get("topic")
    if not source_topic:
        raise BridgeError("Missing the source topic to transform.")

    name = str(args.get("name") or "").strip()
    if not name:
        raise BridgeError("Give the new topic a name.")
    if not name.startswith("/"):
        name = "/" + name
    existing = {t["topic"] for t in cmd_inspect({"path": args["path"]})["topics"]}
    if name in existing:
        raise BridgeError(f"Topic {name} already exists on this bag.", "Pick a different name.")

    frame = load_topic(kind, resolved, source_topic)
    pose = _resolve_pose_columns(frame)
    time_col, x_col, y_col, z_col, quat_cols = pose["time"], pose["x"], pose["y"], pose["z"], pose["quat"]

    # Real bag topics carry `_stamp_ns` (the bag-recording clock); a
    # previously-derived topic carries `_derived_align_ns` instead — see the
    # comment below on why that has to be a different, TIME_RANK-invisible
    # name rather than reusing `_stamp_ns` itself.
    align_col = next((c for c in ("_stamp_ns", "_derived_align_ns") if c in frame.columns), None)
    if align_col is None:
        raise BridgeError("This topic has no bag-recording timestamp to align against TF.")

    t_abs = frame[time_col].to_numpy(dtype=float)
    x = frame[x_col].to_numpy(dtype=float)
    y = frame[y_col].to_numpy(dtype=float)
    z = frame[z_col].to_numpy(dtype=float) if z_col else np.zeros(len(frame))
    t_orig = np.stack([x, y, z], axis=-1)
    q_orig = frame[quat_cols].to_numpy(dtype=float)
    row_times_ns = frame[align_col].to_numpy(dtype=float)

    t_ref, q_ref = _resolve_reference(args, kind, resolved, row_times_ns)
    if bool(args.get("invert")):
        t_ref, q_ref = _invert_transform(t_ref, q_ref)

    new_t, new_q = _compose_transform(t_ref, q_ref, t_orig, q_orig)

    # Mirrors load_tum()'s own column schema exactly, so a derived topic is
    # indistinguishable from a loaded TUM trajectory to every downstream
    # consumer (Signals, Trajectory, Accuracy, TUM export, evo).
    new_frame = pd.DataFrame({
        "timestamp": t_abs,
        "pos_x": new_t[:, 0],
        "pos_y": new_t[:, 1],
        "pos_z": new_t[:, 2],
        "qx": new_q[:, 0],
        "qy": new_q[:, 1],
        "qz": new_q[:, 2],
        "qw": new_q[:, 3],
    })
    new_frame["_time_s"] = new_frame["timestamp"] - new_frame["timestamp"].iloc[0]
    roll, pitch, yaw = quat_to_euler_vec(
        new_frame["qx"].to_numpy(), new_frame["qy"].to_numpy(), new_frame["qz"].to_numpy(), new_frame["qw"].to_numpy(),
    )
    new_frame["roll"], new_frame["pitch"], new_frame["yaw"] = roll, pitch, yaw
    # So a derived topic can itself be the base of a further TF-based
    # derivation (e.g. inverting a chained transform) without this being the
    # one kind of topic that can't be TF-aligned against. Deliberately NOT
    # named `_stamp_ns`: that name is in TIME_RANK and ranks *above*
    # `timestamp`, so on a frame with no `header.stamp_s` to outrank it (true
    # of every derived topic), pick_sync_time_column would pick this
    # nanosecond-scale column as the TUM export clock instead of the correct
    # `timestamp` — writing garbage values that share no overlap with any
    # other trajectory's real timestamps and made evo_ape fail with "found no
    # matching timestamps" on every derived-topic comparison.
    new_frame["_derived_align_ns"] = np.round(t_abs * 1e9)

    _derived_topics.setdefault(str(resolved), {})[name] = new_frame
    log(f"[bridge] derived topic {name} from {source_topic}: {len(new_frame)} rows")
    return {"path": str(resolved), "topic": name, "rows": int(len(new_frame)), "sourceTopic": source_topic}


def cmd_clear(_args: dict[str, Any]) -> dict[str, Any]:
    count = len(_cache)
    _cache.clear()
    _derived_topics.clear()
    return {"cleared": count}


HANDLERS = {
    "probe": cmd_probe,
    "inspect": cmd_inspect,
    "fields": cmd_fields,
    "series": cmd_series,
    "export": cmd_export,
    "export_tum": cmd_export_tum,
    "run_evo": cmd_run_evo,
    "export_evaluation": cmd_export_evaluation,
    "list_frames": cmd_list_frames,
    "create_derived_topic": cmd_create_derived_topic,
    "clear": cmd_clear,
}


def main() -> int:
    log(f"[bridge] ready — python {sys.version.split()[0]}, rosbags={'yes' if ROSBAGS_OK else 'no'}")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id: Any = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            handler = HANDLERS.get(request.get("cmd", ""))
            if handler is None:
                raise BridgeError(f"Unknown command: {request.get('cmd')!r}")
            result = handler(request.get("args") or {})
            payload = {"id": request_id, "ok": True, "result": result}
        except BridgeError as exc:
            payload = {"id": request_id, "ok": False, "error": str(exc), "hint": exc.hint}
        except Exception as exc:
            log("[bridge] " + traceback.format_exc())
            payload = {"id": request_id, "ok": False, "error": f"{type(exc).__name__}: {exc}", "hint": ""}

        sys.stdout.write(json.dumps(payload, allow_nan=False) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)

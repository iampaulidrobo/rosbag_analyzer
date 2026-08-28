"""Generate ROS1 + ROS2 test bags with a ground-truth and a drifting estimate."""
import math, shutil
from pathlib import Path
import numpy as np
from rosbags.rosbag1 import Writer as W1
from rosbags.rosbag2 import Writer as W2
from rosbags.typesys import Stores, get_typestore, get_types_from_msg

OUT = Path(__file__).parent / "fixtures"
shutil.rmtree(OUT, ignore_errors=True)
OUT.mkdir(parents=True)

ts1 = get_typestore(Stores.ROS1_NOETIC)
ts2 = get_typestore(Stores.ROS2_HUMBLE)

# tf2_msgs isn't bundled in rosbags' typestores (real bags carry its msgdef in
# their own connection headers, which build_typestore() registers on the fly)
# — register it here the same way for these fixtures.
_TF_MESSAGE_DEF = "geometry_msgs/TransformStamped[] transforms"
ts1.register(get_types_from_msg(_TF_MESSAGE_DEF, 'tf2_msgs/msg/TFMessage'))
ts2.register(get_types_from_msg(_TF_MESSAGE_DEF, 'tf2_msgs/msg/TFMessage'))


def make_odom(ts, t, x, y, z, yaw, vx):
    Odometry = ts.types['nav_msgs/msg/Odometry']
    Header = ts.types['std_msgs/msg/Header']
    Time = ts.types['builtin_interfaces/msg/Time']
    Pose = ts.types['geometry_msgs/msg/Pose']
    PoseWC = ts.types['geometry_msgs/msg/PoseWithCovariance']
    Twist = ts.types['geometry_msgs/msg/Twist']
    TwistWC = ts.types['geometry_msgs/msg/TwistWithCovariance']
    Point = ts.types['geometry_msgs/msg/Point']
    Quat = ts.types['geometry_msgs/msg/Quaternion']
    Vec3 = ts.types['geometry_msgs/msg/Vector3']

    q = Quat(x=0.0, y=0.0, z=math.sin(yaw / 2), w=math.cos(yaw / 2))
    pose = Pose(position=Point(x=x, y=y, z=z), orientation=q)
    stamp = Time(sec=int(t), nanosec=int((t % 1) * 1e9))
    try:
        hdr = Header(stamp=stamp, frame_id='odom')
    except TypeError:
        hdr = Header(seq=0, stamp=stamp, frame_id='odom')
    return Odometry(
        header=hdr,
        child_frame_id='base_link',
        pose=PoseWC(pose=pose, covariance=np.zeros(36, dtype=np.float64)),
        twist=TwistWC(twist=Twist(linear=Vec3(x=vx, y=0.0, z=0.0), angular=Vec3(x=0.0, y=0.0, z=0.1)),
                      covariance=np.zeros(36, dtype=np.float64)),
    )


N_GT, N_EST = 400, 250   # deliberately different rates
rng = np.random.default_rng(7)


def gt_state(t):
    return (10 * math.cos(0.2 * t), 10 * math.sin(0.2 * t), 0.05 * t, 0.2 * t + math.pi / 2, 2.0)


def make_tf_message(ts, transforms):
    """transforms: list of (t, parent, child, tx, ty, tz, qx, qy, qz, qw)."""
    TFMessage = ts.types['tf2_msgs/msg/TFMessage']
    TransformStamped = ts.types['geometry_msgs/msg/TransformStamped']
    Transform = ts.types['geometry_msgs/msg/Transform']
    Header = ts.types['std_msgs/msg/Header']
    Time = ts.types['builtin_interfaces/msg/Time']
    Vec3 = ts.types['geometry_msgs/msg/Vector3']
    Quat = ts.types['geometry_msgs/msg/Quaternion']

    entries = []
    for t, parent, child, tx, ty, tz, qx, qy, qz, qw in transforms:
        stamp = Time(sec=int(t), nanosec=int((t % 1) * 1e9))
        try:
            hdr = Header(stamp=stamp, frame_id=parent)
        except TypeError:
            hdr = Header(seq=0, stamp=stamp, frame_id=parent)
        entries.append(TransformStamped(
            header=hdr, child_frame_id=child,
            transform=Transform(translation=Vec3(x=tx, y=ty, z=tz), rotation=Quat(x=qx, y=qy, z=qz, w=qw)),
        ))
    return TFMessage(transforms=entries)


# A constant map->odom offset (translation + a fixed yaw) that
# create_derived_topic's "tf" reference is checked against, plus a slowly
# drifting odom->sensor_frame edge to exercise the dynamic, nearest-in-time
# lookup path.
MAP_ODOM_YAW = 0.3
MAP_ODOM_T = (5.0, 3.0, 0.0)
MAP_ODOM_Q = (0.0, 0.0, math.sin(MAP_ODOM_YAW / 2), math.cos(MAP_ODOM_YAW / 2))

# ── ROS1 ──
with W1(OUT / 'test.bag') as w:
    c_gt = w.add_connection('/ground_truth/odom', 'nav_msgs/msg/Odometry', typestore=ts1)
    c_est = w.add_connection('/ekf/odom', 'nav_msgs/msg/Odometry', typestore=ts1)
    c_tf_static = w.add_connection('/tf_static', 'tf2_msgs/msg/TFMessage', typestore=ts1)
    c_tf = w.add_connection('/tf', 'tf2_msgs/msg/TFMessage', typestore=ts1)
    for i in range(N_GT):
        t = i * 0.05
        x, y, z, yaw, vx = gt_state(t)
        w.write(c_gt, int(t * 1e9), ts1.serialize_ros1(make_odom(ts1, t, x, y, z, yaw, vx), c_gt.msgtype))
    for i in range(N_EST):
        t = i * 0.08
        x, y, z, yaw, vx = gt_state(t)
        drift = 0.02 * t
        w.write(c_est, int(t * 1e9), ts1.serialize_ros1(
            make_odom(ts1, t, x + drift + rng.normal(0, 0.05), y - drift * 0.5 + rng.normal(0, 0.05),
                      z + rng.normal(0, 0.02), yaw + 0.01 * t, vx + rng.normal(0, 0.1)), c_est.msgtype))
    w.write(c_tf_static, 0, ts1.serialize_ros1(
        make_tf_message(ts1, [(0.0, 'map', 'odom', *MAP_ODOM_T, *MAP_ODOM_Q)]), c_tf_static.msgtype))
    for i in range(50):
        t = i * 0.4
        drift_yaw = 0.05 * t
        qz, qw = math.sin(drift_yaw / 2), math.cos(drift_yaw / 2)
        w.write(c_tf, int(t * 1e9), ts1.serialize_ros1(
            make_tf_message(ts1, [(t, 'odom', 'sensor_frame', 0.1, 0.0, 0.2, 0.0, 0.0, qz, qw)]), c_tf.msgtype))

# ── ROS2 ──
with W2(OUT / 'test_ros2', version=8) as w:
    c_gt = w.add_connection('/ground_truth/odom', 'nav_msgs/msg/Odometry', typestore=ts2)
    for i in range(N_GT):
        t = i * 0.05
        x, y, z, yaw, vx = gt_state(t)
        w.write(c_gt, int(t * 1e9), ts2.serialize_cdr(make_odom(ts2, t, x, y, z, yaw, vx), c_gt.msgtype))

# ── CSV ──
rows = ['t,pos_x,pos_y,pos_z']
for i in range(N_GT):
    t = i * 0.05
    x, y, z, _, _ = gt_state(t)
    rows.append(f'{t:.3f},{x:.6f},{y:.6f},{z:.6f}')
(OUT / 'gt.csv').write_text('\n'.join(rows))

# ── TUM trajectory ── `timestamp tx ty tz qx qy qz qw`, no header — same
# shape evo/ORB-SLAM write.
lines = []
for i in range(N_GT):
    t = i * 0.05
    x, y, z, yaw, _ = gt_state(t)
    qz, qw = math.sin(yaw / 2), math.cos(yaw / 2)
    lines.append(f'{t:.6f} {x:.6f} {y:.6f} {z:.6f} 0.000000 0.000000 {qz:.6f} {qw:.6f}')
(OUT / 'gt.tum').write_text('\n'.join(lines) + '\n')

# ── Headerless numeric CSV ── a file with no header row at all: pandas would
# otherwise read the first data row as column names and silently drop it.
(OUT / 'headerless.csv').write_text('1.0,2.0,3.0\n4.0,5.0,6.0\n7.0,8.0,9.0\n')

# ── Staggered TUM pair ── reproduces the actual bug report: two sources
# recorded on the SAME absolute clock, but the estimate starts publishing a
# fraction of a second later (e.g. an EKF warm-up delay) and runs at a
# different rate/length. A time column that resets to zero at each source's
# own first message (like the plotting-only `_time_s`) would silently offset
# every match by that startup delay; an absolute epoch timestamp must not.
EPOCH = 1751789285.0
N_STAG_GT, N_STAG_EST = 400, 250
START_OFFSET = 0.37
stagger_rng = np.random.default_rng(11)

lines_gt, lines_est = [], []
for i in range(N_STAG_GT):
    t = EPOCH + i * 0.05
    x, y, z, yaw, _ = gt_state(i * 0.05)
    qz, qw = math.sin(yaw / 2), math.cos(yaw / 2)
    lines_gt.append(f'{t:.6f} {x:.6f} {y:.6f} {z:.6f} 0.0 0.0 {qz:.6f} {qw:.6f}')
for i in range(N_STAG_EST):
    t_sim = i * 0.08
    t = EPOCH + START_OFFSET + t_sim + stagger_rng.uniform(-0.002, 0.002)
    x, y, z, yaw, _ = gt_state(t_sim)
    drift = 0.02 * t_sim
    x += drift + stagger_rng.normal(0, 0.02)
    y -= drift * 0.5 + stagger_rng.normal(0, 0.02)
    z += stagger_rng.normal(0, 0.01)
    yaw += 0.01 * t_sim + stagger_rng.normal(0, 0.01)
    qz, qw = math.sin(yaw / 2), math.cos(yaw / 2)
    lines_est.append(f'{t:.6f} {x:.6f} {y:.6f} {z:.6f} 0.0 0.0 {qz:.6f} {qw:.6f}')
(OUT / 'staggered_gt.tum').write_text('\n'.join(lines_gt) + '\n')
(OUT / 'staggered_est.tum').write_text('\n'.join(lines_est) + '\n')

print('made:', sorted(p.name for p in OUT.iterdir()))

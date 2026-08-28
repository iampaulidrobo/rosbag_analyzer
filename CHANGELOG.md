# Changelog

## 0.1.0

First release. Ported from a Streamlit app, with the analysis behaviour
corrected in the process.

### Added
- Custom editor: `.bag`, `.db3` and `.mcap` open as an analyzer panel.
- Four tabs: Contents, Signals, Trajectory, Accuracy.
- Commands for opening, comparing, listing topics, checking the Python
  environment, and restarting the bag reader.
- Explorer context menu on bag and table files.
- ROS 2 bag folders, `.mcap`, and mixed CSV/bag comparison.
- Quaternions yield derived roll/pitch/yaw columns automatically.
- Custom message types registered from definitions carried in the bag.
- Metrics export to CSV and Markdown.
- Long-lived Python sidecar with an LRU cache of decoded topics.

### Changed from the Streamlit version
- Ground truth and estimate are aligned by timestamp rather than by sample
  index. Index alignment silently inflated RMSE by ~20x whenever the two
  sources ran at different rates.
- Heading error is wrapped into ±π. Yaw crossing the seam previously reported
  a ~6.28 rad error.
- Full-resolution time columns are preferred over `header.stamp.sec`, which
  quantises timestamps to whole seconds.
- Linear and angular RMSE are reported separately instead of averaged together.
- ROS 2 input resolves to the bag folder rather than requiring a `.db3`.

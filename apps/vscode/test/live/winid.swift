// Prints the CGWindowIDs (largest first) of the normal-layer windows whose owner matches argv[1]
// (an app name like "Code", or a process id) and whose title contains argv[2] (optional), for
// `screencapture -l <id>`. Matching by pid keeps the run's editor apart from any other window of
// the same app that is open on the machine.
import CoreGraphics
import Foundation
let owner = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Code"
let title = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : ""
let pid = Int(owner)
let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
var found: [(Int, Double, String)] = []
for w in list {
  let o = w[kCGWindowOwnerName as String] as? String ?? ""
  let t = w[kCGWindowName as String] as? String ?? ""
  let layer = w[kCGWindowLayer as String] as? Int ?? -1
  let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
  let h = b["Height"] as? Double ?? 0
  let wd = b["Width"] as? Double ?? 0
  let p = w[kCGWindowOwnerPID as String] as? Int ?? -1
  let mine = pid != nil ? p == pid! : o == owner
  if mine && layer == 0 && h > 200 && (title.isEmpty || t.contains(title)) {
    found.append((w[kCGWindowNumber as String] as? Int ?? 0, h * wd, t))
  }
}
for f in found.sorted(by: { $0.1 > $1.1 }) { print(f.0, f.2) }

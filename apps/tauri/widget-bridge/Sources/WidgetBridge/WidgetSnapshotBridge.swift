import Foundation
import WidgetKit

#if os(macOS)
  import Security
#endif

// Writes the widgets' snapshot into the App Group folder the widget extension
// reads. Called from Rust (`apps/tauri/src/widget.rs`). The iOS app compiles
// this file in its Xcode target; the macOS app links it as a Swift package
// through swift-rs (`apps/tauri/build.rs`).
// Keep the group id and file name in step with WealthfolioWidget.swift.
#if os(macOS)
  // Developer ID apps on macOS use a team-prefixed group.
  private let appGroupIdentifier = "DYDJ2RNL5H.com.teymz.wealthfolio"
#else
  private let appGroupIdentifier = "group.com.teymz.wealthfolio"
#endif
/// One file per app id, so a development build never overwrites the
/// installed app's widgets. Each widget reads its own app's file.
private let snapshotFileName =
  "\(Bundle.main.bundleIdentifier ?? "com.teymz.wealthfolio").widget-snapshot.json"

#if os(macOS)
  /// Development builds aren't signed for the group. Touching its folder
  /// anyway makes macOS ask the user, so they skip the widgets instead.
  private let isSignedForGroup: Bool = {
    guard let task = SecTaskCreateFromSelf(nil),
      let groups = SecTaskCopyValueForEntitlement(
        task, "com.apple.security.application-groups" as CFString, nil) as? [String]
    else { return false }
    return groups.contains(appGroupIdentifier)
  }()
#else
  private let isSignedForGroup = true
#endif

private func snapshotURL() -> URL? {
  FileManager.default
    .containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier)?
    .appendingPathComponent(snapshotFileName)
}

/// Returns 0 on success, and when this build has no widgets to feed.
/// `public` keeps the symbol global in release builds.
@_cdecl("wf_widget_write_snapshot")
public func wfWidgetWriteSnapshot(_ json: UnsafePointer<CChar>?) -> Int32 {
  guard isSignedForGroup else { return 0 }
  guard let json, var url = snapshotURL() else { return 1 }
  let data = Data(bytes: json, count: strlen(json))
  do {
    #if os(iOS)
      // Readable once the phone has been unlocked after a restart, so the
      // lock-screen widget can draw; amounts there are still redacted while locked.
      try data.write(
        to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    #else
      try data.write(to: url, options: [.atomic])
    #endif
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try url.setResourceValues(values)
  } catch {
    return 1
  }
  WidgetCenter.shared.reloadAllTimelines()
  return 0
}

/// Returns 0 when the snapshot is gone, including when there was none.
@_cdecl("wf_widget_clear_snapshot")
public func wfWidgetClearSnapshot() -> Int32 {
  guard isSignedForGroup else { return 0 }
  guard let url = snapshotURL() else { return 1 }
  if FileManager.default.fileExists(atPath: url.path) {
    do {
      try FileManager.default.removeItem(at: url)
    } catch {
      return 1
    }
  }
  WidgetCenter.shared.reloadAllTimelines()
  return 0
}

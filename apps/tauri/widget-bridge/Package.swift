// swift-tools-version:5.9
// The widgets' snapshot bridge, linked into the macOS app by swift-rs
// (`apps/tauri/build.rs`). The iOS app compiles the same source file in its
// Xcode target instead.
import PackageDescription

let package = Package(
  name: "WidgetBridge",
  platforms: [.macOS(.v12)],
  products: [
    .library(name: "WidgetBridge", type: .static, targets: ["WidgetBridge"])
  ],
  targets: [
    .target(name: "WidgetBridge", path: "Sources/WidgetBridge")
  ]
)

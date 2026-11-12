// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "WealthfolioAppleIntelligence",
    // The app's own minimums. FoundationModels needs macOS 26, so every use of
    // it is behind an availability check and the framework links weakly.
    platforms: [.macOS(.v12), .iOS(.v15)],
    products: [
        .library(
            name: "WealthfolioAppleIntelligence",
            type: .static,
            targets: ["WealthfolioAppleIntelligence"])
    ],
    targets: [
        .target(name: "WealthfolioAppleIntelligence")
    ]
)

//! Builds the Swift half of the bridge and links it. Only for macOS targets
//! built on a Mac; elsewhere the crate is empty.

/// Where macOS keeps the Swift runtime. The toolchain's copy of the
/// concurrency library is found by run path, so a binary that links this
/// crate needs this directory on its run path to start.
#[cfg(target_os = "macos")]
const SWIFT_RUNTIME_DIR: &str = "/usr/lib/swift";

fn main() {
    println!("cargo:rerun-if-changed=swift");

    #[cfg(target_os = "macos")]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        // The app's minimum macOS. The model's framework needs macOS 26 and is
        // linked weakly, so the app still starts on older systems.
        swift_rs::SwiftLinker::new("12.0")
            .with_package("WealthfolioAppleIntelligence", "swift")
            .link();
        // For this crate's own tests. A link argument does not reach the
        // crates that depend on this one, so the app's build script sets the
        // same path.
        println!("cargo:rustc-link-arg=-Wl,-rpath,{SWIFT_RUNTIME_DIR}");
    }
}

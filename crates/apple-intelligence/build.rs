//! Builds the Swift half of the bridge and links it. Only for Apple silicon
//! Mac targets built on a Mac; elsewhere the crate is empty.

/// Where macOS keeps the Swift runtime. The toolchain's copy of the
/// concurrency library is found by run path, so a binary that links this
/// crate needs this directory on its run path to start.
#[cfg(target_os = "macos")]
const SWIFT_RUNTIME_DIR: &str = "/usr/lib/swift";

/// The first macOS SDK whose FoundationModels the bridge supports. With an
/// older SDK the bridge builds, but reports the model as unsupported, so the
/// app never offers it.
#[cfg(target_os = "macos")]
const MIN_SDK_MAJOR: u32 = 27;

fn main() {
    println!("cargo:rerun-if-changed=swift");

    // Apple Intelligence runs on Apple silicon only. swift-rs builds a macOS
    // package for the host's architecture, so an Intel target built on an
    // Apple silicon Mac would get a library without the bridge.
    #[cfg(target_os = "macos")]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos")
        && std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("aarch64")
    {
        warn_if_sdk_too_old();
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

/// Says so in the build output when the SDK would build a bridge that never
/// offers the model, so such a build is not shipped by mistake.
#[cfg(target_os = "macos")]
fn warn_if_sdk_too_old() {
    let version = std::process::Command::new("xcrun")
        .args(["--sdk", "macosx", "--show-sdk-version"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string());
    let major = version
        .as_deref()
        .and_then(|version| version.split('.').next())
        .and_then(|major| major.parse::<u32>().ok());
    if major.is_none_or(|major| major < MIN_SDK_MAJOR) {
        println!(
            "cargo:warning=macOS SDK {} is older than {MIN_SDK_MAJOR}: Apple Intelligence will be unavailable in this build.",
            version.as_deref().unwrap_or("(unknown)")
        );
    }
}

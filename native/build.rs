// Links the addon for Node-API and embeds the urx-device identity the build
// was made from. scripts/build-native.mjs computes both values once, from
// the checkout, and passes them in; a build without them embeds "unknown".

fn main() {
    napi_build::setup();
    for name in ["URX_COMMON_VERSION", "URX_COMMON_COMMIT"] {
        println!("cargo:rerun-if-env-changed={name}");
        let value = std::env::var(name).unwrap_or_else(|_| "unknown".to_owned());
        println!("cargo:rustc-env={name}={value}");
    }
}

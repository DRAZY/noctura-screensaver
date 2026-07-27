fn main() {
    // Link the pre-built icon resource (RT_GROUP_ICON) into the PE so Explorer
    // and the screensaver dropdown show the Noctura icon. icon.res is generated
    // by scripts/ico2res.py from src-tauri/icons/icon.ico and committed — both
    // lld-link (cargo-xwin) and MSVC link accept .res inputs directly, so no
    // rc.exe / llvm-rc is needed anywhere in the toolchain.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        println!("cargo:rustc-link-arg={dir}/icon.res");
        println!("cargo:rerun-if-changed=icon.res");
    }
}

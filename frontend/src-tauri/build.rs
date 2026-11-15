fn main() {
    // tauri-build 只会为配置文件发出 rerun-if-changed，不包括图标；
    // 没有下面两行的话，换了 app-icon.png 重新生成 icons/ 后 exe 仍会沿用旧图标。
    println!("cargo:rerun-if-changed=app-icon.png");
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build()
}

// Release builds are GUI apps on Windows (no console window).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    dojix_desktop_lib::run();
}

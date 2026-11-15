use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow};

use crate::{read_settings, write_settings};

#[derive(Clone, Copy)]
struct Placement {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

impl Placement {
    fn from_settings(value: &Value) -> Option<Self> {
        let x = i32::try_from(value.get("x")?.as_i64()?).ok()?;
        let y = i32::try_from(value.get("y")?.as_i64()?).ok()?;
        let width = u32::try_from(value.get("width")?.as_u64()?).ok()?;
        let height = u32::try_from(value.get("height")?.as_u64()?).ok()?;
        if !(900..=10_000).contains(&width) || !(560..=10_000).contains(&height) {
            return None;
        }
        Some(Self { x, y, width, height })
    }

    fn from_window(window: &WebviewWindow) -> Option<Self> {
        let position = window.outer_position().ok()?;
        let size = window.inner_size().ok()?;
        Some(Self {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        })
    }

    fn visible_on(&self, position: PhysicalPosition<i32>, size: PhysicalSize<u32>) -> bool {
        let left = i64::from(self.x).max(i64::from(position.x));
        let top = i64::from(self.y).max(i64::from(position.y));
        let right = (i64::from(self.x) + i64::from(self.width))
            .min(i64::from(position.x) + i64::from(size.width));
        let bottom = (i64::from(self.y) + i64::from(self.height))
            .min(i64::from(position.y) + i64::from(size.height));
        right - left >= 100 && bottom - top >= 100
    }
}

pub fn restore(window: &WebviewWindow, state: &State) {
    let settings = read_settings();
    let saved = &settings["window"];
    if let Some(placement) = Placement::from_settings(saved) {
        let monitor = window
            .available_monitors()
            .ok()
            .and_then(|monitors| monitors.into_iter().find(|monitor| {
                placement.visible_on(*monitor.position(), *monitor.size())
            }));
        if let Some(monitor) = monitor {
            let size = monitor.size();
            let width = placement.width.min(size.width).max(900);
            let height = placement.height.min(size.height).max(560);
            let _ = window.set_size(PhysicalSize::new(width, height));
            let _ = window.set_position(PhysicalPosition::new(placement.x, placement.y));
        } else {
            let _ = window.set_size(PhysicalSize::new(placement.width, placement.height));
            let _ = window.center();
        }
    }
    state.changed(window);
    if saved["maximized"].as_bool() == Some(true) {
        let _ = window.maximize();
    }
}

#[derive(Clone)]
pub struct State {
    normal_placement: Arc<Mutex<Option<Placement>>>,
}

impl State {
    pub fn new() -> Self {
        let saved = read_settings();
        Self {
            normal_placement: Arc::new(Mutex::new(Placement::from_settings(&saved["window"]))),
        }
    }

    pub fn changed(&self, window: &WebviewWindow) {
        if window.is_maximized().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
            return;
        }
        if let Some(placement) = Placement::from_window(window) {
            *self.normal_placement.lock().unwrap_or_else(|e| e.into_inner()) = Some(placement);
        }
    }

    pub fn save(&self, window: &WebviewWindow) {
        self.changed(window);
        let placement = *self.normal_placement.lock().unwrap_or_else(|e| e.into_inner());
        let maximized = window.is_maximized().unwrap_or(false);
        let saved_window = match placement {
            Some(p) => json!({
                "x": p.x, "y": p.y, "width": p.width, "height": p.height,
                "maximized": maximized,
            }),
            None => json!({"maximized": maximized}),
        };
        if let Err(error) = write_settings(&json!({"window": saved_window})) {
            eprintln!("无法保存窗口位置和大小：{error}");
        }
    }
}

//! 分镜对照：剧本 ↔ 分镜稿对照小工具的 Rust 后端。
//!
//! 数据全部放在 exe 旁边（绿色版，拷走整个文件夹就带走了数据）：
//! - `settings.json`：AI 接口设置（Base URL / 模型 / API Key / 温度）+ 窗口位置大小
//! - `drafts.json`：所有分镜稿（名称 / 剧本 / 分镜稿 / AI 优化结果）+ 当前打开的是哪份
//! - `exports\`：「导出」生成的 Markdown 文件
//!
//! 前端通过 `api.js` 里的 ROUTES 调用这里的命令；AI 优化是流式的，
//! 结果经 `ai-event` 事件一段一段推给前端（chunk / done / stopped / error）。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(target_os = "windows")]
mod rounded_frame;
#[cfg(target_os = "windows")]
mod webview2_gate;
#[cfg(target_os = "windows")]
mod window_placement;

// ---------- 路径与文件读写 ----------
fn exe_dir() -> PathBuf {
    env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn settings_file() -> PathBuf {
    exe_dir().join("settings.json")
}

fn drafts_file() -> PathBuf {
    exe_dir().join("drafts.json")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 先写临时文件再改名：写到一半断电/崩溃，原文件也不会被写坏
fn atomic_write(path: &Path, text: &str) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, text).map_err(|e| format!("写入 {} 失败：{e}", path.display()))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("保存 {} 失败：{e}", path.display())
    })
}

// ---------- settings.json ----------
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

fn read_settings_unlocked() -> Value {
    fs::read_to_string(settings_file())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(t.trim_start_matches('\u{feff}')).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| json!({}))
}

pub(crate) fn read_settings() -> Value {
    let _guard = SETTINGS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read_settings_unlocked()
}

/// 只覆盖 patch 里出现的顶层字段，其它字段原样保留
///（AI 设置和窗口位置共用一个文件，互不冲掉）
pub(crate) fn write_settings(patch: &Value) -> Result<(), String> {
    let _guard = SETTINGS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut current = read_settings_unlocked();
    if let (Some(cur), Some(p)) = (current.as_object_mut(), patch.as_object()) {
        for (k, v) in p {
            cur.insert(k.clone(), v.clone());
        }
    }
    let text = serde_json::to_string_pretty(&current).map_err(|e| e.to_string())?;
    atomic_write(&settings_file(), &text)
}

#[derive(Clone, Debug)]
struct AiCfg {
    base_url: String,
    model: String,
    api_key: String,
    temperature: f64,
}

const DEFAULT_BASE_URL: &str = "http://127.0.0.1:11434/v1";
const DEFAULT_TEMPERATURE: f64 = 0.3;

fn parse_temperature(v: Option<&Value>) -> f64 {
    let t = match v {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
        _ => None,
    };
    match t {
        Some(x) if x.is_finite() => x.clamp(0.0, 2.0),
        _ => DEFAULT_TEMPERATURE,
    }
}

fn text_field(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn ai_cfg_from(v: &Value) -> AiCfg {
    let base = text_field(v, "baseUrl");
    AiCfg {
        base_url: if base.is_empty() { DEFAULT_BASE_URL.to_string() } else { base },
        model: text_field(v, "model"),
        api_key: text_field(v, "apiKey"),
        temperature: parse_temperature(v.get("temperature")),
    }
}

fn cfg_to_json(c: &AiCfg) -> Value {
    json!({
        "baseUrl": c.base_url,
        "model": c.model,
        "apiKey": c.api_key,
        "temperature": c.temperature,
    })
}

// ---------- AI 接口预设：可以建多个，切换不同的 AI 供应商 ----------
// settings.json 里：presets = [{id, name, baseUrl, model, apiKey, temperature}]，activePreset = 正在用的那个的 id。
// 顶层的 baseUrl / model / apiKey / temperature 始终是「正在用的预设」的副本，所以其它读取这些字段的地方不用改；
// 旧版本只有顶层字段：读到时自动当成一个叫「默认」的预设。
const MAX_PRESETS: usize = 20;

fn clean_preset(v: &Value, idx: usize) -> Value {
    let mut id: String = text_field(v, "id").chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').collect();
    if id.is_empty() {
        id = format!("p{}x{}", now_ms(), idx);
    }
    let mut name: String = text_field(v, "name").chars().take(30).collect();
    if name.is_empty() {
        name = format!("预设 {}", idx + 1);
    }
    json!({
        "id": id,
        "name": name,
        "baseUrl": text_field(v, "baseUrl"),
        "model": text_field(v, "model"),
        "apiKey": text_field(v, "apiKey"),
        "temperature": parse_temperature(v.get("temperature")),
    })
}

fn presets_of(v: &Value) -> Vec<Value> {
    if let Some(arr) = v.get("presets").and_then(|x| x.as_array()) {
        return arr.iter().take(MAX_PRESETS).enumerate().map(|(i, p)| clean_preset(p, i)).collect();
    }
    if !text_field(v, "baseUrl").is_empty() || !text_field(v, "model").is_empty() {
        let mut p = clean_preset(v, 0);
        p["id"] = json!("default");
        p["name"] = json!("默认");
        return vec![p];
    }
    Vec::new()
}

fn active_of<'a>(v: &Value, presets: &'a [Value]) -> Option<&'a Value> {
    let want = text_field(v, "activePreset");
    presets.iter().find(|p| p["id"] == json!(want)).or_else(|| presets.first())
}

/// 给前端 / 写回 settings.json 的完整设置：顶层是正在用的预设的副本 + 全部预设 + 正在用的 id
fn settings_json(v: &Value) -> Value {
    let presets = presets_of(v);
    let active = active_of(v, &presets).cloned();
    let mut out = match &active {
        Some(a) => cfg_to_json(&ai_cfg_from(a)),
        None => cfg_to_json(&ai_cfg_from(v)),
    };
    out["presets"] = json!(presets);
    out["activePreset"] = json!(active.as_ref().and_then(|a| a["id"].as_str()).unwrap_or(""));
    out
}

#[tauri::command]
fn get_settings() -> Value {
    settings_json(&read_settings())
}

#[tauri::command]
fn set_settings(settings: Value) -> Result<Value, String> {
    let out = settings_json(&settings);
    write_settings(&out)?;
    Ok(out)
}

// ---------- drafts.json：多份分镜稿 ----------
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct Doc {
    id: String,
    title: String,
    script: String,
    /// 旧版本的整块分镜稿文字：现在改成了下面的 blocks，读到旧数据时会自动迁移成一个批次，之后不再写出
    #[serde(skip_serializing_if = "String::is_empty")]
    board: String,
    /// 分镜稿由很多个独立的小批次组成，每个批次可以关联剧本里的一段文字
    blocks: Vec<Block>,
    /// AI 优化结果：单独存放，永远不会覆盖手写的分镜稿
    optimized: String,
    #[serde(rename = "updatedAt")]
    updated_at: u64,
    /// 这份分镜稿专属的图片资产库（只存元数据，图片文件在 exe 旁边的 assets\<分镜稿id>\ 里）
    assets: Vec<Asset>,
}

/// 分镜稿里的一个批次：一段独立的文字，可以（不强制）记住它对应剧本里的哪一段
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
struct Block {
    id: String,
    title: String,
    text: String,
    link: Option<ScriptLink>,
    /// 这个批次的 AI 优化稿：单独存放，永远不会覆盖手写的批次文字
    optimized: String,
}

/// 关联的剧本片段。不存字符位置（剧本改动后位置会变），而是存「去掉空白和 Markdown 标记后的文字」
/// 以及它是第几次出现（nth），前端据此在当前剧本里重新找到那一段。preview 只是给人看的片段。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
struct ScriptLink {
    quote: String,
    nth: u32,
    preview: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct Asset {
    id: String,
    /// 在分镜稿里用 @名称 引用它；名称里不会有空白和 @
    name: String,
    mime: String,
    /// 原图的路径：资产只「引用」原图，不复制；资源库里看到的是我们自己生成的缩略图（<id>.thumb.jpg）。
    /// 为空表示没有原图可引用（比如从剪贴板粘贴的图），这时图片本身存了一份在 assets 文件夹里。
    #[serde(skip_serializing_if = "String::is_empty")]
    path: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct StoreFile {
    #[serde(rename = "currentId")]
    current_id: String,
    docs: Vec<Doc>,
}

static STORE_LOCK: Mutex<()> = Mutex::new(());
static ID_COUNTER: AtomicU64 = AtomicU64::new(0);

fn to_base36(mut n: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

fn new_id() -> String {
    format!("d{}{}", to_base36(now_ms()), to_base36(ID_COUNTER.fetch_add(1, Ordering::Relaxed)))
}

fn blank_doc() -> Doc {
    Doc { id: new_id(), updated_at: now_ms(), ..Default::default() }
}

fn count_chars(s: &str) -> usize {
    s.chars().filter(|c| !c.is_whitespace()).count()
}

/// 名称留空时取剧本第一行的前 20 个字
fn doc_title(d: &Doc) -> String {
    let t = d.title.trim();
    if !t.is_empty() {
        return t.to_string();
    }
    d.script
        .lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty())
        .map(|l| l.chars().take(20).collect::<String>())
        .unwrap_or_else(|| "未命名分镜稿".to_string())
}

fn doc_excerpt(d: &Doc) -> String {
    d.script.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(420).collect()
}

/// 列表里只放摘要，按最近保存倒序
fn list_meta(docs: &[Doc]) -> Value {
    let mut sorted: Vec<&Doc> = docs.iter().collect();
    sorted.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Value::Array(
        sorted
            .into_iter()
            .map(|d| {
                json!({
                    "id": d.id,
                    "title": doc_title(d),
                    "updatedAt": d.updated_at,
                    "boardLen": d.blocks.iter().map(|b| count_chars(&b.text)).sum::<usize>(),
                    "excerpt": doc_excerpt(d),
                })
            })
            .collect(),
    )
}

fn latest_id(docs: &[Doc]) -> String {
    docs.iter().max_by_key(|d| d.updated_at).map(|d| d.id.clone()).unwrap_or_default()
}

fn load_store() -> StoreFile {
    let path = drafts_file();
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return StoreFile::default(),
    };
    match serde_json::from_str::<StoreFile>(text.trim_start_matches('\u{feff}')) {
        Ok(s) => s,
        Err(e) => {
            // 文件损坏：绝不直接覆盖，先留一份副本再重新开始
            let backup = exe_dir().join(format!("drafts.corrupt-{}.json", now_ms()));
            let _ = fs::copy(&path, &backup);
            eprintln!("drafts.json 无法解析（{e}），已备份为 {}", backup.display());
            StoreFile::default()
        }
    }
}

/// 在锁内读出 → 修正（至少有一份、当前那份存在）→ 执行 → 需要时写回
fn with_store<R>(write: bool, f: impl FnOnce(&mut StoreFile) -> R) -> Result<R, String> {
    let _guard = STORE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = load_store();
    let mut dirty = false;
    // 旧数据：整块的 board 文字 → 迁移成一个批次（之后 board 不再写出）
    for d in store.docs.iter_mut() {
        if d.blocks.is_empty() && !d.board.trim().is_empty() {
            d.blocks.push(Block { id: new_id(), title: String::new(), text: std::mem::take(&mut d.board), link: None, optimized: String::new() });
            dirty = true;
        } else if !d.board.is_empty() {
            d.board.clear();
            dirty = true;
        }
    }
    // 一份分镜稿都没有是正常状态（首页只显示「空白分镜稿」），不自动建空项目
    if !store.docs.is_empty() && !store.docs.iter().any(|d| d.id == store.current_id) {
        store.current_id = latest_id(&store.docs);
        dirty = true;
    }
    let result = f(&mut store);
    if write || dirty {
        let text = serde_json::to_string_pretty(&store).map_err(|e| e.to_string())?;
        atomic_write(&drafts_file(), &text)?;
    }
    Ok(result)
}

fn current_doc(store: &StoreFile) -> Option<Doc> {
    store
        .docs
        .iter()
        .find(|d| d.id == store.current_id)
        .or_else(|| store.docs.first())
        .cloned()
}

#[tauri::command]
fn doc_get() -> Result<Value, String> {
    with_store(false, |s| json!({ "doc": current_doc(s), "list": list_meta(&s.docs) }))
}

/// 自动保存：只覆盖这一份；内容没变就不动「最近保存时间」
#[tauri::command]
fn doc_save(doc: Doc) -> Result<Value, String> {
    if doc.id.trim().is_empty() {
        return Err("分镜稿缺少 id，无法保存".into());
    }
    with_store(true, |s| {
        let now = now_ms();
        let updated_at = match s.docs.iter_mut().find(|d| d.id == doc.id) {
            Some(old) => {
                let same = old.title == doc.title
                    && old.script == doc.script
                    && old.blocks == doc.blocks
                    && old.optimized == doc.optimized;
                if !same {
                    old.title = doc.title;
                    old.script = doc.script;
                    old.blocks = doc.blocks;
                    old.optimized = doc.optimized;
                    old.updated_at = now;
                }
                old.updated_at
            }
            None => {
                let mut d = doc;
                d.updated_at = now;
                d.assets = Vec::new(); // 资产只能通过 asset_add 进来（要有对应的图片文件）
                s.docs.push(d);
                now
            }
        };
        json!({ "updatedAt": updated_at, "list": list_meta(&s.docs) })
    })
}

#[tauri::command]
fn doc_new() -> Result<Value, String> {
    with_store(true, |s| {
        let d = blank_doc();
        s.current_id = d.id.clone();
        s.docs.push(d.clone());
        json!({ "doc": d, "list": list_meta(&s.docs) })
    })
}

#[tauri::command]
fn doc_open(id: String) -> Result<Value, String> {
    let found = with_store(true, |s| {
        let hit = s.docs.iter().find(|d| d.id == id).cloned();
        if let Some(d) = &hit {
            s.current_id = d.id.clone();
        }
        hit
    })?;
    match found {
        Some(d) => Ok(json!(d)),
        None => Err("这份分镜稿已不存在".into()),
    }
}

#[tauri::command]
fn doc_delete(id: String) -> Result<Value, String> {
    let _ = fs::remove_dir_all(asset_dir(&id)); // 连同这份分镜稿的资产图一起删
    with_store(true, |s| {
        s.docs.retain(|d| d.id != id);
        if !s.docs.iter().any(|d| d.id == s.current_id) {
            s.current_id = latest_id(&s.docs); // 删光时为空串
        }
        json!({ "doc": current_doc(s), "list": list_meta(&s.docs) })
    })
}

// ---------- 资源库：每份分镜稿专属的图片资产 ----------
const MAX_ASSET_BYTES: usize = 12 * 1024 * 1024;
const MAX_ASSET_NAME_CHARS: usize = 20;

/// 目录/文件名里只允许字母数字和 _-（id 本来就是 base36），防止路径穿越
fn safe_component(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').collect()
}

fn asset_dir(doc_id: &str) -> PathBuf {
    exe_dir().join("assets").join(safe_component(doc_id))
}

fn mime_ext(mime: &str) -> Option<&'static str> {
    match mime {
        "image/jpeg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

fn asset_file(doc_id: &str, a: &Asset) -> Option<PathBuf> {
    let ext = mime_ext(&a.mime)?;
    Some(asset_dir(doc_id).join(format!("{}.{}", safe_component(&a.id), ext)))
}

/// 资产名要能写成 @名称：不能有空白、@ 和文件名非法字符
fn clean_asset_name(raw: &str) -> String {
    let mapped: String = raw
        .chars()
        .map(|c| if c.is_whitespace() || c == '@' || c == '＠' || c.is_control() || "\\/:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    let t: String = mapped.trim_matches('_').chars().take(MAX_ASSET_NAME_CHARS).collect();
    if t.is_empty() { "图片".to_string() } else { t }
}

fn unique_asset_name(base: &str, existing: &[Asset], skip_id: Option<&str>) -> String {
    let taken = |n: &str| existing.iter().any(|a| Some(a.id.as_str()) != skip_id && a.name == n);
    if !taken(base) {
        return base.to_string();
    }
    for i in 2..1000 {
        let suffix = format!("_{i}");
        let head: String = base.chars().take(MAX_ASSET_NAME_CHARS.saturating_sub(suffix.chars().count())).collect();
        let cand = format!("{head}{suffix}");
        if !taken(&cand) {
            return cand;
        }
    }
    format!("{base}_{}", now_ms())
}

fn parse_data_url(data_url: &str) -> Result<(String, Vec<u8>), String> {
    use base64::Engine as _;
    let (head, body) = data_url.split_once(',').ok_or("图片数据格式不对")?;
    if !head.starts_with("data:") || !head.contains(";base64") {
        return Err("图片数据格式不对".into());
    }
    let mime = head.trim_start_matches("data:").split(';').next().unwrap_or("").to_lowercase();
    if mime_ext(&mime).is_none() {
        return Err(format!("不支持这种图片格式（{mime}），请用 jpg / png / webp / gif"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(body.trim())
        .map_err(|e| format!("图片数据无法解码：{e}"))?;
    if bytes.is_empty() {
        return Err("图片是空的".into());
    }
    if bytes.len() > MAX_ASSET_BYTES {
        return Err(format!("图片太大了（{:.1} MB），最多 12 MB", bytes.len() as f64 / 1048576.0));
    }
    Ok((mime, bytes))
}

fn doc_assets(doc_id: &str, s: &StoreFile) -> Result<Vec<Asset>, String> {
    s.docs
        .iter()
        .find(|d| d.id == doc_id)
        .map(|d| d.assets.clone())
        .ok_or_else(|| "这份分镜稿已不存在".to_string())
}

#[tauri::command]
fn asset_add(doc_id: String, name: String, data_url: String, thumb_data_url: Option<String>) -> Result<Value, String> {
    let (mime, bytes) = parse_data_url(&data_url)?;
    with_store(false, |s| doc_assets(&doc_id, s))??;
    let id = new_id();
    let asset = Asset { id: id.clone(), name: clean_asset_name(&name), mime, path: String::new() };
    let path = asset_file(&doc_id, &asset).ok_or("不支持的图片格式")?;
    fs::create_dir_all(asset_dir(&doc_id)).map_err(|e| format!("无法创建资源库文件夹：{e}"))?;
    fs::write(&path, &bytes).map_err(|e| format!("保存图片失败：{e}"))?;
    if let Some(t) = thumb_data_url {
        use base64::Engine as _;
        if let Some((_, body)) = t.split_once(',') {
            if let Ok(tb) = base64::engine::general_purpose::STANDARD.decode(body.trim()) {
                if !tb.is_empty() && tb.len() <= 2 * 1024 * 1024 {
                    let _ = fs::write(thumb_file(&doc_id, &id), tb);   // 缩略图失败不影响入库：读不到时退回图片本身
                }
            }
        }
    }
    with_store(true, |s| {
        let doc = s.docs.iter_mut().find(|d| d.id == doc_id).ok_or_else(|| "这份分镜稿已不存在".to_string())?;
        let mut asset = asset;
        asset.name = unique_asset_name(&asset.name, &doc.assets, None);
        doc.assets.push(asset.clone());
        Ok::<Value, String>(json!({ "asset": asset, "assets": doc.assets }))
    })?
}

const MAX_REF_BYTES: u64 = 40 * 1024 * 1024;

fn thumb_file(doc_id: &str, asset_id: &str) -> PathBuf {
    asset_dir(doc_id).join(format!("{}.thumb.jpg", safe_component(asset_id)))
}

fn ext_mime(path: &std::path::Path) -> Option<&'static str> {
    match path.extension()?.to_string_lossy().to_lowercase().as_str() {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        _ => None,
    }
}

fn data_url(mime: &str, bytes: Vec<u8>) -> String {
    use base64::Engine as _;
    format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

fn find_asset(doc_id: &str, asset_id: &str) -> Result<Asset, String> {
    with_store(false, |s| doc_assets(doc_id, s))??
        .into_iter()
        .find(|a| a.id == asset_id)
        .ok_or_else(|| "这张图已不在资源库里".to_string())
}

/// 读出原图（给 AI 用）：引用的资产读原路径，粘贴来的读自己存的那份
#[tauri::command]
fn asset_data(doc_id: String, asset_id: String) -> Result<String, String> {
    let asset = find_asset(&doc_id, &asset_id)?;
    if !asset.path.is_empty() {
        let p = PathBuf::from(&asset.path);
        let meta = fs::metadata(&p).map_err(|_| format!("原图找不到了：{}（被移动、改名或删除了？）", asset.path))?;
        if meta.len() > MAX_REF_BYTES {
            return Err(format!("原图太大了（{:.1} MB）", meta.len() as f64 / 1048576.0));
        }
        let bytes = fs::read(&p).map_err(|e| format!("读取原图失败：{e}"))?;
        return Ok(data_url(&asset.mime, bytes));
    }
    let path = asset_file(&doc_id, &asset).ok_or("不支持的图片格式")?;
    let bytes = fs::read(&path).map_err(|e| format!("读取图片失败：{e}"))?;
    Ok(data_url(&asset.mime, bytes))
}

/// 资源库里显示的缩略图：优先读生成好的小图，没有就退回图片本身（粘贴来的图）
#[tauri::command]
fn asset_thumb(doc_id: String, asset_id: String) -> Result<String, String> {
    let t = thumb_file(&doc_id, &asset_id);
    if let Ok(bytes) = fs::read(&t) {
        return Ok(data_url("image/jpeg", bytes));
    }
    let asset = find_asset(&doc_id, &asset_id)?;
    let path = asset_file(&doc_id, &asset).ok_or("不支持的图片格式")?;
    let bytes = fs::read(&path).map_err(|e| format!("读取图片失败：{e}"))?;
    Ok(data_url(&asset.mime, bytes))
}

/// 前端要给原图生成缩略图：按路径把图读出来（不入库）
#[tauri::command]
fn asset_read_path(path: String) -> Result<Value, String> {
    let p = PathBuf::from(&path);
    let mime = ext_mime(&p).ok_or("不支持这种图片格式，请用 jpg / png / webp / gif")?;
    let meta = fs::metadata(&p).map_err(|_| "找不到这个文件".to_string())?;
    if !meta.is_file() {
        return Err("这不是一个文件".into());
    }
    if meta.len() > MAX_REF_BYTES {
        return Err(format!("图片太大了（{:.1} MB），最多 40 MB", meta.len() as f64 / 1048576.0));
    }
    let bytes = fs::read(&p).map_err(|e| format!("读取图片失败：{e}"))?;
    let name = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    Ok(json!({ "name": name, "mime": mime, "dataUrl": data_url(mime, bytes) }))
}

/// 引用原图加入资源库：只记路径，并存一张前端生成的缩略图
#[tauri::command]
fn asset_add_ref(doc_id: String, path: String, thumb_data_url: String) -> Result<Value, String> {
    use base64::Engine as _;
    let p = PathBuf::from(&path);
    let mime = ext_mime(&p).ok_or("不支持这种图片格式，请用 jpg / png / webp / gif")?;
    if !fs::metadata(&p).map(|m| m.is_file()).unwrap_or(false) {
        return Err("找不到这个文件".into());
    }
    let (_, body) = thumb_data_url.split_once(',').ok_or("缩略图数据格式不对")?;
    let thumb = base64::engine::general_purpose::STANDARD.decode(body.trim()).map_err(|e| format!("缩略图无法解码：{e}"))?;
    if thumb.is_empty() || thumb.len() > 2 * 1024 * 1024 {
        return Err("缩略图大小不对".into());
    }
    with_store(false, |s| doc_assets(&doc_id, s))??;
    let id = new_id();
    let name = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let asset = Asset { id: id.clone(), name: clean_asset_name(&name), mime: mime.to_string(), path: path.clone() };
    fs::create_dir_all(asset_dir(&doc_id)).map_err(|e| format!("无法创建资源库文件夹：{e}"))?;
    fs::write(thumb_file(&doc_id, &id), &thumb).map_err(|e| format!("保存缩略图失败：{e}"))?;
    with_store(true, |s| {
        let doc = s.docs.iter_mut().find(|d| d.id == doc_id).ok_or_else(|| "这份分镜稿已不存在".to_string())?;
        let mut asset = asset;
        asset.name = unique_asset_name(&asset.name, &doc.assets, None);
        doc.assets.push(asset.clone());
        Ok::<Value, String>(json!({ "asset": asset, "assets": doc.assets }))
    })?
}

/// 原生「选择图片」对话框（可多选），返回所选文件的路径
#[tauri::command]
fn pick_images() -> Vec<String> {
    rfd::FileDialog::new()
        .set_title("选择要加入资源库的图片")
        .add_filter("图片", &["jpg", "jpeg", "png", "webp", "gif"])
        .pick_files()
        .map(|v| v.into_iter().map(|p| p.to_string_lossy().to_string()).collect())
        .unwrap_or_default()
}

/// 拖进窗口的文本文件：按路径读成 base64 交给前端解码（编码判断在前端）
#[tauri::command]
fn file_read(path: String) -> Result<Value, String> {
    use base64::Engine as _;
    let p = PathBuf::from(&path);
    let meta = fs::metadata(&p).map_err(|_| "找不到这个文件".to_string())?;
    if !meta.is_file() {
        return Err("这不是一个文件".into());
    }
    if meta.len() > 4 * 1024 * 1024 {
        return Err(format!("文件太大了（{:.1} MB）", meta.len() as f64 / 1048576.0));
    }
    let bytes = fs::read(&p).map_err(|e| format!("读取文件失败：{e}"))?;
    let name = p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    Ok(json!({ "name": name, "base64": base64::engine::general_purpose::STANDARD.encode(bytes) }))
}

#[tauri::command]
fn asset_rename(doc_id: String, asset_id: String, name: String) -> Result<Value, String> {
    with_store(true, |s| {
        let doc = s.docs.iter_mut().find(|d| d.id == doc_id).ok_or_else(|| "这份分镜稿已不存在".to_string())?;
        if !doc.assets.iter().any(|a| a.id == asset_id) {
            return Err("这张图已不在资源库里".to_string());
        }
        let clean = clean_asset_name(&name);
        let unique = unique_asset_name(&clean, &doc.assets, Some(&asset_id));
        if let Some(a) = doc.assets.iter_mut().find(|a| a.id == asset_id) {
            a.name = unique;
        }
        Ok(json!({ "assets": doc.assets }))
    })?
}

#[tauri::command]
fn asset_remove(doc_id: String, asset_id: String) -> Result<Value, String> {
    with_store(true, |s| {
        let doc = s.docs.iter_mut().find(|d| d.id == doc_id).ok_or_else(|| "这份分镜稿已不存在".to_string())?;
        if let Some(pos) = doc.assets.iter().position(|a| a.id == asset_id) {
            let a = doc.assets.remove(pos);
            // 只删我们自己存的缩略图 / 粘贴来的那份；引用的原图不动
            let _ = fs::remove_file(thumb_file(&doc_id, &a.id));
            if a.path.is_empty() {
                if let Some(p) = asset_file(&doc_id, &a) {
                    let _ = fs::remove_file(p);
                }
            }
        }
        Ok(json!({ "assets": doc.assets }))
    })?
}

// ---------- 导出 Markdown ----------
/// 分镜稿批次导出：每个批次一个三级标题，有关联剧本的话标一行「对应剧本」
fn board_markdown(d: &Doc) -> String {
    let blocks: Vec<&Block> = d.blocks.iter().filter(|b| !b.text.trim().is_empty() || !b.title.trim().is_empty()).collect();
    if blocks.is_empty() {
        return "（空）".to_string();
    }
    blocks
        .iter()
        .enumerate()
        .map(|(i, b)| {
            let mut head = format!("### {:02}", i + 1);
            if !b.title.trim().is_empty() {
                head.push(' ');
                head.push_str(b.title.trim());
            }
            let mut part = vec![head];
            if let Some(l) = &b.link {
                if !l.preview.trim().is_empty() {
                    part.push(format!("> 对应剧本：{}", l.preview.trim()));
                }
            }
            part.push(if b.text.trim().is_empty() { "（空）".to_string() } else { b.text.trim().to_string() });
            if !b.optimized.trim().is_empty() {
                part.push("**AI 优化稿：**".to_string());
                part.push(b.optimized.trim().to_string());
            }
            part.join("\n\n")
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn doc_markdown(d: &Doc) -> String {
    let or_empty = |s: &str| {
        let t = s.trim();
        if t.is_empty() { "（空）".to_string() } else { t.to_string() }
    };
    let mut parts = vec![
        format!("# {}", doc_title(d)),
        "## 剧本".to_string(),
        or_empty(&d.script),
        "## 分镜稿".to_string(),
        board_markdown(d),
    ];
    if !d.optimized.trim().is_empty() {
        parts.push("## AI 优化".to_string());
        parts.push(d.optimized.trim().to_string());
    }
    if !d.assets.is_empty() {
        parts.push("## 资源库".to_string());
        parts.push(d.assets.iter().map(|a| format!("- @{}", a.name)).collect::<Vec<_>>().join("\n"));
    }
    parts.join("\n\n") + "\n"
}

/// 去掉 Windows 文件名里不允许的字符
fn safe_file_stem(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').trim().to_string();
    let cleaned: String = cleaned.chars().take(60).collect();
    if cleaned.is_empty() { "分镜稿".into() } else { cleaned }
}

#[tauri::command]
fn doc_export(id: String) -> Result<Value, String> {
    let doc = with_store(false, |s| s.docs.iter().find(|d| d.id == id).cloned())?
        .ok_or_else(|| "这份分镜稿已不存在".to_string())?;
    let dir = exe_dir().join("exports");
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建导出文件夹：{e}"))?;
    let stem = safe_file_stem(&doc_title(&doc));
    let mut path = dir.join(format!("{stem}.md"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem} ({n}).md"));
        n += 1;
    }
    fs::write(&path, doc_markdown(&doc)).map_err(|e| format!("写入导出文件失败：{e}"))?;
    let name = path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    Ok(json!({ "path": format!("exports\\{name}"), "fullPath": path.to_string_lossy() }))
}

// ---------- AI：OpenAI 兼容 /chat/completions ----------
/// 系统提示词 = 「W.分镜脚本大师」技能全文 + 本应用的调用约定。和浏览器预览（devAi.js）共用 src/skill/system-prompt.md。
/// 想换成自己的技能：在 exe 旁边放一个 skill.md，会优先用它（整段替换系统提示词）。
const DEFAULT_SYSTEM_PROMPT: &str = include_str!("../../src/skill/system-prompt.md");

fn system_prompt() -> String {
    let custom = exe_dir().join("skill.md");
    if let Ok(text) = fs::read_to_string(&custom) {
        let t = text.trim_start_matches('\u{feff}').trim();
        if !t.is_empty() {
            return t.to_string();
        }
    }
    DEFAULT_SYSTEM_PROMPT.to_string()
}

fn chat_url(base: &str) -> String {
    let b = base.trim().trim_end_matches('/');
    if b.ends_with("/chat/completions") {
        b.to_string()
    } else {
        format!("{b}/chat/completions")
    }
}

/// 随请求附带的资产图：name 是 @名称（不带 @），data_url 是 data:image/...;base64,...
#[derive(Clone, Debug, Deserialize)]
struct ImageRef {
    name: String,
    #[serde(rename = "dataUrl")]
    data_url: String,
}

/// 没有图片时用普通字符串；有图片时用 OpenAI 的多模态格式（文字 + 一张张 image_url，每张前面标上「参考图N」）
fn build_user_content(text: &str, images: &[ImageRef]) -> Value {
    if images.is_empty() {
        return Value::String(text.to_string());
    }
    let mut parts = vec![json!({ "type": "text", "text": text })];
    for (i, img) in images.iter().enumerate() {
        parts.push(json!({ "type": "text", "text": format!("参考图{}（{}）：", i + 1, img.name) }));
        parts.push(json!({ "type": "image_url", "image_url": { "url": img.data_url } }));
    }
    Value::Array(parts)
}

fn make_agent(read_timeout_secs: u64) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(read_timeout_secs))
        .timeout_write(Duration::from_secs(30))
        .build()
}

fn http_error_text(code: u16, body: &str) -> String {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            v.pointer("/error/message")
                .or_else(|| v.pointer("/message"))
                .or_else(|| v.pointer("/error"))
                .and_then(|m| m.as_str().map(|s| s.to_string()))
        })
        .unwrap_or_else(|| body.chars().take(200).collect::<String>())
        .trim()
        .to_string();
    let hint = match code {
        401 | 403 => "API Key 无效、已过期或没有权限，请到设置里检查",
        404 => "接口地址不对（找不到 /chat/completions），请检查 Base URL 和模型名",
        429 => "请求太频繁或额度已用完，请稍后再试",
        500..=599 => "模型服务端出错了，请稍后再试",
        _ => "接口拒绝了这次请求",
    };
    if detail.is_empty() {
        format!("接口返回 {code}：{hint}")
    } else {
        format!("接口返回 {code}：{hint}（{detail}）")
    }
}

fn describe_error(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, resp) => {
            let mut body = String::new();
            let _ = resp.into_reader().take(4000).read_to_string(&mut body);
            http_error_text(code, &body)
        }
        ureq::Error::Transport(t) => {
            format!("无法连接到接口：{t}。请确认地址正确、网络通畅、服务已启动")
        }
    }
}

fn prepare_request(cfg: &AiCfg, stream: bool) -> ureq::Request {
    let agent = make_agent(if stream { 180 } else { 45 });   // 流式：两次数据之间最多等多久（推理型模型开头会想很久）
    let mut req = agent
        .post(&chat_url(&cfg.base_url))
        .set("Content-Type", "application/json")
        .set("Accept", if stream { "text/event-stream" } else { "application/json" });
    if !cfg.api_key.is_empty() {
        req = req.set("Authorization", &format!("Bearer {}", cfg.api_key));
    }
    req
}

/// 推理模型会把思考过程包在 <think>…</think> 里一起吐出来，这里把它滤掉；
/// 标签可能被切在两个 chunk 之间，所以要把「可能是标签开头」的尾巴留到下一次
#[derive(Default)]
struct ThinkFilter {
    in_think: bool,
    buf: String,
}

fn partial_suffix(s: &str, tag: &str) -> usize {
    (1..tag.len()).rev().find(|&k| s.as_bytes().ends_with(&tag.as_bytes()[..k])).unwrap_or(0)
}

impl ThinkFilter {
    fn push(&mut self, s: &str) -> String {
        const OPEN: &str = "<think>";
        const CLOSE: &str = "</think>";
        self.buf.push_str(s);
        let mut out = String::new();
        loop {
            if self.in_think {
                if let Some(i) = self.buf.find(CLOSE) {
                    self.buf.drain(..i + CLOSE.len());
                    self.in_think = false;
                } else {
                    let keep = partial_suffix(&self.buf, CLOSE);
                    let cut = self.buf.len() - keep;
                    self.buf.drain(..cut);
                    break;
                }
            } else if let Some(i) = self.buf.find(OPEN) {
                out.push_str(&self.buf[..i]);
                self.buf.drain(..i + OPEN.len());
                self.in_think = true;
            } else {
                let keep = partial_suffix(&self.buf, OPEN);
                let cut = self.buf.len() - keep;
                out.push_str(&self.buf[..cut]);
                self.buf.drain(..cut);
                break;
            }
        }
        out
    }

    fn finish(&mut self) -> String {
        if self.in_think {
            self.buf.clear();
            String::new()
        } else {
            std::mem::take(&mut self.buf)
        }
    }
}

/// 每次 ai_start / ai_stop 都会让它加一；后台线程发现自己的编号过期了就悄悄退出
static AI_GEN: AtomicU64 = AtomicU64::new(0);

fn emit_ai(app: &AppHandle, gen: u64, payload: Value) {
    if AI_GEN.load(Ordering::SeqCst) == gen {
        let _ = app.emit("ai-event", payload);
    }
}

/// 一段增量文字里取出文本：流式是 choices[0].delta.content，非流式是 choices[0].message.content
fn content_of(v: &Value) -> Option<String> {
    v.pointer("/choices/0/delta/content")
        .or_else(|| v.pointer("/choices/0/message/content"))
        .or_else(|| v.pointer("/choices/0/text"))
        .and_then(|c| c.as_str())
        .map(|s| s.to_string())
}

fn error_of(v: &Value) -> Option<String> {
    let e = v.get("error")?;
    Some(
        e.get("message")
            .and_then(|m| m.as_str())
            .map(|s| s.to_string())
            .or_else(|| e.as_str().map(|s| s.to_string()))
            .unwrap_or_else(|| e.to_string()),
    )
}

/// 把模型吐出来的增量文字整理后发给前端：滤掉 <think>、去掉开头的空白
struct AiSink<'a> {
    emit: &'a mut dyn FnMut(Value),
    filter: ThinkFilter,
    started: bool,
    any: bool,
}

impl AiSink<'_> {
    fn out(&mut self, text: String) {
        let text = if self.started { text } else { text.trim_start().to_string() };
        if text.is_empty() {
            return;
        }
        self.started = true;
        self.any = true;
        (self.emit)(json!({ "type": "chunk", "text": text }));
    }

    fn feed(&mut self, text: &str) {
        let visible = self.filter.push(text);
        self.out(visible);
    }

    fn finish(&mut self) {
        let tail = self.filter.finish();
        self.out(tail);
    }
}

/// 调用 /chat/completions 并把流式结果逐段交给 `emit`（chunk / done / error）。
/// `cancelled` 为真时悄悄退出（用户点了停止）。和 Tauri 无关，所以可以单独测试。
fn stream_chat(cfg: &AiCfg, body: &Value, cancelled: &dyn Fn() -> bool, emit: &mut dyn FnMut(Value)) {
    let resp = match prepare_request(cfg, true).send_json(body) {
        Ok(r) => r,
        Err(e) => {
            emit(json!({ "type": "error", "message": describe_error(e) }));
            return;
        }
    };

    let mut sink = AiSink { emit, filter: ThinkFilter::default(), started: false, any: false };
    let mut raw = String::new(); // 不是 SSE（服务端没按流式返回）时，把整段 JSON 攒起来
    let reader = BufReader::new(resp.into_reader());
    for line in reader.lines() {
        if cancelled() {
            return;
        }
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                (sink.emit)(json!({ "type": "error", "message": format!("读取模型输出时中断：{e}") }));
                return;
            }
        };
        let t = line.trim();
        if t.is_empty() || t.starts_with(':') || t.starts_with("event:") || t.starts_with("id:") {
            continue;
        }
        if let Some(payload) = t.strip_prefix("data:") {
            let payload = payload.trim();
            if payload == "[DONE]" {
                break;
            }
            let Ok(v) = serde_json::from_str::<Value>(payload) else { continue };
            if let Some(msg) = error_of(&v) {
                (sink.emit)(json!({ "type": "error", "message": format!("模型返回错误：{msg}") }));
                return;
            }
            if let Some(text) = content_of(&v) {
                sink.feed(&text);
            }
        } else if raw.len() < 256 * 1024 {
            raw.push_str(t);
            raw.push('\n');
        }
    }
    if cancelled() {
        return;
    }
    if !sink.any && !raw.trim().is_empty() {
        // 服务端忽略了 stream:true，直接给了完整 JSON
        if let Ok(v) = serde_json::from_str::<Value>(raw.trim()) {
            if let Some(msg) = error_of(&v) {
                (sink.emit)(json!({ "type": "error", "message": format!("模型返回错误：{msg}") }));
                return;
            }
            if let Some(text) = content_of(&v) {
                sink.feed(&text);
            }
        }
    }
    sink.finish();
    if !sink.any {
        (sink.emit)(json!({ "type": "error", "message": "模型没有返回任何内容。请确认模型名正确，并且这个接口支持 /chat/completions" }));
        return;
    }
    (sink.emit)(json!({ "type": "done" }));
}

fn run_ai(app: AppHandle, cfg: AiCfg, gen: u64, message: String, images: Vec<ImageRef>) {
    let body = json!({
        "model": cfg.model,
        "stream": true,
        "temperature": cfg.temperature,
        "messages": [
            { "role": "system", "content": system_prompt() },
            { "role": "user", "content": build_user_content(&message, &images) },
        ],
    });
    stream_chat(
        &cfg,
        &body,
        &|| AI_GEN.load(Ordering::SeqCst) != gen,
        &mut |payload| emit_ai(&app, gen, payload),
    );
}

#[tauri::command]
fn ai_start(
    app: AppHandle,
    message: String,
    images: Option<Vec<ImageRef>>,
) -> Result<Value, String> {
    let images = images.unwrap_or_default();
    let cfg = ai_cfg_from(&read_settings());
    if cfg.model.is_empty() {
        return Err("还没配置模型名，请先在设置里填写".into());
    }
    if message.trim().is_empty() {
        return Err("没有可以发给 AI 的内容".into());
    }
    let gen = AI_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || run_ai(app, cfg, gen, message, images));
    Ok(json!({ "ok": true }))
}

#[tauri::command]
fn ai_stop(app: AppHandle) -> Value {
    AI_GEN.fetch_add(1, Ordering::SeqCst);
    let _ = app.emit("ai-event", json!({ "type": "stopped" }));
    json!({ "ok": true })
}

/// 测试连接：用表单里还没保存的值发一个很小的非流式请求
#[tauri::command]
async fn ai_test(settings: Value) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = ai_cfg_from(&settings);
        if cfg.model.is_empty() {
            return Err("请先填写模型名".to_string());
        }
        let body = json!({
            "model": cfg.model,
            "stream": false,
            "max_tokens": 16,
            "temperature": 0,
            "messages": [{ "role": "user", "content": "回复“ok”两个字母即可。" }],
        });
        let resp = prepare_request(&cfg, false).send_json(&body).map_err(describe_error)?;
        let v: Value = resp.into_json().map_err(|e| format!("接口返回的不是 JSON：{e}"))?;
        if let Some(msg) = error_of(&v) {
            return Err(format!("模型返回错误：{msg}"));
        }
        if v.get("choices").map(|c| c.is_array()).unwrap_or(false) {
            Ok(json!({ "ok": true, "message": "连接成功，模型已响应" }))
        } else {
            Err("接口有响应，但格式不像 OpenAI（缺少 choices），请检查 Base URL".to_string())
        }
    })
    .await
    .map_err(|e| format!("测试线程异常：{e}"))?
}

// ---------- 窗口外观 ----------
/// 前端把 CSS 里的窗口描边样式送进来：`--win-stroke-color`（颜色）与
/// `--win-stroke-size`（线粗，CSS 像素）。Rust 读不到 CSS，所以只能这么传。
/// 解析失败会静默沿用当前值 —— 描边是纯装饰，不该因为它让启动失败。
#[tauri::command]
fn frame_set_style(color: String, size: String) {
    #[cfg(target_os = "windows")]
    crate::rounded_frame::set_style(&color, &size);
    #[cfg(not(target_os = "windows"))]
    let _ = (color, size);
}

/// Windows 11 会在窗口矩形外缘画一圈强调色边框，
/// 通过 DWMWA_BORDER_COLOR = DWMWA_COLOR_NONE 抑制它，让圆角窗口干净呈现。
#[cfg(target_os = "windows")]
fn suppress_accent_border(window: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_BORDER_COLOR};
    const DWMWA_COLOR_NONE: u32 = 0xFFFF_FFFE;
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let _ = DwmSetWindowAttribute(
                HWND(hwnd.0 as *mut core::ffi::c_void),
                DWMWA_BORDER_COLOR,
                &DWMWA_COLOR_NONE as *const u32 as *const core::ffi::c_void,
                std::mem::size_of::<u32>() as u32,
            );
        }
    }
}

// ---------- 入口 ----------
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebView2 缺失时窗口能建出来但内容渲染不出来 —— 用户只会看到一个白屏。
    // 所以先检测，缺了就显示原生说明窗口（不依赖 WebView2），然后退出。
    #[cfg(target_os = "windows")]
    if crate::webview2_gate::force_missing() || !crate::webview2_gate::webview2_installed() {
        crate::webview2_gate::show_missing_gate();
        return;
    }

    let builder = tauri::Builder::default();
    #[cfg(target_os = "windows")]
    let builder = builder.manage(window_placement::State::new());
    let built = builder
        .setup(|app| {
            #[cfg(target_os = "windows")]
            if let Some(win) = app.get_webview_window("main") {
                let placement_state = app.state::<window_placement::State>().inner().clone();
                window_placement::restore(&win, &placement_state);
                // 不透明窗口：把 WebView2 默认白底换成应用底色（深炭灰），消除启动白闪
                let _ = win.set_background_color(Some(tauri::webview::Color(22, 22, 24, 255)));
                suppress_accent_border(&win);
                crate::rounded_frame::apply_rounded_corners(&win);
                let win2 = win.clone();
                win.on_window_event(move |event| match event {
                    tauri::WindowEvent::Resized(_) => {
                        crate::rounded_frame::apply_rounded_corners(&win2);
                        placement_state.changed(&win2);
                    }
                    tauri::WindowEvent::Moved(_) => {
                        placement_state.changed(&win2);
                    }
                    tauri::WindowEvent::CloseRequested { .. } => {
                        placement_state.save(&win2);
                    }
                    _ => {}
                });
                let _ = win.show();
            }
            #[cfg(not(target_os = "windows"))]
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_settings,
            doc_get,
            doc_save,
            doc_new,
            doc_open,
            doc_delete,
            doc_export,
            asset_add,
            asset_data,
            asset_rename,
            asset_remove,
            asset_thumb,
            asset_read_path,
            asset_add_ref,
            pick_images,
            file_read,
            ai_test,
            ai_start,
            ai_stop,
            frame_set_style,
        ])
        .build(tauri::generate_context!());

    // 兜底：组件存在但 WebView 仍初始化失败（运行时损坏 / 被策略禁用）时，
    // 同样给原生提示，而不是抛 panic 或直接白屏。
    let app = match built {
        Ok(a) => a,
        Err(e) => {
            eprintln!("[分镜对照] 启动失败: {e}");
            #[cfg(target_os = "windows")]
            crate::webview2_gate::show_missing_gate();
            return;
        }
    };

    app.run(|_app_handle, _event| {});
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn think_filter_removes_think_block_across_chunks() {
        let mut f = ThinkFilter::default();
        let mut out = String::new();
        for piece in ["<thi", "nk>先想一想", "…</thi", "nk>\n\n镜头1｜全景", "｜雨夜"] {
            out.push_str(&f.push(piece));
        }
        out.push_str(&f.finish());
        assert_eq!(out.trim_start(), "镜头1｜全景｜雨夜");
    }

    #[test]
    fn think_filter_keeps_plain_text_and_lone_angle() {
        let mut f = ThinkFilter::default();
        let mut out = f.push("a < b 且 <ok> 保留");
        out.push_str(&f.finish());
        assert_eq!(out, "a < b 且 <ok> 保留");
    }

    #[test]
    fn chat_url_is_built_once() {
        assert_eq!(chat_url("https://x.com/v1/"), "https://x.com/v1/chat/completions");
        assert_eq!(chat_url("https://x.com/v1/chat/completions"), "https://x.com/v1/chat/completions");
    }

    #[test]
    fn title_falls_back_to_first_script_line() {
        let d = Doc { script: "\n  第一场　雨夜\n夜，大雨".into(), ..Default::default() };
        assert_eq!(doc_title(&d), "第一场　雨夜");
        let e = Doc::default();
        assert_eq!(doc_title(&e), "未命名分镜稿");
    }

    #[test]
    fn file_stem_drops_illegal_chars() {
        assert_eq!(safe_file_stem("a/b:c*?"), "a_b_c__");
        assert_eq!(safe_file_stem("  ..  "), "分镜稿");
    }

    #[test]
    fn http_error_text_picks_message() {
        let t = http_error_text(401, r#"{"error":{"message":"bad key"}}"#);
        assert!(t.contains("401") && t.contains("bad key"));
    }

    #[test]
    fn asset_names_are_clean_and_unique() {
        assert_eq!(clean_asset_name("  男主 @林舟/正面.png "), "男主__林舟_正面.png");
        assert_eq!(clean_asset_name("@@"), "图片");
        assert_eq!(clean_asset_name(&"长".repeat(40)).chars().count(), 20);
        let a = |id: &str, name: &str| Asset { id: id.into(), name: name.into(), mime: "image/png".into(), path: String::new() };
        let existing = vec![a("1", "林舟"), a("2", "林舟_2")];
        assert_eq!(unique_asset_name("林舟", &existing, None), "林舟_3");
        assert_eq!(unique_asset_name("林舟", &existing, Some("1")), "林舟"); // 改名时不和自己冲突
        assert_eq!(unique_asset_name("老板", &existing, None), "老板");
    }

    #[test]
    fn data_url_parsing_checks_mime_and_base64() {
        let (mime, bytes) = parse_data_url("data:image/png;base64,aGVsbG8=").unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(bytes, b"hello");
        assert!(parse_data_url("data:text/plain;base64,aGVsbG8=").is_err());
        assert!(parse_data_url("data:image/png,aGVsbG8=").is_err());
        assert!(parse_data_url("not a data url").is_err());
    }

    #[test]
    fn user_content_is_plain_text_or_multimodal() {
        assert!(build_user_content("消息", &[]).is_string());
        let imgs = vec![ImageRef { name: "林舟".into(), data_url: "data:image/png;base64,AAAA".into() }];
        let v = build_user_content("消息 @林舟", &imgs);
        let arr = v.as_array().unwrap();
        assert_eq!(arr.len(), 3);
        assert_eq!(arr[0]["type"], "text");
        assert_eq!(arr[1]["text"], "参考图1（林舟）：");
        assert_eq!(arr[2]["image_url"]["url"], "data:image/png;base64,AAAA");
    }

    #[test]
    fn old_single_settings_become_one_default_preset() {
        let old = json!({ "baseUrl": "http://x/v1", "model": "m", "apiKey": "k", "temperature": 0.5 });
        let out = settings_json(&old);
        assert_eq!(out["presets"].as_array().unwrap().len(), 1);
        assert_eq!(out["activePreset"], "default");
        assert_eq!(out["model"], "m");
    }

    #[test]
    fn presets_mirror_the_active_one_to_top_level() {
        let v = json!({
            "presets": [
                { "id": "a", "name": "本地", "baseUrl": "http://l/v1", "model": "q", "apiKey": "", "temperature": 0.2 },
                { "id": "b", "name": "在线", "baseUrl": "https://o/v1", "model": "g", "apiKey": "sk", "temperature": 0.7 },
            ],
            "activePreset": "b",
        });
        let out = settings_json(&v);
        assert_eq!(out["baseUrl"], "https://o/v1");
        assert_eq!(out["apiKey"], "sk");
        assert_eq!(out["activePreset"], "b");
        // 指向不存在的预设时退回第一个
        let v2 = json!({ "presets": v["presets"].clone(), "activePreset": "zzz" });
        assert_eq!(settings_json(&v2)["activePreset"], "a");
    }

    #[test]
    fn default_system_prompt_carries_the_skill() {
        assert!(DEFAULT_SYSTEM_PROMPT.contains("W.分镜脚本大师"));
        assert!(DEFAULT_SYSTEM_PROMPT.contains("本应用的调用约定"));
    }

    #[test]
    fn old_board_text_migrates_into_one_block() {
        let old: StoreFile = serde_json::from_str(
            r#"{"currentId":"a","docs":[{"id":"a","title":"t","script":"s","board":"镜头1｜全景","optimized":"","updatedAt":1}]}"#,
        )
        .unwrap();
        let mut d = old.docs[0].clone();
        assert!(d.blocks.is_empty() && !d.board.is_empty());
        d.blocks.push(Block { id: "b1".into(), title: String::new(), text: std::mem::take(&mut d.board), link: None, optimized: String::new() });
        assert_eq!(d.blocks[0].text, "镜头1｜全景");
        let out = serde_json::to_value(&d).unwrap();
        assert!(out.get("board").is_none(), "迁移后不再写出 board");
        assert_eq!(out["blocks"][0]["text"], "镜头1｜全景");
    }

    #[test]
    fn board_markdown_lists_blocks_and_links() {
        let d = Doc {
            blocks: vec![
                Block { id: "1".into(), title: "冲出峡口".into(), text: "镜头01".into(), link: Some(ScriptLink { quote: "q".into(), nth: 0, preview: "866沿着旧路".into() }), optimized: String::new() },
                Block { id: "2".into(), title: String::new(), text: "镜头02".into(), link: None, optimized: String::new() },
            ],
            ..Default::default()
        };
        let md = board_markdown(&d);
        assert!(md.contains("### 01 冲出峡口"));
        assert!(md.contains("> 对应剧本：866沿着旧路"));
        assert!(md.contains("### 02\n\n镜头02"));
        assert_eq!(board_markdown(&Doc::default()), "（空）");
    }

    #[test]
    fn temperature_is_clamped() {
        assert_eq!(parse_temperature(Some(&json!(5))), 2.0);
        assert_eq!(parse_temperature(Some(&json!("0.7"))), 0.7);
        assert_eq!(parse_temperature(None), DEFAULT_TEMPERATURE);
    }

    // ---- 用本地假服务器验证流式解析（不需要真实 Key）----
    use std::io::Write as _;
    use std::net::TcpListener;

    fn serve_once(response: String) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut sock, _)) = listener.accept() {
                // 把请求（头 + 按 Content-Length 的正文）读完再回复，否则客户端还在发送时就被关连接
                let mut data: Vec<u8> = Vec::new();
                let mut buf = [0u8; 4096];
                loop {
                    let n = sock.read(&mut buf).unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    data.extend_from_slice(&buf[..n]);
                    if let Some(end) = data.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&data[..end]).to_lowercase();
                        let len = head
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                            .unwrap_or(0);
                        if data.len() >= end + 4 + len {
                            break;
                        }
                    }
                }
                let _ = sock.write_all(response.as_bytes());
            }
        });
        format!("http://127.0.0.1:{port}/v1")
    }

    fn http_ok(content_type: &str, body: &str) -> String {
        format!("HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nConnection: close\r\n\r\n{body}")
    }

    fn cfg_for(base: String) -> AiCfg {
        AiCfg { base_url: base, model: "m".into(), api_key: "k".into(), temperature: 0.3 }
    }

    fn collect(cfg: &AiCfg) -> Vec<Value> {
        let mut events = Vec::new();
        let body = json!({"model": "m", "stream": true, "messages": []});
        stream_chat(cfg, &body, &|| false, &mut |p| events.push(p));
        events
    }

    #[test]
    fn streams_sse_and_strips_think() {
        let sse = [
            r#"data: {"choices":[{"delta":{"content":"<think>想"}}]}"#,
            r#"data: {"choices":[{"delta":{"content":"想</think>\n\n镜头1｜全"}}]}"#,
            r#"data: {"choices":[{"delta":{"content":"景｜雨夜"}}]}"#,
            "data: [DONE]",
        ]
        .join("\n\n")
            + "\n\n";
        let resp = http_ok("text/event-stream", &sse);
        let events = collect(&cfg_for(serve_once(resp)));
        let text: String = events.iter().filter(|e| e["type"] == "chunk").map(|e| e["text"].as_str().unwrap()).collect();
        assert_eq!(text, "镜头1｜全景｜雨夜");
        assert_eq!(events.last().unwrap()["type"], "done");
    }

    #[test]
    fn falls_back_to_plain_json_when_server_ignores_stream() {
        let json_body = r#"{"choices":[{"message":{"content":"镜头1｜全景"}}]}"#;
        let resp = http_ok("application/json", json_body);
        let events = collect(&cfg_for(serve_once(resp)));
        let text: String = events.iter().filter(|e| e["type"] == "chunk").map(|e| e["text"].as_str().unwrap()).collect();
        assert_eq!(text, "镜头1｜全景");
        assert_eq!(events.last().unwrap()["type"], "done");
    }

    #[test]
    fn reports_http_401_in_chinese() {
        let body = r#"{"error":{"message":"invalid api key"}}"#;
        let resp = format!(
            "HTTP/1.1 401 Unauthorized
Content-Type: application/json
Content-Length: {}
Connection: close

{body}",
            body.len()
        );
        let events = collect(&cfg_for(serve_once(resp)));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["type"], "error");
        let msg = events[0]["message"].as_str().unwrap();
        assert!(msg.contains("401") && msg.contains("API Key"), "{msg}");
    }

    #[test]
    fn reports_connection_refused() {
        // 端口 1 基本不会有服务
        let events = collect(&cfg_for("http://127.0.0.1:1/v1".into()));
        assert_eq!(events[0]["type"], "error");
        assert!(events[0]["message"].as_str().unwrap().contains("无法连接"));
    }
}

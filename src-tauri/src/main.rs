// ai-office/src-tauri/src/main.rs
// AI Office 桌面端外壳(Tauri 2):
//   - dev 模式:直接加载 tauri.conf.json 中的 devUrl(Vite 5173),beforeDevCommand 已起 Vite+Node
//   - prod 模式:动态端口拉起 node dist/server.js(传 AI_OFFICE_STATIC=dist-web),窗口加载该地址
//   - pick_workspace_dir:原生目录选择器,前端点击「打开文件夹」时调用
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
#[cfg(not(debug_assertions))]
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
#[cfg(not(debug_assertions))]
use std::time::{Duration, Instant};

use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

/// 后端 Node 服务子进程(仅 prod 模式使用;应用退出时清理)
#[cfg(not(debug_assertions))]
struct ServerProcess(Mutex<Option<Child>>);
#[cfg(debug_assertions)]
struct ServerProcess(Mutex<Option<()>>);

/// 原生目录选择器:返回用户选中的目录绝对路径(取消则 None)
/// 注意必须为 async:Tauri 同步命令跑在主线程,blocking 对话框会死锁导致界面卡死
#[tauri::command]
async fn pick_workspace_dir(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let picked = app.dialog().file().blocking_pick_folder();
    Ok(picked.and_then(|p| p.into_path().ok()).map(|x| x.to_string_lossy().to_string()))
}

/// 获取一个随机空闲端口(bind 后立即释放,供后端服务监听)
#[cfg(not(debug_assertions))]
fn free_port() -> u16 {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
        .unwrap_or(3001)
}

/// 解析可用的 node 可执行文件。
/// 背景:App 从 Finder/launchd/资源管理器启动时,进程 PATH 极简,
/// 直接 Command::new("node") 会 ENOENT 导致 setup 失败崩溃,必须先定位真实 node 路径。
/// 优先级:
///   1. AI_OFFICE_NODE 环境变量(显式指定,调试用)
///   2. 打包进 bundle 的 node(resources/runtime/node;项目树直跑时在 src-tauri/resources/runtime/node)
///   3. PATH 搜索 node
///   4. 常见安装位置(homebrew / Program Files / nvm / fnm / volta / asdf)
#[cfg(not(debug_assertions))]
fn resolve_node(res_dir: &PathBuf) -> Option<PathBuf> {
    fn is_exec(p: &Path) -> bool {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::metadata(p)
                .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
        }
        #[cfg(windows)]
        {
            // Windows 无 exec 位,文件存在即视为可执行
            std::fs::metadata(p).map(|m| m.is_file()).unwrap_or(false)
        }
    }
    let node_bin = if cfg!(windows) { "node.exe" } else { "node" };

    // 1) 显式指定
    if let Ok(n) = std::env::var("AI_OFFICE_NODE") {
        let p = PathBuf::from(&n);
        if is_exec(&p) {
            return Some(p);
        }
    }

    // 2) bundle 内置 node(优先,自包含)
    for p in [
        res_dir.join(format!("runtime/{node_bin}")),
        res_dir.join(format!("src-tauri/resources/runtime/{node_bin}")),
    ] {
        if is_exec(&p) {
            return Some(p);
        }
    }

    // 3) PATH 搜索
    if let Some(p) = std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(node_bin))
            .find(|p| is_exec(p))
    }) {
        return Some(p);
    }

    // 4) 常见安装位置
    let mut candidates: Vec<PathBuf> = Vec::new();
    #[cfg(windows)]
    {
        // 官方安装包默认路径:%ProgramFiles%\nodejs\node.exe
        for pf in [std::env::var_os("ProgramFiles"), std::env::var_os("ProgramFiles(x86)")]
            .into_iter()
            .flatten()
        {
            candidates.push(PathBuf::from(pf).join("nodejs").join(node_bin));
        }
        // nvm-windows:%NVM_HOME% 或 %APPDATA%\nvm\v*/node.exe(取版本最高)
        let nvm_home = std::env::var_os("NVM_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("nvm")));
        if let Some(nvm_home) = nvm_home {
            let mut versions: Vec<PathBuf> = std::fs::read_dir(&nvm_home)
                .map(|entries| {
                    entries
                        .filter_map(|e| e.ok())
                        .map(|e| e.path().join(node_bin))
                        .filter(|p| is_exec(p))
                        .collect()
                })
                .unwrap_or_default();
            versions.sort();
            candidates.extend(versions);
        }
        // volta:%LOCALAPPDATA%\Volta\bin\node.exe
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(PathBuf::from(local).join("Volta/bin").join(node_bin));
        }
    }
    #[cfg(unix)]
    {
        candidates.extend([
            "/opt/homebrew/bin/node".into(),
            "/usr/local/bin/node".into(),
            "/usr/bin/node".into(),
        ]);
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            // nvm:~/.nvm/versions/node/v*/bin/node(取版本最高)
            let mut versions: Vec<PathBuf> = std::fs::read_dir(home.join(".nvm/versions/node"))
                .map(|entries| {
                    entries
                        .filter_map(|e| e.ok())
                        .map(|e| e.path().join("bin/node"))
                        .filter(|p| is_exec(p))
                        .collect()
                })
                .unwrap_or_default();
            versions.sort();
            candidates.extend(versions);
            // fnm:~/.local/share/fnm/node-versions/*/installation/bin/node
            let mut fnm_versions: Vec<PathBuf> =
                std::fs::read_dir(home.join(".local/share/fnm/node-versions"))
                    .map(|entries| {
                        entries
                            .filter_map(|e| e.ok())
                            .map(|e| e.path().join("installation/bin/node"))
                            .filter(|p| is_exec(p))
                            .collect()
                    })
                    .unwrap_or_default();
            fnm_versions.sort();
            candidates.extend(fnm_versions);
            candidates.extend([home.join(".volta/bin/node"), home.join(".asdf/shims/node")]);
        }
    }
    candidates.into_iter().find(|p| is_exec(p))
}

/// 应用根目录(仅用于从项目树直接运行二进制时的兼容回退):
///   - exe 在 <ai-office>/src-tauri/target/<profile>/
///   - 向上 3 级 → <ai-office>/
#[cfg(not(debug_assertions))]
fn app_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("../../..")
}

/// 后端运行时资源目录:
///   - 打包安装:优先用 bundle 内的 Contents/Resources/resources(dist + dist-web + node_modules)
///   - 项目树直跑(release 二进制在 target/<profile>/ 下):回退到项目根,直接读 dist/ 与 dist-web/
#[cfg(not(debug_assertions))]
fn runtime_dir(app: &tauri::App) -> PathBuf {
    app.path()
        .resource_dir()
        .map(|d| d.join("resources"))
        .unwrap_or_else(|_| app_dir())
}

/// prod 模式:启动后端 Node 服务子进程
/// 传 AI_OFFICE_STATIC=dist-web 让后端启用静态文件 + SPA 回退服务
/// AI_OFFICE_SERVER_ENTRY / AI_OFFICE_NODE 环境变量可覆盖默认入口(调试用)
#[cfg(not(debug_assertions))]
fn spawn_server(
    port: u16,
    res_dir: &PathBuf,
    env_dir: Option<String>,
    data_dir: Option<String>,
) -> Result<Child, String> {
    // 解析 node 真实路径:优先 bundle 内置,其次 PATH/常见安装位置(GUI 启动环境 PATH 极简,不能直接写死 "node")
    let node = resolve_node(res_dir)
        .ok_or_else(|| "找不到 node 运行时:请安装 Node.js(≥18),或设置 AI_OFFICE_NODE 指定 node 路径".to_string())?;
    let node_str = node.to_string_lossy().to_string();
    let entry = std::env::var("AI_OFFICE_SERVER_ENTRY")
        .unwrap_or_else(|_| res_dir.join("dist/server.js").to_string_lossy().to_string());
    let static_dir = res_dir.join("dist-web").to_string_lossy().to_string();
    let mut cmd = Command::new(&node_str);
    cmd.arg(&entry)
        .current_dir(res_dir)
        .env("PORT", port.to_string())
        .env("AI_OFFICE_STATIC", static_dir)
        .env("NODE_ENV", "production");
    // 打包运行:.env 不在 dist/ 上层,改从宿主配置目录加载(见 loadEnv.ts)
    if let Some(ed) = env_dir {
        cmd.env("AI_OFFICE_ENV_DIR", ed);
    }
    // 可写数据目录:工作区、状态文件等不能放在只读的 bundle 资源目录内
    if let Some(dd) = data_dir {
        cmd.env("AI_OFFICE_DATA_DIR", dd);
    }
    // GUI(launchd/资源管理器)启动环境 PATH 极简:补上 node 所在目录与常见 bin 目录,
    // 保证后端内部再 spawn officecli / 其他子进程时也能按名解析
    let mut path_dirs: Vec<PathBuf> = Vec::new();
    if let Some(dir) = node.parent() {
        path_dirs.push(dir.to_path_buf());
    }
    #[cfg(windows)]
    if let Some(system) = std::env::var_os("SystemRoot") {
        path_dirs.push(PathBuf::from(system).join("System32"));
    }
    #[cfg(unix)]
    {
        path_dirs.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
        ]);
    }
    if let Ok(cur) = std::env::var("PATH") {
        path_dirs.extend(std::env::split_paths(&cur));
    }
    path_dirs.dedup();
    cmd.env(
        "PATH",
        std::env::join_paths(&path_dirs).unwrap_or_else(|_| {
            let sep = if cfg!(windows) { ";" } else { ":" };
            path_dirs
                .iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join(sep)
                .into()
        }),
    );
    cmd.stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("启动后端服务失败(node={node_str}, entry={entry}): {e}"))
}

/// 轮询等待后端服务端口就绪(prod 模式)
#[cfg(not(debug_assertions))]
fn wait_ready(port: u16, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    loop {
        if std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok() {
            return Ok(());
        }
        if Instant::now() > deadline {
            return Err(format!("等待后端服务就绪超时(port={port})"));
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

fn main() {
    tauri::Builder::default()
        .manage(ServerProcess(Mutex::new(None)))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![pick_workspace_dir])
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                // dev 模式:beforeDevCommand 已拉起 Vite(5173) + Node(3001)
                // tauri.conf.json 的 devUrl 已经告诉 Tauri 默认窗口加载 localhost:5173
                // 这里只是再手动显式创建一次主窗口,统一窗口名/大小/标题
                let dev_url: tauri::Url = "http://127.0.0.1:5173"
                    .parse()
                    .expect("invalid dev url");
                tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(dev_url))
                    .title("AI Office")
                    .inner_size(1280.0, 820.0)
                    .min_inner_size(960.0, 640.0)
                    .build()?;
            }

            #[cfg(not(debug_assertions))]
            {
                // prod 模式:动态端口起 Node 服务,窗口直接加载 http://127.0.0.1:<port>(同源,零 CORS)
                let port = free_port();
                let res_dir = runtime_dir(app);
                // .env 兜底位置:用户配置目录(~/Library/Application Support/com.aipack.aioffice)
                let env_dir = app
                    .path()
                    .app_config_dir()
                    .map(|d| d.to_string_lossy().to_string())
                    .ok();
                // 可写数据目录:工作区、状态文件等放到用户目录,不能写只读的安装目录
                let data_dir = app.path().app_data_dir().ok().and_then(|d| {
                    std::fs::create_dir_all(&d).ok()?;
                    Some(d.to_string_lossy().to_string())
                });
                let child = spawn_server(port, &res_dir, env_dir, data_dir).map_err(std::io::Error::other)?;
                *app.state::<ServerProcess>().0.lock().unwrap() = Some(child);
                wait_ready(port, Duration::from_secs(30)).map_err(std::io::Error::other)?;

                let url: tauri::Url = format!("http://127.0.0.1:{port}").parse().unwrap();
                tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(url))
                    .title("AI Office")
                    .inner_size(1280.0, 820.0)
                    .min_inner_size(960.0, 640.0)
                    .build()?;
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败,请检查 src-tauri/ 配置")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                // 退出时,清理可能运行的 Node 后端子进程(prod 模式持有)
                #[cfg(not(debug_assertions))]
                if let Some(mut child) = app_handle.state::<ServerProcess>().0.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}

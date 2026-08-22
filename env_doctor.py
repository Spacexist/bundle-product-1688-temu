#!/usr/bin/env python3
"""Standalone environment doctor for the local Auto Bundle workbench."""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


DEFAULT_PORTS = [3000, 5173, 9990]
NODE_MODULE_REPAIR_PACKAGES = ["vite", "@vitejs/plugin-vue", "esbuild", "@esbuild/win32-x64"]
GPU_RUNTIME_PATTERNS = [
    "*cublas64_*.dll",
    "*cublasLt64_*.dll",
    "*cudart64_*.dll",
    "*cudnn*.dll",
    "*cufft64_*.dll",
    "*curand64_*.dll",
    "*cusolver64_*.dll",
    "*cusparse64_*.dll",
    "*nvrtc*.dll",
    "*nvjpeg*.dll",
    "*torch_cuda.dll",
]


def print_line(level: str, message: str) -> None:
    """Print one compact status line that is readable in cmd.exe."""
    print(f"[{level}] {message}", flush=True)


def resolve_project_root(argument: str) -> Path:
    """Resolve the project root from an explicit argument or this script path."""
    if argument:
        return Path(argument).resolve()
    executable_path = Path(sys.argv[0]).resolve()
    direct_root = executable_path.parent
    if (direct_root / "package.json").exists() and (direct_root / "server").exists():
        return direct_root
    return executable_path.parents[2]


def load_json(path: Path) -> dict[str, Any]:
    """Read one JSON object from disk and return an empty object on missing files."""
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError(f"{path} is not a JSON object.")
    return payload


def write_json(path: Path, payload: dict[str, Any]) -> None:
    """Write one JSON object with stable indentation."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def merge_missing_values(current: dict[str, Any], defaults: dict[str, Any]) -> bool:
    """Copy missing default keys into current without overwriting existing values."""
    changed = False
    for key, value in defaults.items():
        if key not in current:
            current[key] = value
            changed = True
            continue
        if isinstance(current[key], dict) and isinstance(value, dict):
            changed = merge_missing_values(current[key], value) or changed
    return changed


def require_file(path: Path, label: str) -> None:
    """Raise a clear error when a required file does not exist."""
    if not path.exists():
        raise FileNotFoundError(f"{label} missing: {path}")
    print_line("OK", f"{label}: {path}")


def require_nonempty_file(path: Path, label: str) -> None:
    """Raise a clear error when a required runtime file is missing or empty."""
    if not path.exists():
        raise FileNotFoundError(f"{label} missing: {path}")
    size = path.stat().st_size
    if size <= 0:
        raise ValueError(f"{label} is empty: {path}")
    print_line("OK", f"{label}: {path} ({format_bytes(size)})")


def format_bytes(size: int) -> str:
    """Format one file size for compact diagnostics."""
    value = float(size)
    for unit in ["B", "KB", "MB", "GB"]:
        if value < 1024 or unit == "GB":
            return f"{value:.1f} {unit}" if unit != "B" else f"{int(value)} B"
        value /= 1024
    return f"{size} B"


def resolve_node_executable(project_root: Path) -> Path | str:
    """Return the bundled Node executable when present, otherwise system node."""
    bundled = project_root / "runtime" / "node" / "node.exe"
    if bundled.exists():
        return bundled
    return "node"


def resolve_npm_command(project_root: Path) -> Path | str:
    """Return the bundled npm command when present, otherwise system npm."""
    bundled = project_root / "runtime" / "node" / "npm.cmd"
    if bundled.exists():
        return bundled
    return "npm"


def verify_npm_runtime(project_root: Path) -> list[str]:
    """Return missing files from the bundled npm runtime used for automatic repair."""
    required = [
        project_root / "runtime" / "node" / "npm.cmd",
        project_root / "runtime" / "node" / "node_modules" / "npm" / "bin" / "npm-cli.js",
        project_root / "runtime" / "node" / "node_modules" / "npm" / "bin" / "npm-prefix.js",
    ]
    return [str(path) for path in required if not path.exists()]


def run_checked(command: list[str], cwd: Path) -> None:
    """Run one repair command and fail fast when it exits unsuccessfully."""
    printable = " ".join(f'"{part}"' if " " in part else part for part in command)
    print_line("RUN", printable)
    completed = subprocess.run(command, cwd=str(cwd), shell=False)
    if completed.returncode != 0:
        raise RuntimeError(f"Command failed with exit code {completed.returncode}: {printable}")


def verify_node_modules(project_root: Path) -> list[str]:
    """Return missing npm modules by asking the bundled Node resolver directly."""
    node_command = str(resolve_node_executable(project_root))
    probe_code = """
const modules = ["express", "cors", "zod", "vue", "vite", "@vitejs/plugin-vue", "content-type", "type-is", "media-typer", "mime-types"];
const missing = [];
for (const name of modules) {
  try {
    require.resolve(name, { paths: [process.cwd()] });
  } catch (error) {
    missing.push(name + " -> " + error.message);
  }
}
if (missing.length) {
  console.error(missing.join("\\n"));
  process.exit(2);
}
console.log("node module resolver ok");
"""
    completed = subprocess.run(
        [node_command, "-e", probe_code],
        cwd=str(project_root),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        shell=False,
    )
    if completed.returncode == 0:
        missing_files = verify_node_module_files(project_root)
        if not missing_files:
            return []
        return missing_files
    detail = (completed.stderr or completed.stdout or "").strip()
    missing_modules = [line for line in detail.splitlines() if line.strip()]
    missing_modules.extend(verify_node_module_files(project_root))
    return missing_modules


def verify_node_module_files(project_root: Path) -> list[str]:
    """Return missing package files that require.resolve can miss after a bad ZIP."""
    required_files = [
        project_root / "node_modules" / "vite" / "dist" / "node" / "index.js",
        project_root / "node_modules" / "@vitejs" / "plugin-vue" / "dist" / "index.mjs",
        project_root / "node_modules" / "@esbuild" / "win32-x64" / "esbuild.exe",
    ]
    return ["file missing: " + str(path) for path in required_files if not path.exists()]


def resolve_node_module_package_directory(project_root: Path, package_name: str) -> Path:
    """Resolve one npm package name to its directory under node_modules."""
    node_modules = project_root / "node_modules"
    name = str(package_name or "").strip()
    if name.startswith("@") and "/" in name:
        scope, scoped_name = name.split("/", 1)
        return node_modules / scope / scoped_name
    return node_modules / name


def remove_incomplete_node_module_packages(project_root: Path) -> list[str]:
    """Remove known fragile frontend packages so npm install must lay them down again."""
    removed: list[str] = []
    node_modules = (project_root / "node_modules").resolve()
    for package_name in NODE_MODULE_REPAIR_PACKAGES:
        package_directory = resolve_node_module_package_directory(project_root, package_name).resolve()
        if not is_inside(node_modules, package_directory) or not package_directory.exists():
            continue
        shutil.rmtree(package_directory)
        removed.append(package_name)
    return removed


def resolve_configured_path(project_root: Path, value: Any, default_value: str) -> Path:
    """Resolve one configured path relative to the project when it is not absolute."""
    text = str(value or default_value).strip()
    candidate = Path(text)
    if candidate.is_absolute():
        return candidate.resolve()
    return (project_root / candidate).resolve()


def resolve_portable_configured_path(project_root: Path, value: Any, default_value: str, label: str) -> Path:
    """Resolve one portable bundle path and fall back when stale machine paths are configured."""
    configured_text = str(value or "").strip()
    default_path = (project_root / default_value).resolve()
    configured_path = resolve_configured_path(project_root, configured_text, default_value)
    if configured_text and not is_legacy_venv_python_command(configured_text) and configured_path.exists():
        return configured_path
    if configured_text and configured_path != default_path:
        print_line("WARN", f"Ignored stale {label}: {configured_path}; using {default_path}")
    return default_path


def is_legacy_venv_python_command(value: Any) -> bool:
    """Return whether one configured Python command points at the old non-portable venv launcher."""
    text = str(value or "").replace("\\", "/").lower()
    return text.endswith("bundle/python-cpu/scripts/python.exe") or "/bundle/python-cpu/scripts/python.exe" in text


def build_bundled_python_environment(clip_root: Path, extra: dict[str, str] | None = None) -> dict[str, str]:
    """Create child-process environment that lets portable Python import bundled site-packages."""
    environment = os.environ.copy()
    site_packages = clip_root.parent / "python-cpu" / "Lib" / "site-packages"
    existing_pythonpath = environment.get("PYTHONPATH", "")
    pythonpath_parts = [str(site_packages)]
    if existing_pythonpath:
        pythonpath_parts.append(existing_pythonpath)
    environment["PYTHONPATH"] = os.pathsep.join(pythonpath_parts)
    if extra:
        environment.update(extra)
    return environment


def repair_portable_workflow_paths(project_root: Path, config: dict[str, Any], defaults: dict[str, Any]) -> bool:
    """Reset CLIP bundle paths that would break after copying the project to another computer."""
    workflow = config.get("workflow") if isinstance(config.get("workflow"), dict) else {}
    default_workflow = defaults.get("workflow") if isinstance(defaults.get("workflow"), dict) else {}
    changed = False
    portable_keys = ["clip_project_directory", "clip_python_command"]
    for key in portable_keys:
        default_value = str(default_workflow.get(key, "")).strip()
        current_value = str(workflow.get(key, "")).strip()
        if not default_value or not current_value:
            continue
        current_path = resolve_configured_path(project_root, current_value, default_value)
        default_path = (project_root / default_value).resolve()
        if Path(current_value).is_absolute() or is_legacy_venv_python_command(current_value) or not current_path.exists():
            if default_path.exists() and current_value != default_value:
                workflow[key] = default_value
                changed = True
                print_line("FIX", f"Reset portable workflow path {key}: {default_value}")
    return changed


def ensure_private_config(project_root: Path, repair: bool) -> dict[str, Any]:
    """Create or patch server/config.json without replacing private secrets."""
    example_path = project_root / "server" / "config.example.json"
    config_path = project_root / "server" / "config.json"
    require_file(example_path, "Config template")
    defaults = load_json(example_path)
    try:
        config_exists = config_path.exists()
    except OSError:
        print_line("WARN", "server/config.json is protected; using template defaults for environment checks.")
        return defaults
    if not config_exists:
        if not repair:
            raise FileNotFoundError(f"Private config missing: {config_path}")
        try:
            write_json(config_path, defaults)
        except OSError:
            print_line("WARN", "server/config.json cannot be created or inspected; using template defaults for checks.")
            return defaults
        print_line("FIX", f"Created private config: {config_path}")
        return defaults
    try:
        config = load_json(config_path)
    except OSError:
        print_line("WARN", "server/config.json is protected; using template defaults for environment checks.")
        return defaults
    changed = merge_missing_values(config, defaults)
    if repair:
        changed = repair_portable_workflow_paths(project_root, config, defaults) or changed
    if changed:
        if not repair:
            print_line("WARN", "server/config.json is missing default keys; run with --repair to patch it.")
        else:
            try:
                write_json(config_path, config)
                print_line("FIX", "Patched portable server/config.json values without overwriting private secrets.")
            except OSError:
                print_line("WARN", "server/config.json is protected; skipped config patching.")
    else:
        print_line("OK", f"Private config: {config_path}")
    return config


def normalize_storage_path(value: Any) -> Path:
    """Convert one configured storage path into an absolute Path."""
    text = str(value or "").strip()
    if not text:
        raise ValueError("Storage path is empty.")
    return Path(text).resolve()


def is_inside(parent: Path, child: Path) -> bool:
    """Return whether child is equal to or below parent after path resolution."""
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def copy_missing_tree(source: Path, destination: Path) -> int:
    """Copy files from source to destination without overwriting existing files."""
    copied = 0
    if not source.exists() or source.resolve() == destination.resolve():
        return copied
    for item in source.rglob("*"):
        target = destination / item.relative_to(source)
        if item.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        if target.exists():
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(item, target)
        copied += 1
    return copied


def ensure_storage(project_root: Path, config: dict[str, Any], repair: bool) -> None:
    """Validate and prepare external cache directories from server/config.json."""
    storage = config.get("storage")
    if not isinstance(storage, dict):
        raise ValueError("server/config.json missing storage object.")
    cache_dir = normalize_storage_path(storage.get("cacheDirectory"))
    image_dir = normalize_storage_path(storage.get("imageDirectory"))
    history_dir = normalize_storage_path(storage.get("historyDirectory"))
    if not is_inside(cache_dir, image_dir) or not is_inside(cache_dir, history_dir):
        raise ValueError("imageDirectory and historyDirectory must be inside cacheDirectory.")
    if repair:
        cache_dir.mkdir(parents=True, exist_ok=True)
        image_dir.mkdir(parents=True, exist_ok=True)
        history_dir.mkdir(parents=True, exist_ok=True)
        print_line("FIX", f"Cache directories ready: {cache_dir}")
    else:
        require_file(cache_dir, "Cache directory")
        require_file(image_dir, "Image directory")
        require_file(history_dir, "History directory")
    marker_path = cache_dir.parent / ".auto-bundle-cache-migrated-v1.json"
    if repair and not marker_path.exists():
        copied = copy_missing_tree(project_root / "cache", cache_dir)
        write_json(marker_path, {
            "version": 1,
            "migrated_at": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
            "source": str((project_root / "cache").resolve()),
            "destination": str(cache_dir),
            "copied_files": copied,
        })
        print_line("FIX", f"Legacy cache migration marker written; copied {copied} missing files.")


def ensure_node_modules(project_root: Path, install: bool) -> None:
    """Install npm dependencies when node_modules is missing or resolver checks fail."""
    marker = project_root / "node_modules" / ".package-lock.json"
    missing_modules = verify_node_modules(project_root) if marker.exists() else ["node_modules marker missing"]
    if marker.exists() and not missing_modules:
        print_line("OK", "node_modules already installed.")
        return
    if not install:
        raise FileNotFoundError("node_modules is incomplete; run with --install to repair it. Missing: " + "; ".join(missing_modules[:6]))
    if missing_modules:
        print_line("WARN", "node_modules is incomplete: " + "; ".join(missing_modules[:6]))
    missing_npm_runtime = verify_npm_runtime(project_root)
    if missing_npm_runtime:
        raise RuntimeError("Bundled npm runtime is incomplete; re-extract the ZIP with 7-Zip/WinRAR before retrying. Missing: " + "; ".join(missing_npm_runtime))
    removed_packages = remove_incomplete_node_module_packages(project_root)
    if removed_packages:
        print_line("FIX", "Removed incomplete npm packages before reinstall: " + ", ".join(removed_packages))
    npm_command = str(resolve_npm_command(project_root))
    run_checked([npm_command, "install", "--include=optional", "--ignore-scripts=false"], project_root)
    missing_after_install = verify_node_modules(project_root)
    if missing_after_install:
        removed_packages = remove_incomplete_node_module_packages(project_root)
        if removed_packages:
            print_line("FIX", "Retrying after removing stubborn npm packages: " + ", ".join(removed_packages))
            run_checked([npm_command, "install", "--include=optional", "--ignore-scripts=false", "--force"], project_root)
            missing_after_install = verify_node_modules(project_root)
    if missing_after_install:
        raise RuntimeError("node_modules is still incomplete after npm install. Re-extract the ZIP made by the fixed create_distribution.py with 7-Zip/WinRAR. Missing: " + "; ".join(missing_after_install[:6]))


def matches_gpu_runtime_pattern(path: Path) -> bool:
    """Return whether one file path looks like a CUDA/GPU runtime binary."""
    name = path.name.lower()
    for pattern in GPU_RUNTIME_PATTERNS:
        if fnmatch.fnmatch(name, pattern.lower()):
            return True
    return False


def find_gpu_runtime_files(project_root: Path) -> list[Path]:
    """Find GPU runtime leftovers that should not be shipped in the CPU bundle."""
    candidates: list[Path] = []
    search_roots = [
        project_root / "bundle" / "python",
        project_root / "bundle" / "python-cpu",
        project_root / "bundle" / "_delete_pending_python_gpu",
    ]
    for root in search_roots:
        if not root.exists():
            continue
        if root.name in {"python", "_delete_pending_python_gpu"}:
            candidates.append(root)
            continue
        for item in root.rglob("*"):
            if item.is_file() and matches_gpu_runtime_pattern(item):
                candidates.append(item)
    return candidates


def check_no_gpu_runtime(project_root: Path) -> None:
    """Fail early when stale GPU Python or CUDA DLL files are still present."""
    leftovers = find_gpu_runtime_files(project_root)
    if leftovers:
        visible = ", ".join(str(item) for item in leftovers[:10])
        extra = "" if len(leftovers) <= 10 else f" ... and {len(leftovers) - 10} more"
        raise RuntimeError("CPU bundle still contains GPU runtime leftovers: " + visible + extra)
    print_line("OK", "CPU bundle has no stale GPU Python/CUDA runtime files.")


def parse_ports(value: str) -> list[int]:
    """Parse a comma separated port list from the command line."""
    if not value:
        return []
    ports: list[int] = []
    for chunk in value.split(","):
        text = chunk.strip()
        if text:
            ports.append(int(text))
    return ports


def list_pids_on_port(port: int) -> set[int]:
    """Return Windows process IDs listening on one TCP port."""
    completed = subprocess.run(
        ["netstat", "-ano", "-p", "tcp"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="ignore",
        shell=False,
    )
    if completed.returncode != 0:
        return set()
    pids: set[int] = set()
    marker = f":{port}"
    for line in completed.stdout.splitlines():
        parts = line.split()
        if len(parts) < 5 or parts[3].upper() != "LISTENING":
            continue
        if marker in parts[1]:
            try:
                pids.add(int(parts[-1]))
            except ValueError:
                pass
    return pids


def kill_ports(ports: list[int]) -> None:
    """Stop stale local services bound to the configured startup ports."""
    current_pid = os.getpid()
    for port in ports:
        pids = list_pids_on_port(port)
        if not pids:
            print_line("OK", f"Port {port} is free.")
            continue
        for pid in sorted(pids):
            if pid == current_pid:
                continue
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, shell=False)
            print_line("FIX", f"Killed PID {pid} on port {port}.")


def run_python_probe(python_command: Path, clip_root: Path) -> dict[str, Any]:
    """Run one isolated Python process that imports the CLIP runtime dependencies."""
    probe_code = r'''
import importlib
import json
import os
import sys
from pathlib import Path

result = {
    "python": {"executable": sys.executable, "version": sys.version.split()[0]},
    "checks": [],
}

def record(name, ok, detail):
    """Append one JSON-serializable dependency check result."""
    result["checks"].append({"name": name, "ok": bool(ok), "detail": str(detail)})

def import_package(name, import_name=None):
    """Import one package and record its version when available."""
    module_name = import_name or name
    try:
        module = importlib.import_module(module_name)
        version = getattr(module, "__version__", "version unknown")
        record(name, True, version)
        return module
    except Exception as exc:
        record(name, False, type(exc).__name__ + ": " + str(exc))
        return None

torch = import_package("torch")
if torch is not None:
    try:
        cuda_available = bool(torch.cuda.is_available())
        cuda_version = getattr(torch.version, "cuda", "") or "cpu"
        device_count = int(torch.cuda.device_count()) if cuda_available else 0
        record("torch.cuda", True, "available=" + str(cuda_available) + ", cuda=" + str(cuda_version) + ", devices=" + str(device_count))
    except Exception as exc:
        record("torch.cuda", False, type(exc).__name__ + ": " + str(exc))

faiss = import_package("faiss")
if faiss is not None:
    try:
        index = faiss.IndexFlatIP(512)
        record("faiss.index", index.d == 512, "IndexFlatIP dimension=" + str(index.d))
    except Exception as exc:
        record("faiss.index", False, type(exc).__name__ + ": " + str(exc))

open_clip = import_package("open_clip")
if open_clip is not None:
    try:
        tokenizer = open_clip.get_tokenizer("ViT-B-32")
        has_factory = hasattr(open_clip, "create_model_and_transforms")
        record("open_clip.runtime", callable(tokenizer) and has_factory, "tokenizer=ok, create_model_and_transforms=" + str(has_factory))
    except Exception as exc:
        record("open_clip.runtime", False, type(exc).__name__ + ": " + str(exc))

import_package("PIL", "PIL.Image")
import_package("flask")
import_package("requests")
import_package("numpy")

clip_root = Path(os.environ.get("AUTO_BUNDLE_CLIP_ROOT", "")).resolve()
try:
    sys.path.insert(0, str(clip_root / "work"))
    importlib.import_module("full_listing_server")
    record("clip.full_listing_server", True, "import ok")
except Exception as exc:
    record("clip.full_listing_server", False, type(exc).__name__ + ": " + str(exc))

print("__ENV_DOCTOR_JSON__" + json.dumps(result, ensure_ascii=False))
'''
    environment = build_bundled_python_environment(clip_root, {
        "PYTHONIOENCODING": "utf-8",
        "AUTO_BUNDLE_CLIP_ROOT": str(clip_root),
    })
    completed = subprocess.run(
        [str(python_command), "-c", probe_code],
        cwd=str(clip_root),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        shell=False,
        timeout=60,
        env=environment,
    )
    marker = "__ENV_DOCTOR_JSON__"
    for line in completed.stdout.splitlines():
        if line.startswith(marker):
            return json.loads(line[len(marker):])
    detail = (completed.stderr or completed.stdout or "").strip()
    raise RuntimeError("Python CLIP probe failed: " + (detail[-1000:] if detail else f"exit {completed.returncode}"))


def check_python_clip_environment(python_command: Path, clip_root: Path) -> None:
    """Validate Python, PyTorch, FAISS, OpenCLIP, and listing-server imports."""
    require_file(python_command, "CLIP Python runtime")
    payload = run_python_probe(python_command, clip_root)
    python_info = payload.get("python") if isinstance(payload, dict) else {}
    print_line("OK", "Python executable: " + str(python_info.get("executable", python_command)))
    print_line("OK", "Python version: " + str(python_info.get("version", "unknown")))
    failed: list[str] = []
    checks = payload.get("checks") if isinstance(payload, dict) else []
    for item in checks if isinstance(checks, list) else []:
        name = str(item.get("name", "dependency"))
        detail = str(item.get("detail", ""))
        if item.get("ok"):
            print_line("OK", f"{name}: {detail}")
        else:
            print_line("ERROR", f"{name}: {detail}")
            failed.append(name)
        if name == "torch.cuda" and "cuda=cpu" not in detail:
            print_line("ERROR", "torch must be the CPU wheel for this package; current detail: " + detail)
            failed.append("torch.cpu_wheel")
    if failed:
        raise RuntimeError("Python CLIP environment check failed: " + ", ".join(failed))


def run_clip_cpu_benchmark(python_command: Path, clip_root: Path) -> dict[str, Any]:
    """Run one CPU-only CLIP benchmark in a child process and return its JSON summary."""
    benchmark_code = r'''
import json
import os
import statistics
import sys
import time
from pathlib import Path

def timed(callback):
    """Return the callback result and elapsed seconds."""
    started = time.perf_counter()
    result = callback()
    return result, round(time.perf_counter() - started, 3)

clip_root = Path(os.environ["AUTO_BUNDLE_CLIP_ROOT"]).resolve()
sys.path.insert(0, str(clip_root / "work"))
import torch
import full_listing_server as listing

queries = [
    "wall mounted soap dispenser bathroom storage shelf",
    "dog chew toy rope ball pet training toy",
    "kitchen vegetable cutter stainless steel slicer",
    "party balloon pump ribbon decoration set",
    "travel toiletry bag hanging organizer",
]

_, index_seconds = timed(listing.load_index_runtime)
_, model_seconds = timed(listing.load_model_runtime)

def run_search(query):
    """Encode one query and search the bundled FAISS listing index."""
    vector = listing.encode_text(query)
    return len(listing.search_listing_index(vector, 10, None, None))

first_count, first_seconds = timed(lambda: run_search(queries[0]))
steady_times = []
for query in queries:
    _, elapsed = timed(lambda value=query: run_search(value))
    steady_times.append(elapsed)

summary = {
    "python": sys.executable,
    "torch": getattr(torch, "__version__", "unknown"),
    "torch_cuda_available": bool(torch.cuda.is_available()),
    "device": str(listing.RUNTIME_CACHE.get("device")),
    "index_vectors": int(listing.RUNTIME_CACHE["index"].ntotal),
    "products": len(listing.RUNTIME_CACHE["products"]),
    "load_index_seconds": index_seconds,
    "load_model_seconds": model_seconds,
    "first_search_seconds_after_load": first_seconds,
    "first_search_result_count": first_count,
    "steady_search_seconds": steady_times,
    "steady_avg_seconds": round(statistics.mean(steady_times), 3),
    "steady_max_seconds": round(max(steady_times), 3),
}
print("__ENV_DOCTOR_BENCHMARK__" + json.dumps(summary, ensure_ascii=False))
'''
    environment = build_bundled_python_environment(clip_root, {
        "CUDA_VISIBLE_DEVICES": "-1",
        "PYTHONIOENCODING": "utf-8",
        "AUTO_BUNDLE_CLIP_ROOT": str(clip_root),
    })
    completed = subprocess.run(
        [str(python_command), "-c", benchmark_code],
        cwd=str(clip_root),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        shell=False,
        timeout=180,
        env=environment,
    )
    marker = "__ENV_DOCTOR_BENCHMARK__"
    for line in completed.stdout.splitlines():
        if line.startswith(marker):
            return json.loads(line[len(marker):])
    detail = (completed.stderr or completed.stdout or "").strip()
    raise RuntimeError("CLIP CPU benchmark failed: " + (detail[-1000:] if detail else f"exit {completed.returncode}"))


def benchmark_clip_cpu(project_root: Path, config: dict[str, Any]) -> None:
    """Print a no-CUDA CLIP speed benchmark using the bundled Python environment."""
    workflow = config.get("workflow") if isinstance(config.get("workflow"), dict) else {}
    clip_root = resolve_portable_configured_path(project_root, workflow.get("clip_project_directory"), "bundle/clip", "CLIP project directory")
    python_command = resolve_portable_configured_path(project_root, workflow.get("clip_python_command"), "bundle/python-runtime/python.exe", "CLIP Python runtime")
    require_file(python_command, "CLIP Python runtime")
    print_line("INFO", "Benchmarking CLIP with CUDA hidden; this simulates a no-CUDA computer.")
    summary = run_clip_cpu_benchmark(python_command, clip_root)
    print_line("OK", "CPU benchmark device: " + str(summary.get("device", "unknown")))
    print_line("OK", "CPU benchmark torch CUDA available: " + str(summary.get("torch_cuda_available", "")))
    print_line("OK", "CPU benchmark vectors: " + str(summary.get("index_vectors", "")))
    print_line("OK", "CPU load index: " + str(summary.get("load_index_seconds", "")) + "s")
    print_line("OK", "CPU load model: " + str(summary.get("load_model_seconds", "")) + "s")
    print_line("OK", "CPU first text search after load: " + str(summary.get("first_search_seconds_after_load", "")) + "s")
    print_line("OK", "CPU steady text search avg/max: " + str(summary.get("steady_avg_seconds", "")) + "s / " + str(summary.get("steady_max_seconds", "")) + "s")


def check_clip_bundle(project_root: Path, config: dict[str, Any]) -> None:
    """Report whether the bundled CLIP files and Python runtime are usable."""
    workflow = config.get("workflow") if isinstance(config.get("workflow"), dict) else {}
    clip_root = resolve_portable_configured_path(project_root, workflow.get("clip_project_directory"), "bundle/clip", "CLIP project directory")
    python_command = resolve_portable_configured_path(project_root, workflow.get("clip_python_command"), "bundle/python-runtime/python.exe", "CLIP Python runtime")
    required = [
        clip_root / "work" / "stdio_listing_worker.py",
        clip_root / "work" / "full_listing_server.py",
        clip_root / "models" / "open_clip_pytorch_model.bin",
        clip_root / "data" / "yunqi_clip_training" / "last_checkpoint.pt",
        clip_root / "data" / "full_listing_index" / "products_listing.index",
        clip_root / "data" / "full_clip_index" / "products_full_prices.json",
    ]
    for path in required:
        require_nonempty_file(path, "CLIP file")
    check_python_clip_environment(python_command, clip_root)
    print_line("OK", "CLIP bundle and Python environment are ready.")


def check_project_files(project_root: Path) -> None:
    """Validate the fixed project files needed before local startup."""
    require_file(project_root / "package.json", "Package manifest")
    require_file(project_root / "server" / "server.js", "Backend entry")
    require_file(project_root / "server" / "scripts" / "start-local-services.js", "Service launcher")
    require_file(project_root / "web" / "index.html", "Workbench page")
    require_file(project_root / "node_modules" / "vite" / "bin" / "vite.js", "Vite entry")
    node_command = resolve_node_executable(project_root)
    if isinstance(node_command, Path):
        require_file(node_command, "Node runtime")
    else:
        print_line("WARN", "Bundled Node missing; will rely on system node.")


def build_argument_parser() -> argparse.ArgumentParser:
    """Create the command line parser used by script and frozen exe modes."""
    parser = argparse.ArgumentParser(description="Detect and repair Auto Bundle local environment.")
    parser.add_argument("--project-root", default="", help="Project root directory.")
    parser.add_argument("--repair", action="store_true", help="Create missing config/cache paths when possible.")
    parser.add_argument("--install", action="store_true", help="Run npm install when node_modules is missing.")
    parser.add_argument("--kill-ports", default="", help="Comma separated ports to free before startup.")
    parser.add_argument("--skip-clip-check", action="store_true", help="Skip optional CLIP bundle checks.")
    parser.add_argument("--benchmark-clip-cpu", action="store_true", help="Benchmark bundled CLIP with CUDA disabled.")
    return parser


def main() -> int:
    """Run all requested environment checks and repairs."""
    parser = build_argument_parser()
    args = parser.parse_args()
    project_root = resolve_project_root(args.project_root)
    print_line("INFO", f"Project: {project_root}")
    config = ensure_private_config(project_root, args.repair)
    ensure_storage(project_root, config, args.repair)
    ensure_node_modules(project_root, args.install)
    check_no_gpu_runtime(project_root)
    check_project_files(project_root)
    if not args.skip_clip_check:
        check_clip_bundle(project_root, config)
    if args.benchmark_clip_cpu:
        benchmark_clip_cpu(project_root, config)
    ports = parse_ports(args.kill_ports)
    if ports:
        kill_ports(ports)
    print_line("OK", "Environment doctor finished.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print_line("ERROR", str(exc))
        raise SystemExit(1)

#!/usr/bin/env python3
"""
打包脚本 - 创建可分发的 ZIP 包
排除开发文件和大型依赖
"""
import os
import zipfile
import sys
import fnmatch
from pathlib import Path

# 排除模式
EXCLUDE_PATTERNS = [
    '.git',
    '__pycache__',
    '.pyc',
    '.pyo',
    '.egg-info',
    '.vscode',
    '.idea',
    '.DS_Store',
    'Thumbs.db',
    'desktop.ini',
    '*.log',
    '*.zip',
    '*.7z',
    '*.rar',
    'test_*.py',
    'build',
    'dist',
    '*.spec',
    '.pytest_cache',
    '.mypy_cache',
    '.tox',
    'cache',
    'bundle/python',
    'bundle/_delete_pending_python_gpu',
    'server/config.json',
    'bundle/clip/config.json',
    '*cublas64_*.dll',
    '*cublasLt64_*.dll',
    '*cudart64_*.dll',
    '*cudnn*.dll',
    '*cufft64_*.dll',
    '*curand64_*.dll',
    '*cusolver64_*.dll',
    '*cusparse64_*.dll',
    '*nvrtc*.dll',
    '*nvjpeg*.dll',
    '*torch_cuda.dll',
    'runtime/node/node_modules',  # 排除超大的 node_modules
    'test_output',
]

INCLUDE_OVERRIDES = [
    'runtime/node/node_modules/npm',
]

CRITICAL_ZIP_FILES = [
    '启动.bat',
    'env-doctor.exe',
    'env_doctor.py',
    'runtime/node/node.exe',
    'runtime/node/npm.cmd',
    'runtime/node/node_modules/npm/bin/npm-cli.js',
    'runtime/node/node_modules/npm/bin/npm-prefix.js',
    'bundle/python-runtime/python.exe',
    'bundle/python-cpu/Lib/site-packages/torch/__init__.py',
    'bundle/python-cpu/Lib/site-packages/faiss/__init__.py',
    'bundle/python-cpu/Lib/site-packages/open_clip/__init__.py',
    'node_modules/express/index.js',
    'node_modules/content-type/index.js',
    'node_modules/type-is/index.js',
    'node_modules/vite/bin/vite.js',
    'node_modules/vite/dist/node/index.js',
    'node_modules/@vitejs/plugin-vue/dist/index.mjs',
    'server/scripts/start-local-services.js',
    'server/config.json',
]

ROOT_ONLY_EXCLUDE_PATTERNS = {'build', 'dist'}

def normalize_zip_path(path_str):
    """把本地路径统一成 ZIP 内使用的正斜杠路径。"""
    return str(path_str).replace('\\', '/').strip('/')

def should_keep_for_include_override(path_str):
    """判断路径是否是强制包含目录本身、父目录或子路径。"""
    path_str = normalize_zip_path(path_str)
    for include_path in INCLUDE_OVERRIDES:
        include_path = normalize_zip_path(include_path)
        if path_str == include_path or path_str.startswith(include_path + '/') or include_path.startswith(path_str + '/'):
            return True
    return False

def should_match_root_only_exclude(path_str, pattern):
    """判断根目录专用排除项，避免误删 node_modules 内的同名目录。"""
    path_str = normalize_zip_path(path_str)
    pattern = normalize_zip_path(pattern)
    return pattern in ROOT_ONLY_EXCLUDE_PATTERNS and (path_str == pattern or path_str.startswith(pattern + '/'))

def should_exclude(path_str):
    """判断路径是否应该被排除"""
    path_str = normalize_zip_path(path_str)
    if should_keep_for_include_override(path_str):
        return False
    
    for pattern in EXCLUDE_PATTERNS:
        pattern = normalize_zip_path(pattern)
        if pattern in ROOT_ONLY_EXCLUDE_PATTERNS:
            if should_match_root_only_exclude(path_str, pattern):
                return True
            continue
        # 精确匹配目录名
        if f'/{pattern}/' in f'/{path_str}/':
            return True
        # 匹配文件扩展名
        if pattern.startswith('*.') and path_str.endswith(pattern[1:]):
            return True
        # 匹配通配符文件名
        if any(token in pattern for token in '*?[') and fnmatch.fnmatch(path_str, pattern):
            return True
        # 匹配开头
        if path_str.startswith(pattern + '/'):
            return True
            
    return False

def read_distribution_config(base_dir, example_relative_path):
    """读取用于分发包的安全 config.json 内容，避免泄漏本机私密配置。"""
    example_path = base_dir / example_relative_path
    if not example_path.exists():
        raise FileNotFoundError('缺少 ' + str(example_relative_path) + '，无法生成安全 config.json')
    return example_path.read_bytes()

def add_distribution_config(zipf, base_dir):
    """向 ZIP 写入由 config.example.json 生成的安全 config.json。"""
    zipf.writestr('server/config.json', read_distribution_config(base_dir, Path('server') / 'config.example.json'))
    zipf.writestr('bundle/clip/config.json', read_distribution_config(base_dir, Path('bundle') / 'clip' / 'config.example.json'))

def validate_distribution_zip(zip_path):
    """确认 ZIP 内包含启动所需的关键运行时文件。"""
    with zipfile.ZipFile(zip_path, 'r') as zipf:
        names = set(zipf.namelist())
    missing = [name for name in CRITICAL_ZIP_FILES if name not in names]
    if missing:
        raise RuntimeError('分发包缺少关键文件: ' + ', '.join(missing))
    print('关键文件校验通过: Node/Python/CLIP/node_modules 均已进入 ZIP')

def create_distribution_zip(output_name='自动组货_CPU版本.zip'):
    """创建分发包"""
    base_dir = Path.cwd()
    zip_path = base_dir / output_name
    
    print(f"正在创建分发包: {output_name}")
    print("=" * 60)
    
    total_files = 0
    excluded_files = 0
    included_files = 0
    
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
        add_distribution_config(zipf, base_dir)
        included_files += 2
        for root, dirs, files in os.walk(base_dir):
            # 修改 dirs 列表以跳过排除的目录
            dirs[:] = [d for d in dirs if not should_exclude((Path(root) / d).relative_to(base_dir))]
            
            for file in files:
                total_files += 1
                file_path = Path(root) / file
                relative_path = file_path.relative_to(base_dir)
                
                # 跳过输出的 zip 文件本身
                if file_path == zip_path:
                    excluded_files += 1
                    continue
                
                # 检查是否应该排除
                relative_text = normalize_zip_path(relative_path)
                if should_exclude(relative_text):
                    excluded_files += 1
                    if excluded_files % 1000 == 0:
                        print(f"已扫描: {total_files} 文件, 已包含: {included_files}, 已排除: {excluded_files}")
                    continue
                
                # 添加到 zip
                try:
                    zipf.write(file_path, relative_path)
                    included_files += 1
                    
                    if included_files % 100 == 0:
                        print(f"已添加: {included_files} 文件...")
                        
                except Exception as e:
                    print(f"警告: 无法添加 {relative_path}: {e}")
                    excluded_files += 1
    
    zip_size_mb = zip_path.stat().st_size / (1024 * 1024)
    validate_distribution_zip(zip_path)
    
    print("=" * 60)
    print("打包完成!")
    print(f"输出文件: {output_name}")
    print("统计:")
    print(f"   - 扫描文件总数: {total_files}")
    print(f"   - 已包含文件: {included_files}")
    print(f"   - 已排除文件: {excluded_files}")
    print(f"   - 压缩包大小: {zip_size_mb:.2f} MB")
    print("=" * 60)
    print("\n重要提示:")
    print("1. 已包含根目录 node_modules，已排除 cache、旧 GPU 环境和其他开发依赖")
    print("2. 已排除 .git 历史记录")
    print("3. 已排除 __pycache__ 和本机私密 config.json")
    print("4. 接收者需要:")
    print("   - 运行 启动.bat")
    print("   - 在 server/config.json 中填写自己的 API 密钥")
    print("\n请参考 README_CPU.md 了解详细部署说明")

if __name__ == '__main__':
    output_name = sys.argv[1] if len(sys.argv) > 1 else '自动组货_CPU版本.zip'
    create_distribution_zip(output_name)

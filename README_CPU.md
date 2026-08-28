# 自动组货系统 - CPU 版本

## 系统概述

本系统已完全移除 GPU 依赖，使用纯 CPU 运行。适合在没有 NVIDIA 显卡的机器上部署。

## 环境要求

- **Python**: 已内置 `bundle/python-cpu`
- **PyTorch**: 已内置 CPU 版本，不能混入 CUDA/GPU 版本
- **Node.js**: 已内置 `runtime/node`
- **Web 依赖**: 分发包包含根目录 `node_modules`，首次启动不需要临时联网安装

## 核心功能

### 1. CLIP 图像搜索服务器
- **位置**: `bundle/clip/work/full_clip_server.py`
- **功能**: 使用训练好的 CLIP 模型进行商品图像搜索
- **设备**: 强制使用 CPU (`device="cpu"`)
- **依赖**:
  - open_clip
  - faiss-cpu
  - PyTorch CPU 版本

### 2. Kimi AI 组货助手
- **位置**: 
  - `bundle/clip/work/full_clip_server.py`
  - `bundle/clip/work/full_listing_server.py`
- **功能**: 使用 Kimi API 生成商品组合方案
- **并发优化**: 按 3/3/4 三个批次并发调用 Kimi
- **关键改进**: 哪个批次先返回，哪个批次立即进入 CLIP 搜索

### 3. 组货工作流
- **并发处理**: 多个批次同时调用 Kimi API
- **排序逻辑**: 谁先返回谁先做 CLIP，无需等全部 Kimi 批次完成后再统一搜索
- **用户体验**: 更快看到首批结果

## 已完成的修改

### ✅ 移除所有 GPU 相关代码
1. 删除了所有 `device="cuda"` 引用
2. 移除了 `torch.cuda` 相关检查
3. 强制使用 `device="cpu"`
4. 更新了所有设备相关的函数调用

### ✅ 修复 Kimi 并发排序问题
**问题**: 之前 Kimi 可以并发，但 CLIP 搜索仍然等全部 Kimi 批次结束后才开始

**解决方案**:
- 使用 `concurrent.futures.as_completed()` 按完成顺序处理 Kimi 批次
- 批次划分固定为 `1-3 / 4-6 / 7-10`
- 每个批次返回后立即执行该批次的 CLIP 检索
- 最终结果按实际完成顺序添加到列表

**效果**: 
- `7-10` 最先返回 → 这 4 个方向先进入 CLIP
- `4-6` 其次返回 → 这 3 个方向第二批进入 CLIP
- `1-3` 最后返回 → 这 3 个方向最后进入 CLIP

代码位置: `bundle/clip/work/full_listing_server.py`、`bundle/clip/work/stdio_listing_worker.py`

## 运行测试

```powershell
bundle\python-runtime\python.exe env_doctor.py --project-root . --repair
```

测试包括:
1. ✅ 环境检查 (PyTorch CPU, 无 CUDA)
2. ✅ CLIP 工作流配置检查
3. ✅ FAISS / open_clip / listing worker 导入检查

## 启动服务

### 一键启动
```bash
启动.bat
```

`启动.bat` 会先运行 env-doctor 修补配置、创建 D 盘 cache、释放端口，然后打开工作台。

## 配置文件

### server/config.json
```json
{
  "image_timeout_ms": 300000,
  "kimi": {
    "api_key": "你的Kimi API密钥",
    "endpoint": "https://api.moonshot.cn/v1/chat/completions",
    "model": "kimi-k2.6",
    "temperature": 0.6,
    "max_completion_tokens": 1800
  }
}
```

`image_timeout_ms` 统一控制 BeeAPI generations、edits 和 Fusion 请求，默认 300000 毫秒（5 分钟）。

或使用环境变量:
- `MOONSHOT_API_KEY`: Kimi API 密钥
- `KIMI_ENDPOINT`: API 端点 (可选)
- `KIMI_MODEL`: 模型名称 (可选)

## 注意事项

### CPU 性能
- CLIP 推理速度比 GPU 慢 10-50 倍
- 适合小规模或演示用途
- 建议使用预先构建好的索引文件

### CLIP 依赖
- `open_clip`: 已打进 `bundle/python-cpu`
- `faiss-cpu`: 已打进 `bundle/python-cpu`
- `torch`: 必须是 `+cpu` 版本，env-doctor 会检查 CUDA/GPU 残留

### 已移除的文件
以下 GPU 相关文件已被移除:
- ~~任何包含 `cuda` 的配置~~
- ~~GPU 内存管理代码~~
- ~~CUDA 设备检查~~

## 文件结构

```
自动组货/
├── bundle/
│   ├── clip/
│   │   └── work/
│   │       ├── full_clip_server.py      # CLIP 搜索服务器 (CPU)
│   │       └── full_listing_server.py   # 完整组货服务器 (CPU + Kimi)
│   └── python-cpu/                      # Python CPU 运行时
├── env_doctor.py                        # 环境检查与修补脚本
├── env-doctor.exe                       # 无依赖环境检查与修补程序
├── server/config.json                   # 私有配置文件
└── README_CPU.md                        # 本文档
```

## 常见问题

### Q: 为什么朋友电脑没 CUDA 也能跑？
A: 当前包使用 `bundle/python-cpu`，PyTorch 是 CPU wheel。env-doctor 会检查 `torch.cuda available=False, cuda=cpu`，并阻止旧 GPU 环境混进包里。

### Q: Kimi 并发排序是如何工作的？
A: 使用 `concurrent.futures.as_completed()` 迭代器，它会在每个 future 完成时立即返回，而不是按提交顺序。这样先完成的批次会先被处理。

### Q: CPU 版本性能如何？
A: CLIP 推理会比 GPU 慢，但 Kimi API 调用速度不受影响。建议使用预构建的索引文件以提高性能。

## 更新历史

- **2024-01**: 移除所有 GPU 依赖，改为纯 CPU 运行
- **2024-01**: 修复 Kimi 并发排序问题，改为按返回顺序排列
- **2024-01**: 添加完整集成测试

## 技术支持

如有问题，请检查:
1. Python 版本是否为 3.8+
2. PyTorch 是否为 CPU 版本
3. config.json 中的 Kimi API 密钥是否正确
4. 运行 `bundle\python-runtime\python.exe env_doctor.py --project-root . --repair` 查看详细错误

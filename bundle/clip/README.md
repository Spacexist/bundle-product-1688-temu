---
license: apache-2.0
---

# Temu Bundle Search

本仓库是一个本地商品组货检索包：图片输入后调用 Kimi 生成组货方向，再用训练好的 CLIP / FAISS listing 索引召回 Temu 商品。仓库包含运行所需的代码、模型、索引和 metadata，大文件通过 Hugging Face Git LFS 存储。

## 包含内容

```text
app/listing_search.html                         # 9990 前端页面
work/full_listing_server.py                     # 纯 listing CLIP + Kimi 组货服务
work/full_clip_server.py                        # 旧版 image/listing CLIP 服务
work/build_full_listing_index.py                # listing 索引构建脚本
models/open_clip_pytorch_model.bin              # OpenCLIP 基础权重
data/yunqi_clip_training/last_checkpoint.pt     # 训练 checkpoint
data/full_listing_index/products_listing.index  # FAISS listing 索引
data/full_listing_index/products_listing_embeddings.npy
data/full_listing_index/products_listing_meta.json
data/full_clip_index/products_full_prices.json
config.example.json                             # 配置模板
```

## 下载

需要安装 Git LFS：

```powershell
git lfs install
git clone https://huggingface.co/mikaassa/temu-for-bundle
cd temu-for-bundle
git lfs pull
```

## 配置 Kimi

复制配置模板：

```powershell
copy config.example.json config.json
```

编辑 `config.json`：

```json
{
  "kimi": {
    "api_key": "你的 Kimi / Moonshot API Key",
    "endpoint": "https://api.moonshot.cn/v1/chat/completions",
    "model": "kimi-k2.6",
    "temperature": 0.6,
    "max_completion_tokens": 1200
  }
}
```

`config.json` 已被 `.gitignore` 忽略，不要提交真实 API key。

也可以使用环境变量覆盖：

```powershell
$env:MOONSHOT_API_KEY="你的 key"
$env:KIMI_ENDPOINT="https://api.moonshot.cn/v1/chat/completions"
$env:KIMI_MODEL="kimi-k2.6"
```

## 启动 9990 服务

建议使用已有 PyTorch / FAISS / OpenCLIP 环境。如果本机环境已经装好依赖：

```powershell
cd temu-for-bundle
python .\work\full_listing_server.py
```

然后打开：

```text
http://127.0.0.1:9990/
```

## 页面流程

```text
图片 -> Kimi 生成 10 个组货方向 -> 英文 listing prompt -> FAISS/CLIP 召回 -> 商品卡片
```

前端支持两个模式：

- 图片组货：上传商品图片，调用 Kimi 后查 CLIP 索引
- 直接 CLIP：手动输入 listing / prompt，不调用 Kimi

商品主图会从 Excel metadata 中记录的 MAINIMAGE CDN 地址加载；CDN 失败的图片会被前端过滤掉。

## 注意事项

- 大文件在 Hugging Face LFS 中，clone 后必须执行 `git lfs pull`
- 不要把 `config.json` 提交到仓库
- 当前包面向本地运行，不是公网部署版本
- 如果路径不同，服务会优先使用仓库内 `data/` 和 `models/`，否则才回退到历史本地路径

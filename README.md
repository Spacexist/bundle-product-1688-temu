# 自动组货采集器

这是 Temu 和 1688 的合并版 Chrome Extension。扩展 cache 保存原始采集批次，Server cache 保存服务端规范化数据；扩展只提供统一 JSON 导出，不提供 Excel 导出。

## 当前架构

- `web/`：独立 Vue/Vite 前端，默认端口 5173，只消费后端 ViewModel、维护界面交互状态并提交模块草稿。
- `server/`：独立 Express API，默认端口 3000，统一使用 `/api/v1`，负责标准化、校验、业务计算、持久化、版本冲突、历史返回和第三方调用。
- `extension/`：采集原始页面数据并提交 `/api/v1/products/collect`，同时把原始批次保存到 `chrome.storage.local` 的 extension cache。
- `cache/`：由后端独占读写 Server cache；`cache/history/` 保存可跨重启使用的操作快照。

所有后端接口只使用 `/api/v1` 前缀，JSON 接口统一返回 `{ ok, data, error, meta }`；工作流、商品刷新、日志和队列继续使用 SSE。旧的 `/api/*`、`/v1/api/*` 和 Legacy Adapter 已移除，前端和扩展不得再拼接旧路径。

运行 `npm run dev` 会同时启动前后端。服务器 Network 风格日志页面为 `http://127.0.0.1:5173/server/logs`。

公开配置位于 `web/config.json` 和 `extension/config.json`。私有配置位于不会提交的 `server/config.json`，仓库只保留 `server/config.example.json`。

## 加载方式

1. 打开 `chrome://extensions/`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择 `自动组货/extension` 文件夹，不要选择项目根目录。
5. 刷新 Temu 或 1688 商品详情页。

项目目录中，`extension/` 是浏览器扩展目录，`web/` 只保存 Vue 工作台前端，`server/` 统一保存本地 Node 服务端。运行本地服务时，在项目根目录执行 `npm run dev`。

## 支持页面

- Temu：`https://www.temu.com/...-g-商品ID.html`
- 1688：`https://detail.1688.com/offer/商品ID.html`

## 采集流程

页面右侧只显示一个“采集Temu”或“采集1688”按钮。采集结果同时写入 extension cache 和 Server cache；同一平台同一商品再次采集时更新对应 cache 中的原记录。

## 统一 JSON 结构

JSON 是扩展唯一的导出格式，`sku` 数组保存每个商品的完整 SKU 数据。

```json
{
  "main_id": 1,
  "platform_id": 1,
  "platform": "temu",
  "product_id": "商品ID",
  "product_name": "商品名称",
  "product_category": "健康与家庭用品 > 口腔护理",
  "category_ids": [16996, 15945, 16685, 16940],
  "sku": [
    {
      "sku_id": "SKU ID",
      "SubSku1": "颜色: 黑色",
      "SubSku2": "尺码: M",
      "sku_price": 12.8,
      "sku_original_price": 18.8,
      "sku_stock": 200,
      "sku_image_url": "https://example.com/sku.jpg",
      "sku_image_urls": ["https://example.com/sku.jpg"]
    }
  ],
  "main_image_url": "https://example.com/main.jpg",
  "gallery_image_urls": ["https://example.com/1.jpg", "https://example.com/2.jpg"],
  "detail_image_urls": ["https://example.com/detail.jpg"],
  "shop_name": "店铺名称",
  "shop_rating": 4.8,
  "review_count": 100,
  "sales_count": 1000,
  "delivery_json": {},
  "attributes_json": {},
  "page_url": "https://www.temu.com/...",
  "collected_at": "2026-08-08 10:00:00.000"
}
```

`main_id` 是两个平台共用的全局顺序号；`platform_id` 是同一平台内独立递增的顺序号。`platform` 为 `temu` 或 `1688`。旧缓存中的 `mainid` 只作为兼容别名保留在本地存储，新的 JSON 导出不再输出它。

## 导出说明

扩展只保留统一 JSON 导出；Excel 导出入口已移除。`main_id`、`platform_id`、SKU、主图、轮播图和详情图 URL 都从扩展 cache 的原始记录生成。

## 1688 SKU 属性来源

1688 的两个 SKU 属性名只从当前内存模型的明确字段读取：

```text
skuBizModel.skuProps[0].prop -> SubSku1 属性名
skuBizModel.skuProps[1].prop -> SubSku2 属性名
```

SKU 实际值来自 `skuInfoMap[*].specAttrs`，按对应顺序组成 `属性:参数`。如果内存中没有第二个 `skuProps`，`SubSku2` 保持空值；不会通过递归扫描或 DOM 猜测属性名。

## 文件说明

- `collector-temu.js`：读取 Temu 页面内存数据。
- `collector-1688.js`：读取 1688 页面内存数据。
- `background.js`：统一采集消息、批次去重，以及 `main_id`、`platform_id` 分配。
- `popup.js`：扩展 cache 管理和统一 JSON 导出。
- `content.js`：两个平台共用的页面采集按钮。

## Vue 商品重渲染工作台

项目新增 `web/` Vue 页面和 `server/server.js` 本地服务，用于读取已经导出的统一 JSON：

```powershell
npm run dev
```

然后打开 `http://127.0.0.1:5173`，点击“导入统一 JSON”。页面包含 Temu 和 1688 两个详情页，左侧选择商品，中间重渲染图片、商品信息和 SKU。

服务端启动后会在终端实时打印 `RECEIVE`、`RECEIVE BODY`、`OUTBOUND`、`UPSTREAM`、`SEND` 等日志，用同一个 `request_id` 串联一次完整请求。浏览器打开 `http://127.0.0.1:5173/server/logs` 可以查看相同的实时日志页面。日志会隐藏 API Key，并把 Base64 图片压缩成图片类型和字符长度，避免密钥泄露或终端被图片内容刷满。

`server/config.json` 用于配置溶图服务和提示词（该文件已加入 `.gitignore`，不会提交 API key）。图片由本地 Express API 转为 base64 后发送给第三方服务，避免第三方服务直接请求 alicdn。

右侧 1688 SKU 会拆成 `SubSku1` 和 `SubSku2` 两列，整行和单个 SubSku 都可以拖到 Temu 的规格组、具体规格选项或 SKU 表格单元格。拖到规格组会作用于全部 Temu SKU，拖到具体选项只作用于匹配行，拖到 SKU 单元格会追加规格值而不会覆盖原值；拖拽会追加对应规格和图片，并直接把 1688 价格加入 Temu 的 `sku_price`。顶部笛卡尔积投放区已移除。

Temu 规格区支持直接改规格名、改选项、删除选项、删除整组规格，也可以新增规格和选项。右侧 1688 的主图、轮播图、SKU 图和详情图可以分别拖到 Temu 主图区、SKU 图片格或商品详情区；主图/轮播图和详情图也可以在各自列表内拖动换序，拖到目标项会移动到目标位置，跨平台图片拖到任意项可以插入。最终顺序直接对应 JSON 数组字段顺序，不增加额外排序字段。SKU 预览图支持单击放大。SKU 图和详情图有内容时隐藏上传按钮，删空后显示带 `+` 的上传空位。

组货导出文件只保存编号，不复制原始商品数据：

```json
{
  "version": "1.0",
  "source_file": "统一商品.json",
  "created_at": "2026-08-08 12:00:00",
  "mappings": [
    {
      "temu": {
        "main_id": 1,
        "platform_id": 1,
        "product_id": "temu-product-id",
        "sku_id": "temu-sku-id",
        "sku_index": 0
      },
      "1688": [
        {
          "main_id": 2,
          "platform_id": 1,
          "product_id": "1688-offer-id",
          "sku_id": "1688-sku-id",
          "sku_index": 0
        }
      ]
    }
  ]
}
```

## 扩展 cache、Server cache 与两种渲染模式

扩展 cache 和 Server cache 分开维护。每次采集成功后，扩展把原始记录保存到 `chrome.storage.local`，同时把采集数据提交到本地 Server：

```text
POST http://127.0.0.1:3000/api/v1/products/collect
SSE  http://127.0.0.1:3000/api/v1/events
```

Express 服务把数据写到项目根目录的 `cache/cache.json`，并通过 `/api/v1/events` 发送轻量刷新通知。前端收到通知后重新获取 `/api/v1/workbench`，不会直接读取缓存文件。

图片由后端统一保存到 `cache/image/temu`、`cache/image/1688` 和 `cache/image/transfer`。文件名使用内容 SHA-256，JSON 只保存 `/api/v1/cache/image/...` 地址；`cache/image/source-index.json` 用远程源 URL 的 SHA-256 命中已有文件，命中时不会再次请求 CDN。运行 `npm run cache:images` 可以迁移已有缓存图片。

扩展导出的原格式 JSON 可以提交到 `POST /api/v1/restore`。

扩展弹窗的“清空扩展 cache”只清除 `chrome.storage.local`；前端工作台的“清空 Server cache”只清除 Server 的 `cache/cache.json`。扩展已有的“打开实时渲染”功能保持不变。

主图、轮播图、SKU 图和详情图 URL 会随扩展 cache 的原始记录导出；Server cache 中的图片会通过 `/api/v1/cache/image/...` 提供给前端。详情图为空时，工作台会通过下面的接口临时读取详情描述并解析图片 URL，只放入当前 Vue 页面内存，不写入 `cache.json` 或其他图片缓存文件：

- `GET /api/v1/images/details?url=1688详情描述地址`：由后端读取 1688 详情描述并返回详情图 URL。

`cache/cache.json` 仍然只由后端维护，扩展 cache 不会被前端清空操作删除。

工作台有两种模式：

- `实时渲染`：打开 `npm run dev` 后，点击扩展弹窗中的“打开实时渲染”，页面会从根目录 `cache/cache.json` 读取并实时刷新。
- `导出模式`：点击“导出模式”，导入统一 JSON，随后可导出当前规范化 JSON 或组货 JSON。

工作台顶部的“导出妙手 ZIP”会把全部 Temu 商品一次打包为妙手素材包：标题、货源链接、类目和原价来自 Temu，属性会自动拼接到详情描述，Temu 详情图为空时回退到 Temu 轮播图。库存为空按 0 导出，SKU 重量按 KG 导出，尺寸留空；导出过程不会使用 1688 商品、价格或图片。

妙手 ZIP 通过 `GET /api/v1/zip` 在 3000 端生成，浏览器只负责下载服务端返回的 ZIP 文件。

实时页面布局为：左侧 Temu Listing 缩略列表（`platform_id`、Temu 主图、商品名称），中间 Temu 商品渲染列，右侧 1688 商品渲染列。SKU 区域先按 `属性:参数` 聚合成最多两个规格维度，再渲染规格选项和 SKU 列表；图片、价格、库存和分类 ID 都直接从统一 JSON/cache 的规范字段渲染。

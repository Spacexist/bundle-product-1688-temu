# Temu + 1688 统一商品采集扩展

这是 Temu 和 1688 的合并版 Chrome Extension。两个平台继续使用各自已经验证过的页面内存采集器，但统一使用同一个批次、同一个 JSON 结构和同一个 Excel 导出格式。

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

页面右侧只显示一个“采集Temu”或“采集1688”按钮。采集结果直接写入本地 cache 服务；同一平台同一商品再次采集时更新原记录，并保留原来的 `main_id` 和 `platform_id`。

## 统一 JSON 结构

JSON 是规范数据模型，Excel 的“商品SKU”Sheet 从 JSON 的 sku 数组展开成多行；两者使用同一组商品字段。

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

`main_id` 是两个平台共用的全局顺序号；`platform_id` 是同一平台内独立递增的顺序号。`platform` 为 `temu` 或 `1688`。旧缓存中的 `mainid` 只作为兼容别名保留在本地存储，新的 JSON/Excel 导出不再输出它，也不会输出内部 `source_data`。

## 统一 Excel

Excel 包含两个工作表：

- `商品SKU`：Temu 和 1688 的真实 SKU 展平到同一张表。
- `评论`：评论统一使用 `main_id` 和 `platform_id` 关联商品。

第一张表的字段顺序为：

```text
main_id, platform_id, platform, product_id, product_name, product_category, category_ids, sku_id, SubSku1, SubSku2, sku_price, sku_original_price, sku_stock, sku_image_url, main_image_url, gallery_image_urls, detail_image_urls, shop_name, shop_rating, review_count, sales_count, delivery_json, attributes_json, page_url, collected_at
```

Temu 和 1688 不存在的字段留空；轮播图和详情图 URL 在同一单元格中按换行分隔。

`product_category` 是统一分类字段：Temu 使用前台面包屑，1688 使用页面内存中的分类路径。导出前会过滤开头的 `首页>`、`首页 >` 或同类首页分隔符。`category_ids` 是统一分类 ID 字段：Temu 写入后台 `goods.catId1` 到 `goods.catId4`，1688 写入商品分类 ID。

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
- `popup.js`：统一 JSON/XLSX 导出。
- `content.js`：两个平台共用的页面采集按钮。

## Vue 商品重渲染工作台

项目新增 `web/` Vue 页面和 `server/server.js` 本地服务，用于读取已经导出的统一 JSON：

```powershell
npm run dev
```

然后打开 `http://127.0.0.1:5173`，点击“导入统一 JSON”。页面包含 Temu 和 1688 两个详情页，左侧选择商品，中间重渲染图片、商品信息和 SKU。

服务端启动后会在终端实时打印 `RECEIVE`、`RECEIVE BODY`、`OUTBOUND`、`UPSTREAM`、`SEND` 和 `DONE` 六类日志，用同一个 `request_id` 串联一次完整请求。浏览器打开 `http://127.0.0.1:5173/server/logs` 可以查看相同的实时日志页面。日志会隐藏 API Key，并把 Base64 图片压缩成图片类型和字符长度，避免密钥泄露或终端被图片内容刷满。

根目录 `config.json` 用于配置溶图服务（该文件已加入 `.gitignore`，不会提交 API key）。当 Temu SKU 图片格中有两张或以上图片时，点击“溶图”会先在浏览器端把当前图片全部转换为 base64，再交给本地 Node 服务调用图片编辑接口，避免把 alicdn URL 交给中转服务；生成图会置于该 SKU 图片列表首位，原图继续保留。提示词固定为“第一张图片作为主体构图，后续图片作为同一商品的细节、颜色、版型和材质参考，融合为一张自然完整的电商 SKU 商品图，消除重影、错位和拼接边缘，不拼贴、不添加文字水印或额外商品”。

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

## 长久 cache 与两种渲染模式

扩展不再写入 `chrome.storage.local`，本地 cache 服务是唯一数据源。每次采集成功后，扩展会把完整批次 POST 到本地服务：

```text
POST http://127.0.0.1:5173/api/cache
GET  http://127.0.0.1:5173/cache.json
SSE  http://127.0.0.1:5173/api/cache/events
```

本地服务把数据写到项目根目录的 `cache/cache.json`，并通过 `/api/cache/events` 推送给已经打开的 Vue 页面。`cache/` 已加入 `.gitignore`，它是本机运行数据，不会提交到仓库；首次启动时会自动兼容迁移旧的 `web/cache.json`。服务未启动时，采集和导出都会明确提示先运行 `npm run dev`，不会再写入另一份浏览器缓存。

图片不经过本地缓存，主图、轮播图、SKU 图和详情图都直接使用 Temu/1688 CDN URL。详情图为空时，工作台会通过下面的接口临时读取详情描述并解析图片 URL，只放入当前 Vue 页面内存，不写入 `cache.json` 或其他图片缓存文件：

- `GET /api/detail-images?url=1688详情描述地址`：实时读取 1688 详情描述内容并返回详情图 URL。

`cache/cache.json` 仍然只保存采集到的商品数据；图片缓存后续再单独设计。

工作台有两种模式：

- `实时渲染`：打开 `npm run dev` 后，点击扩展弹窗中的“打开实时渲染”，页面会从根目录 `cache/cache.json` 读取并实时刷新。
- `导出模式`：点击“导出模式”，导入统一 JSON，随后可导出当前规范化 JSON 或组货 JSON。

实时页面布局为：左侧 Temu Listing 缩略列表（`platform_id`、Temu 主图、商品名称），中间 Temu 商品渲染列，右侧 1688 商品渲染列。SKU 区域先按 `属性:参数` 聚合成最多两个规格维度，再渲染规格选项和 SKU 列表；图片、价格、库存和分类 ID 都直接从统一 JSON/cache 的规范字段渲染。

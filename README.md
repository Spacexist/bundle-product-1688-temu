# Temu + 1688 统一商品采集扩展

这是 Temu 和 1688 的合并版 Chrome Extension。两个平台继续使用各自已经验证过的页面内存采集器，但统一使用同一个批次、同一个 JSON 结构和同一个 Excel 导出格式。

## 加载方式

1. 打开 `chrome://extensions/`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择当前文件夹。
5. 刷新 Temu 或 1688 商品详情页。

## 支持页面

- Temu：`https://www.temu.com/...-g-商品ID.html`
- 1688：`https://detail.1688.com/offer/商品ID.html`

## 采集流程

页面右侧只显示一个“采集Temu”或“采集1688”按钮。采集结果写入扩展自己的 `chrome.storage.local`，存储键为 `unifiedBatchRecords`。同一平台同一商品再次采集时更新原记录，并保留原来的 `main_id` 和 `platform_id`。

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
      "sku_image_url": "https://example.com/sku.jpg"
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

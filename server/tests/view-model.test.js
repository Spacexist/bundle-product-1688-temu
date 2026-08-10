const ViewModelService = require("../services/view-model.service").ViewModelService;

describe("ViewModelService", function describeViewModelService() {
  it("normalizes raw extension records on the backend", function normalizeExtensionRecordTest() {
    const service = new ViewModelService();
    const result = service.createWorkbench({
      version: 3,
      records: [{
        platform: "temu",
        main_id: 1,
        platform_id: 2,
        source_data: {
          goods: {
            goodsName: "测试商品",
            gallery: ["https://example.com/main.jpg"]
          },
          sku: [{ specs: [{ specKey: "颜色", specValue: "黑色" }], price: "12" }]
        }
      }]
    });
    expect(result.records[0].product_name).toBe("测试商品");
    expect(result.records[0].sku[0].SubSku1).toBe("颜色:黑色");
    expect(result.records[0].main_image_url).toBe("https://example.com/main.jpg");
  });
});

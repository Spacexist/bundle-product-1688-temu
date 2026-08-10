/**
 * 1688 以图搜款模块。
 * 核心逻辑复制自 project1/1688-image-search/server/index.mjs。
 */

/** Extract 1688 offer identifiers from one image-search result page. */
function parse1688Offers(html) {
  const offers = [];
  const idSet = new Set();
  let match;
  const pattern = /["']?(?:offerId|itemId)["']?\s*[:=]\s*["']?(\d{8,})["']?/g;
  while ((match = pattern.exec(String(html || ""))) && idSet.size < 60) {
    idSet.add(match[1]);
  }
  const identifiers = [];
  for (const identifier of idSet) {
    identifiers.push(identifier);
  }
  for (let index = 0; index < identifiers.length; index += 1) {
    offers.push({
      id: identifiers[index],
      link: "https://detail.1688.com/offer/" + identifiers[index] + ".html"
    });
  }
  return offers;
}

/** Upload one base64 image to the exact 1688 ERP image-search endpoint. */
async function search1688ByImage(image) {
  const source = String(image || "");
  if (!source) {
    throw new Error("请提供图片");
  }
  const base64 = source.indexOf("data:") === 0 ? source.split(",")[1] : source;
  const response = await fetch("https://search.1688.com/service/uploadErpImgSearch", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "user-agent": "Mozilla/5.0"
    },
    body: JSON.stringify({
      imgBase64: base64,
      searchType: "imageSearch",
      appName: "pcErpImage",
      urlType: "main"
    })
  });
  const payload = await response.json();
  if (payload.code !== 0) {
    throw new Error(payload.errMsg || "图搜失败");
  }
  const imageSearchUrl = payload.data && payload.data.imageSearchUrl ? payload.data.imageSearchUrl : "";
  if (!imageSearchUrl) {
    throw new Error("未返回搜款链接");
  }
  let offers = [];
  try {
    const pageResponse = await fetch(imageSearchUrl, {
      headers: {
        "user-agent": "Mozilla/5.0",
        "referer": "https://www.1688.com/"
      }
    });
    const html = await pageResponse.text();
    offers = parse1688Offers(html);
  } catch (error) {
    offers = [];
  }
  return {
    url: imageSearchUrl,
    offers: offers,
    raw: payload
  };
}

module.exports = {
  search1688ByImage: search1688ByImage
};

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

/** Extract the image-search identifier returned by 1688 or embedded in its URL. */
function read1688ImageSearchId(payload, imageSearchUrl) {
  const data = payload && payload.data && typeof payload.data === "object" ? payload.data : {};
  const directCandidates = [data.imageId, data.image_id, data.searchId, data.search_id];
  for (let index = 0; index < directCandidates.length; index += 1) {
    if (directCandidates[index] !== undefined && directCandidates[index] !== null && String(directCandidates[index]).trim()) {
      return String(directCandidates[index]).trim();
    }
  }
  try {
    const parsedUrl = new URL(String(imageSearchUrl || ""));
    const queryCandidates = [parsedUrl.searchParams.get("imageId"), parsedUrl.searchParams.get("image_id")];
    for (let index = 0; index < queryCandidates.length; index += 1) {
      if (queryCandidates[index]) {
        return String(queryCandidates[index]).trim();
      }
    }
  } catch (error) {
    return "";
  }
  return "";
}

/** Upload one base64 image and return the 1688 image-search identifier. */
async function upload1688ImageForSearch(image) {
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
  const imageId = read1688ImageSearchId(payload, imageSearchUrl);
  if (!imageId) {
    throw new Error("1688 未返回图片 ID");
  }
  return {
    image_id: imageId,
    search_url: imageSearchUrl,
    raw: payload
  };
}

/** Search the 1688 result page with the image ID returned by the upload step. */
async function search1688ByImageId(imageId, imageSearchUrl) {
  const id = String(imageId || "").trim();
  if (!id) {
    throw new Error("请提供 1688 图片 ID");
  }
  let searchUrl = String(imageSearchUrl || "").trim();
  if (!searchUrl) {
    searchUrl = "https://search.1688.com/youyuan/index.htm?tab=imageSearch&showP4P=false&odTab=consign&showBid=false&imageId=" + encodeURIComponent(id);
  }
  let offers = [];
  try {
    const pageResponse = await fetch(searchUrl, {
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
    image_id: id,
    url: searchUrl,
    offers: offers
  };
}

/** Complete the two-step 1688 image search flow for one image. */
async function search1688ByImage(image) {
  const uploadResult = await upload1688ImageForSearch(image);
  const searchResult = await search1688ByImageId(uploadResult.image_id, uploadResult.search_url);
  return {
    image_id: uploadResult.image_id,
    url: searchResult.url,
    offers: searchResult.offers,
    raw: uploadResult.raw
  };
}

module.exports = {
  upload1688ImageForSearch: upload1688ImageForSearch,
  search1688ByImageId: search1688ByImageId,
  search1688ByImage: search1688ByImage
};

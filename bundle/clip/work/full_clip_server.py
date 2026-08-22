"""Serve the full trained CLIP index and Kimi assembly planner."""

import base64
import io
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

import faiss
import numpy as np
import open_clip
import torch
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image
import uvicorn


APP_ROOT = Path(__file__).resolve().parent.parent
BUNDLED_FULL_INDEX_DIR = APP_ROOT / "data" / "full_clip_index"
BUNDLED_MODEL_PATH = APP_ROOT / "models" / "open_clip_pytorch_model.bin"
CLIP_DIR = APP_ROOT if BUNDLED_FULL_INDEX_DIR.exists() and BUNDLED_MODEL_PATH.exists() else Path(r"F:\Clip")
FULL_INDEX_DIR = CLIP_DIR / "data" / "full_clip_index"
INDEX_PATH = FULL_INDEX_DIR / "products_full.index"
METADATA_PATH = FULL_INDEX_DIR / "products_full_meta.json"
PRICE_METADATA_PATH = FULL_INDEX_DIR / "products_full_prices.json"
PROGRESS_PATH = FULL_INDEX_DIR / "progress.json"
IMAGE_DIR = APP_ROOT / "images"
BASE_MODEL_PATH = CLIP_DIR / "models" / "open_clip_pytorch_model.bin"
TRAINED_CHECKPOINT_PATH = CLIP_DIR / "data" / "yunqi_clip_training" / "last_checkpoint.pt"
HTML_PATH = APP_ROOT / "app" / "clip_search.html" if (APP_ROOT / "app" / "clip_search.html").exists() else APP_ROOT / "clip_search.html"
MODEL_NAME = "ViT-B-32"
CONFIG_PATH = APP_ROOT / "config.json"
KIMI_API_KEY_ENV = "MOONSHOT_API_KEY"
KIMI_ENDPOINT_ENV = "KIMI_ENDPOINT"
KIMI_MODEL_ENV = "KIMI_MODEL"
APP_CONFIG = {}
KIMI_CONFIG = {}
KIMI_API_URL = "https://api.moonshot.cn/v1/chat/completions"
KIMI_MODEL = "kimi-k2.6"
KIMI_TEMPERATURE = 0.6
KIMI_MAX_COMPLETION_TOKENS = 1800


def load_app_config():
    """Load local app configuration without committing user secrets."""
    if not CONFIG_PATH.exists():
        return {}
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def read_kimi_config():
    """Return Kimi API settings from environment variables, config.json, and defaults."""
    config = APP_CONFIG.get("kimi", {}) if isinstance(APP_CONFIG, dict) else {}
    return {
        "api_key": os.environ.get(KIMI_API_KEY_ENV, "").strip() or str(config.get("api_key", "")).strip(),
        "endpoint": os.environ.get(KIMI_ENDPOINT_ENV, "").strip() or str(config.get("endpoint", KIMI_API_URL)).strip(),
        "model": os.environ.get(KIMI_MODEL_ENV, "").strip() or str(config.get("model", KIMI_MODEL)).strip(),
        "temperature": float(config.get("temperature", KIMI_TEMPERATURE)),
        "max_completion_tokens": int(config.get("max_completion_tokens", KIMI_MAX_COMPLETION_TOKENS)),
    }


APP_CONFIG = load_app_config()
KIMI_CONFIG = read_kimi_config()
KIMI_API_URL = KIMI_CONFIG["endpoint"]
KIMI_MODEL = KIMI_CONFIG["model"]
KIMI_TEMPERATURE = KIMI_CONFIG["temperature"]
KIMI_MAX_COMPLETION_TOKENS = KIMI_CONFIG["max_completion_tokens"]


def read_faiss_index_file(path):
    """Read a FAISS index through Python bytes so Windows Unicode paths stay valid."""
    index_bytes = np.frombuffer(path.read_bytes(), dtype="uint8")
    return faiss.deserialize_index(index_bytes)


def load_runtime():
    """Load the completed full FAISS index, metadata, and trained CLIP model."""
    if not INDEX_PATH.exists() or not METADATA_PATH.exists():
        raise FileNotFoundError("全量索引尚未生成完成")
    if PROGRESS_PATH.exists():
        progress = json.loads(PROGRESS_PATH.read_text(encoding="utf-8"))
        if progress.get("status") != "complete":
            raise RuntimeError(
                f"全量索引仍在构建：{progress.get('completed', 0)}/{progress.get('total', 0)}"
            )
    if not BASE_MODEL_PATH.exists() or not TRAINED_CHECKPOINT_PATH.exists():
        raise FileNotFoundError("基础模型或最终训练 checkpoint 不存在")
    device = torch.device("cpu")
    model, _, preprocess = open_clip.create_model_and_transforms(
        MODEL_NAME,
        pretrained=str(BASE_MODEL_PATH),
    )
    checkpoint = torch.load(TRAINED_CHECKPOINT_PATH, map_location=device, weights_only=False)
    model.load_state_dict(checkpoint["model"])
    model = model.to(device)
    model.eval()
    index = read_faiss_index_file(INDEX_PATH)
    products = json.loads(METADATA_PATH.read_text(encoding="utf-8"))
    price_metadata = {}
    if PRICE_METADATA_PATH.exists():
        price_metadata = json.loads(PRICE_METADATA_PATH.read_text(encoding="utf-8"))
    if index.ntotal != len(products):
        raise RuntimeError(f"索引数量 {index.ntotal} 与元数据数量 {len(products)} 不一致")
    tokenizer = open_clip.get_tokenizer(MODEL_NAME)
    return model, preprocess, tokenizer, device, index, products, price_metadata


def get_rank_window(top_k):
    """Clamp the requested result count to a safe full-index range."""
    return max(1, min(int(top_k), 100))


def encode_image(image, model, preprocess, device):
    """Encode one uploaded image with the trained CLIP image tower."""
    tensor = preprocess(image.convert("RGB")).unsqueeze(0).to(device)
    with torch.inference_mode():
        feature = model.encode_image(tensor)
        feature = feature / feature.norm(dim=-1, keepdim=True)
    return feature.cpu().numpy().astype("float32")


def encode_text(query, model, tokenizer, device):
    """Encode one prompt with the trained CLIP text tower."""
    tokens = tokenizer([query]).to(device)
    with torch.inference_mode():
        feature = model.encode_text(tokens)
        feature = feature / feature.norm(dim=-1, keepdim=True)
    return feature.cpu().numpy().astype("float32")


def search_index(
    query_vector,
    top_k,
    index,
    products,
    price_metadata,
    min_price=None,
    max_price=None,
):
    """Search FAISS and apply an optional price constraint before returning Top K."""
    output_count = get_rank_window(top_k)
    search_count = index.ntotal if min_price is not None or max_price is not None else output_count
    scores, indices = index.search(query_vector, search_count)
    results = []
    for result_position in range(len(indices[0])):
        product_index = int(indices[0][result_position])
        if product_index < 0 or product_index >= len(products):
            continue
        product = products[product_index].copy()
        product["similarity"] = round(float(scores[0][result_position]) * 100, 2)
        product["img_url"] = f"/images/{product['id']}.jpg"
        product_id = str(product["id"])
        if product_id in price_metadata:
            product.update(price_metadata[product_id])
        if min_price is not None or max_price is not None:
            price = product.get("price_usd")
            if price is None:
                continue
            if min_price is not None and float(price) < float(min_price):
                continue
            if max_price is not None and float(price) > float(max_price):
                continue
        product["rank"] = len(results) + 1
        results.append(product)
        if len(results) >= output_count:
            break
    return results


def resolve_image_from_request(file, img_url):
    """Read an uploaded image or an allowed local image URL into PIL."""
    if isinstance(file, (bytes, bytearray)) and file:
        return Image.open(io.BytesIO(file)).convert("RGB")
    if file and file.filename:
        return Image.open(io.BytesIO(file)).convert("RGB")
    if img_url:
        parsed_url = urlparse(img_url)
        local_name = os.path.basename(parsed_url.path)
        local_path = IMAGE_DIR / local_name
        if parsed_url.path.startswith("/images/") and local_path.exists():
            return Image.open(local_path).convert("RGB")
    raise ValueError("没有提供有效图片")


def merge_search_results(image_results, text_results, image_weight):
    """Merge image and listing search results by product ID and CLIP score."""
    result_by_id = {}
    text_weight = 1.0 - image_weight
    for product in image_results:
        product_id = str(product.get("id", ""))
        item = product.copy()
        item["image_similarity"] = float(product.get("similarity", 0.0))
        item["text_similarity"] = 0.0
        result_by_id[product_id] = item
    for product in text_results:
        product_id = str(product.get("id", ""))
        if product_id not in result_by_id:
            item = product.copy()
            item["image_similarity"] = 0.0
            item["text_similarity"] = float(product.get("similarity", 0.0))
            result_by_id[product_id] = item
        else:
            result_by_id[product_id]["text_similarity"] = float(product.get("similarity", 0.0))
    results = []
    for item in result_by_id.values():
        item["similarity"] = round(
            item["image_similarity"] * image_weight
            + item["text_similarity"] * text_weight,
            2,
        )
        results.append(item)
    index = 0
    while index < len(results):
        best_index = index
        candidate_index = index + 1
        while candidate_index < len(results):
            if results[candidate_index]["similarity"] > results[best_index]["similarity"]:
                best_index = candidate_index
            candidate_index += 1
        if best_index != index:
            results[index], results[best_index] = results[best_index], results[index]
        results[index]["rank"] = index + 1
        index += 1
    return results


def filter_by_price(products, min_price, max_price):
    """Keep products inside the requested USD price range."""
    if min_price is None and max_price is None:
        return products
    filtered = []
    for product in products:
        price = product.get("price_usd")
        if price is None:
            continue
        if min_price is not None and float(price) < float(min_price):
            continue
        if max_price is not None and float(price) > float(max_price):
            continue
        filtered.append(product)
    return filtered


def image_to_data_url(image):
    """Resize an input image and encode it as a compact Kimi data URL."""
    image_copy = image.copy().convert("RGB")
    image_copy.thumbnail((1280, 1280))
    image_buffer = io.BytesIO()
    image_copy.save(image_buffer, format="JPEG", quality=85, optimize=True)
    encoded = base64.b64encode(image_buffer.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"


def build_clip_evidence(image, listing, model, preprocess, tokenizer, device, index, products, price_metadata):
    """Collect weak CLIP evidence so Kimi can correct noisy retrieval signals."""
    evidence = []
    if image is not None:
        image_vector = encode_image(image, model, preprocess, device)
        image_results = search_index(image_vector, 8, index, products, price_metadata)
        evidence.append({"source": "image", "results": image_results})
    if listing:
        listing_vector = encode_text(listing, model, tokenizer, device)
        listing_results = search_index(listing_vector, 8, index, products, price_metadata)
        evidence.append({"source": "listing", "results": listing_results})
    return evidence


def call_kimi(image, listing, min_price, max_price, clip_evidence):
    """Call domestic Kimi K2.6 in JSON and non-thinking mode."""
    api_key = KIMI_CONFIG["api_key"]
    if not api_key:
        raise RuntimeError(f"未配置 {CONFIG_PATH.name} 里的 kimi.api_key 或 {KIMI_API_KEY_ENV} 环境变量")
    price_rule = {
        "currency": "USD",
        "min": min_price,
        "max": max_price,
    }
    system_prompt = (
        "你是商品组货规划助手，不是单纯的相似商品检索器。"
        "请根据输入图片和Listing生成10个用于商品向量检索的中英文Prompt，目标是找出可以一起销售或一起购买的一组商品。"
        "CLIP召回结果不够精准，只能作为弱证据，禁止直接照抄CLIP误召回的品类。"
        "10个Prompt必须发散到不同组货方向，不能只是同一商品的颜色、材质或包装改写。"
        "10个方向依次覆盖：1核心相似品，2功能替代品，3互补配件，4共同使用工具，5配套耗材，6高概率一起购买的关联品，7收纳整理品，8包装展示品，9人群场景关联品，10套装组合方案。"
        "互补品必须和主商品的使用场景有明确关系，不要生成无关的氛围用品。"
        "例如主商品是扳手，可以发散到锤子、螺丝刀、卷尺、螺丝螺母、工具收纳包，而不是只生成不同颜色的扳手。"
        "Listing明确写出的品类优先；图片用于确认外观、颜色、形状和材质。"
        "如果图片和Listing明显冲突，内部自行纠偏，并优先保留Listing主品类。"
        "只能返回合法JSON对象，且只能有一个字段 prompts。"
        "prompts 必须是长度为10的数组，数组元素只能是对象，且只能包含 zh 和 en 两个字段。"
        "zh 是简短具体的中文检索词，en 是语义完全一致的英文检索词。"
        "不要返回plan_name、summary、role、reason、price_filter、input_conflict或clip_adjustment。"
    )
    user_text = (
        "输入Listing:\n"
        + (listing or "未提供")
        + "\n价格筛选（美元）:\n"
        + json.dumps(price_rule, ensure_ascii=False)
        + "\nCLIP弱证据（可能不准确，只用于发现偏差）:\n"
        + json.dumps(clip_evidence, ensure_ascii=False)
        + "\n请只返回JSON对象，不要Markdown代码围栏。"
    )
    content = [{"type": "text", "text": user_text}]
    if image is not None:
        content.insert(
            0,
            {
                "type": "image_url",
                "image_url": {"url": image_to_data_url(image)},
            },
        )
    payload = {
        "model": KIMI_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": content},
        ],
        "thinking": {"type": "disabled"},
        "temperature": KIMI_TEMPERATURE,
        "response_format": {"type": "json_object"},
        "max_completion_tokens": KIMI_MAX_COMPLETION_TOKENS,
    }
    request = urllib.request.Request(
        KIMI_API_URL,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    response_data = None
    attempt = 0
    while attempt < 3:
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                response_data = json.loads(response.read().decode("utf-8"))
            break
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            retryable = error.code in (429, 500, 502, 503, 504)
            if not retryable or attempt >= 2:
                raise RuntimeError(
                    f"Kimi API HTTP {error.code}: {detail[:500]}"
                ) from error
            retry_after = error.headers.get("Retry-After")
            try:
                delay = float(retry_after) if retry_after else 2.0 + attempt * 2.0
            except (TypeError, ValueError):
                delay = 2.0 + attempt * 2.0
            time.sleep(min(max(delay, 1.0), 10.0))
            attempt += 1
        except urllib.error.URLError as error:
            if attempt >= 2:
                raise RuntimeError(f"Kimi API 网络错误: {error.reason}") from error
            time.sleep(2.0 + attempt * 2.0)
            attempt += 1
    choices = response_data.get("choices", [])
    if not choices:
        raise RuntimeError("Kimi API 没有返回 choices")
    content_text = choices[0].get("message", {}).get("content", "")
    if isinstance(content_text, dict):
        return content_text
    try:
        return json.loads(content_text)
    except (TypeError, json.JSONDecodeError) as error:
        raise RuntimeError("Kimi 返回内容不是合法 JSON") from error


def normalize_kimi_prompts(raw_plan, listing, min_price, max_price):
    """Validate Kimi prompts and fill missing prompts without inventing products."""
    raw_prompts = raw_plan.get("prompts", []) if isinstance(raw_plan, dict) else []
    if not isinstance(raw_prompts, list):
        raw_prompts = []
    prompts = []
    default_roles = [
        "核心相似品",
        "功能替代品",
        "互补配件",
        "共同使用工具",
        "配套耗材",
        "关联加购品",
        "收纳整理品",
        "包装展示品",
        "人群场景关联品",
        "场景套装/收纳方案",
    ]
    for raw_prompt in raw_prompts:
        if isinstance(raw_prompt, dict):
            prompt_text = str(
                raw_prompt.get("zh", raw_prompt.get("prompt", ""))
            ).strip()
            prompt_english = str(
                raw_prompt.get("en", raw_prompt.get("prompt_en", ""))
            ).strip()
            prompt_role = raw_prompt.get(
                "role",
                default_roles[min(len(prompts), len(default_roles) - 1)],
            )
            prompt_reason = raw_prompt.get("reason", "适合图片和Listing检索")
        else:
            prompt_text = str(raw_prompt).strip()
            prompt_english = ""
            prompt_role = default_roles[min(len(prompts), len(default_roles) - 1)]
            prompt_reason = "适合图片和Listing检索"
        if not prompt_text:
            continue
        prompts.append(
            {
                "prompt": prompt_text,
                "prompt_en": prompt_english,
                "role": prompt_role,
                "reason": prompt_reason,
            }
        )
        if len(prompts) >= 10:
            break
    fallback_text = listing.strip() or "符合输入图片风格的商品"
    fallback_roles = [
        "核心相似品",
        "功能替代品",
        "互补配件",
        "共同使用工具",
        "配套耗材",
        "关联加购品",
        "收纳整理品",
        "包装展示品",
        "人群场景关联品",
        "场景套装/收纳方案",
    ]
    index = 0
    while len(prompts) < 10:
        prompts.append(
            {
                "prompt": f"{fallback_text}，{fallback_roles[index]}",
                "prompt_en": "",
                "role": fallback_roles[index],
                "reason": "Kimi未返回足够Prompt，使用Listing补足检索方向",
            }
        )
        index += 1
    return {"prompts": prompts}


def create_app():
    """Load runtime assets and create the FastAPI application."""
    model, preprocess, tokenizer, device, index, products, price_metadata = load_runtime()
    application = FastAPI(title="Full CLIP Product Search")
    application.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    if IMAGE_DIR.exists():
        application.mount("/images", StaticFiles(directory=IMAGE_DIR), name="images")

    @application.post("/api/search/image")
    async def search_image(
        file: UploadFile = File(None),
        img_url: str = Form(None),
        top_k: int = Form(12),
    ):
        """Search full product metadata using an uploaded image."""
        try:
            contents = await file.read() if file and file.filename else None
            image = resolve_image_from_request(contents, img_url)
            query_vector = encode_image(image, model, preprocess, device)
            return {"results": search_index(query_vector, top_k, index, products, price_metadata)}
        except Exception as error:
            return JSONResponse({"error": str(error)}, status_code=400)

    @application.post("/api/search/text")
    async def search_text(
        query: str = Form(...),
        top_k: int = Form(12),
    ):
        """Search full product metadata using a text prompt."""
        try:
            query_vector = encode_text(query, model, tokenizer, device)
            return {"results": search_index(query_vector, top_k, index, products, price_metadata)}
        except Exception as error:
            return JSONResponse({"error": str(error)}, status_code=400)

    @application.post("/api/assemble")
    async def assemble_products(
        file: UploadFile = File(None),
        listing: str = Form(""),
        min_price: float = Form(None),
        max_price: float = Form(None),
        top_k: int = Form(1),
    ):
        """Generate ten Kimi prompts and retrieve one product for each direction."""
        try:
            contents = await file.read() if file and file.filename else None
            image = resolve_image_from_request(contents, "") if contents else None
            if image is None and not listing.strip():
                raise ValueError("请至少提供图片或 Listing")
            clip_evidence = build_clip_evidence(
                image,
                listing.strip(),
                model,
                preprocess,
                tokenizer,
                device,
                index,
                products,
                price_metadata,
            )
            raw_plan = call_kimi(
                image,
                listing.strip(),
                min_price,
                max_price,
                clip_evidence,
            )
            plan = normalize_kimi_prompts(
                raw_plan,
                listing,
                min_price,
                max_price,
            )
            groups = []
            selected_results = []
            public_prompts = []
            prompt_index = 0
            while prompt_index < len(plan["prompts"]):
                prompt_item = plan["prompts"][prompt_index]
                prompt_text = prompt_item["prompt"]
                prompt_english = prompt_item.get("prompt_en", "").strip()
                public_prompts.append(
                    {"zh": prompt_text, "en": prompt_english}
                )
                recall_text = prompt_english or prompt_text
                prompt_vector = encode_text(recall_text, model, tokenizer, device)
                prompt_matches = search_index(
                    prompt_vector,
                    100,
                    index,
                    products,
                    price_metadata,
                    min_price,
                    max_price,
                )
                price_matches = prompt_matches
                group_results = []
                result_index = 0
                while result_index < min(1, len(price_matches)):
                    selected = price_matches[result_index].copy()
                    selected["prompt_index"] = prompt_index + 1
                    selected["search_prompt"] = prompt_text
                    selected["search_prompt_en"] = prompt_english
                    selected["prompt_role"] = prompt_item["role"]
                    selected["prompt_reason"] = prompt_item["reason"]
                    selected["prompt_rank"] = result_index + 1
                    group_results.append(selected)
                    selected_results.append(selected)
                    result_index += 1
                groups.append(
                    {
                        "prompt_index": prompt_index + 1,
                        "prompt": prompt_text,
                        "prompt_en": prompt_english,
                        "role": prompt_item["role"],
                        "reason": prompt_item["reason"],
                        "results": group_results,
                    }
                )
                prompt_index += 1
            return {
                "plan": {"prompts": public_prompts},
                "results": selected_results,
                "groups": groups,
                "prompts_searched": len(groups),
                "results_per_prompt": 1,
                "model": KIMI_MODEL,
                "thinking": "disabled",
            }
        except Exception as error:
            return JSONResponse({"error": str(error)}, status_code=400)

    @application.get("/api/index/status")
    async def index_status():
        """Return the loaded full-index count for a quick browser health check."""
        return {
            "vectors": index.ntotal,
            "products": len(products),
            "price_records": len(price_metadata),
            "device": str(device),
            "checkpoint": str(TRAINED_CHECKPOINT_PATH),
            "kimi_model": KIMI_MODEL,
            "kimi_configured": bool(KIMI_CONFIG["api_key"]),
        }

    @application.get("/", response_class=HTMLResponse)
    async def search_page():
        """Serve the standalone image and prompt search page."""
        return HTMLResponse(HTML_PATH.read_text(encoding="utf-8"))

    return application


app = create_app()


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8888)

"""Provide the cleaned pure-listing CLIP index for the integrated worker."""

import base64
import asyncio
import concurrent.futures
import io
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import faiss
import numpy as np
import open_clip
import torch
from fastapi import Body, FastAPI, File, Form, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image
import uvicorn


APP_ROOT = Path(__file__).resolve().parent.parent
BUNDLED_INDEX_DIR = APP_ROOT / "data" / "full_listing_index"
BUNDLED_MODEL_PATH = APP_ROOT / "models" / "open_clip_pytorch_model.bin"
CLIP_DIR = APP_ROOT if BUNDLED_INDEX_DIR.exists() and BUNDLED_MODEL_PATH.exists() else Path(r"F:\Clip")
LISTING_INDEX_DIR = CLIP_DIR / "data" / "full_listing_index"
INDEX_PATH = LISTING_INDEX_DIR / "products_listing.index"
METADATA_PATH = LISTING_INDEX_DIR / "products_listing_meta.json"
RUNTIME_METADATA_PATH = LISTING_INDEX_DIR / "products_listing_meta.runtime.json"
PRICE_METADATA_PATH = CLIP_DIR / "data" / "full_clip_index" / "products_full_prices.json"
PROGRESS_PATH = LISTING_INDEX_DIR / "progress.json"
REPORT_PATH = LISTING_INDEX_DIR / "cleaning_report.json"
BUILD_LOG_PATH = LISTING_INDEX_DIR / "build.log"
SERVER_LOG_PATH = APP_ROOT / "logs" / "server.log"
IMAGE_DIR = APP_ROOT / "images"
BASE_MODEL_PATH = CLIP_DIR / "models" / "open_clip_pytorch_model.bin"
TRAINED_CHECKPOINT_PATH = CLIP_DIR / "data" / "yunqi_clip_training" / "last_checkpoint.pt"
HTML_PATH = APP_ROOT / "app" / "listing_search.html" if (APP_ROOT / "app" / "listing_search.html").exists() else APP_ROOT / "listing_search.html"
BUILD_SCRIPT_PATH = APP_ROOT / "work" / "build_full_listing_index.py"
MODEL_NAME = "ViT-B-32"
CONFIG_PATH = APP_ROOT / "config.json"
RUNTIME_METADATA_FIELDS = [
    "id",
    "title",
    "listing_key",
    "family_key",
    "image_url",
    "price_usd",
    "sales_total",
]
KIMI_API_KEY_ENV = "MOONSHOT_API_KEY"
KIMI_ENDPOINT_ENV = "KIMI_ENDPOINT"
KIMI_MODEL_ENV = "KIMI_MODEL"
APP_CONFIG = {}
KIMI_CONFIG = {}
KIMI_API_URL = "https://api.moonshot.cn/v1/chat/completions"
KIMI_MODEL = "kimi-k2.6"
KIMI_TEMPERATURE = 0.6
KIMI_MAX_COMPLETION_TOKENS = 1200
KIMI_PROMPT_BATCH_RANGES = [(1, 3), (4, 6), (7, 10)]
KIMI_PROMPT_SLOT_RANGES = KIMI_PROMPT_BATCH_RANGES
DEFAULT_KIMI_SYSTEM_PROMPT = """
你是跨境电商组货商品检索词生成器。你只根据用户上传的图片生成可一起售卖/一起购买的商品检索词。

任务：输出10个“具体可采购商品”，用于后续纯 listing CLIP 检索。

生成原则：
1. 不要只找外观相似品；优先覆盖互补品、同场景加购、替代升级、耗材补充、收纳展示、维护清洁、配套工具、礼盒套装里的其他商品。
2. 每条必须是具体商品，不要写大类、策略、理由或营销词。不要输出“配件、用品、产品、套装、工具”这种过宽泛词，除非前面有清晰具体限定。
3. 中文 zh 要像能直接给采购看的商品短名：主体品类 + 关键材质/结构/场景/人群/规格，尽量 6-18 个中文字符。
4. 英文 en 要像英文 listing 标题检索词：6-14 个英文词，必须包含明确 product noun，并尽量包含 material / shape / color / scene / target user / size / function 中的2-4个要素。
5. 如果图片主体不确定，根据最明显视觉元素推断；不要解释不确定性。
6. 10条之间要有明显差异，避免同义改写刷数量。

输出格式：只返回合法 JSON 对象，且只能包含 prompts 字段。
prompts 是长度为10的数组，每个元素只能包含 zh 和 en 两个字段。
""".strip()

RUNTIME_CACHE = {
    "model": None,
    "tokenizer": None,
    "device": None,
    "index": None,
    "products": None,
    "prices": None,
}
BUILD_PROCESS = {"process": None}


def write_bundle_log(message, payload=None):
    """Write one compact bundle API log line for the Node diagnostics collector."""
    entry = {"message": str(message or ""), "payload": payload or {}}
    sys.stderr.write("[BUNDLE API] " + json.dumps(entry, ensure_ascii=True) + "\n")
    sys.stderr.flush()


def load_app_config():
    """Load local app configuration without requiring secrets to be committed."""
    if not CONFIG_PATH.exists():
        return {}
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def read_kimi_config():
    """Return Kimi settings from environment variables, config.json, and safe defaults."""
    config = APP_CONFIG.get("kimi", {}) if isinstance(APP_CONFIG, dict) else {}
    return {
        "api_key": os.environ.get(KIMI_API_KEY_ENV, "").strip() or str(config.get("api_key", "")).strip(),
        "endpoint": os.environ.get(KIMI_ENDPOINT_ENV, "").strip() or str(config.get("endpoint", KIMI_API_URL)).strip(),
        "model": os.environ.get(KIMI_MODEL_ENV, "").strip() or str(config.get("model", KIMI_MODEL)).strip(),
        "temperature": float(config.get("temperature", KIMI_TEMPERATURE)),
        "max_completion_tokens": int(config.get("max_completion_tokens", KIMI_MAX_COMPLETION_TOKENS)),
    }


def read_json_file(path, fallback):
    """Read a JSON file when it exists, otherwise return the fallback value."""
    if not path.exists():
        return fallback
    return json.loads(path.read_text(encoding="utf-8"))


def read_faiss_index_file(path):
    """Read a FAISS index through Python bytes so Windows Unicode paths stay valid."""
    index_bytes = np.frombuffer(path.read_bytes(), dtype="uint8")
    return faiss.deserialize_index(index_bytes)


def resolve_listing_metadata_path():
    """Return the slim runtime metadata when bundled, otherwise use the original build metadata."""
    if RUNTIME_METADATA_PATH.exists():
        return RUNTIME_METADATA_PATH
    return METADATA_PATH


def normalize_product_metadata_rows(rows):
    """Convert compact runtime metadata rows back into product dictionaries."""
    if not rows:
        return []
    if isinstance(rows[0], dict):
        return rows
    products = []
    for row in rows:
        product = {}
        values = row if isinstance(row, list) else []
        for index, field_name in enumerate(RUNTIME_METADATA_FIELDS):
            if index < len(values) and values[index] not in (None, ""):
                product[field_name] = values[index]
        products.append(product)
    return products


APP_CONFIG = load_app_config()
KIMI_CONFIG = read_kimi_config()
KIMI_API_URL = KIMI_CONFIG["endpoint"]
KIMI_MODEL = KIMI_CONFIG["model"]
KIMI_TEMPERATURE = KIMI_CONFIG["temperature"]
KIMI_MAX_COMPLETION_TOKENS = KIMI_CONFIG["max_completion_tokens"]


def append_server_log(message):
    """Append one timestamped server log line without recording secrets."""
    SERVER_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
    with SERVER_LOG_PATH.open("a", encoding="utf-8") as log_file:
        log_file.write(f"{timestamp} {message}\n")


def should_skip_access_log(path):
    """Return whether a noisy internal endpoint should be hidden from server logs."""
    return path in {"/api/index/status", "/api/server/log", "/api/cdn/image"}


def validate_cdn_image_url(image_url):
    """Validate that the proxied image URL is a plain HTTP(S) CDN URL."""
    parsed_url = urllib.parse.urlparse(str(image_url or "").strip())
    if parsed_url.scheme not in {"http", "https"}:
        raise ValueError("CDN image URL must be http or https")
    if not parsed_url.netloc:
        raise ValueError("CDN image URL host is missing")
    return parsed_url.geturl()


def fetch_cdn_image_bytes(safe_url):
    """Fetch one validated CDN image in a worker thread for the async proxy endpoint."""
    request = urllib.request.Request(
        safe_url,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        },
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=30) as cdn_response:
        image_bytes = cdn_response.read()
        content_type = cdn_response.headers.get("Content-Type", "image/jpeg")
        status_code = getattr(cdn_response, "status", 200)
    return image_bytes, content_type, status_code


def read_server_log_filtered(max_bytes):
    """Read recent server logs while hiding noisy internal heartbeat entries."""
    raw_log = read_tail(SERVER_LOG_PATH, max_bytes)
    hidden_patterns = [
        " /api/index/status ",
        " /api/server/log ",
        " /api/cdn/image ",
    ]
    visible_lines = []
    for line in raw_log.splitlines():
        if not line.startswith("20"):
            continue
        if any(pattern in line for pattern in hidden_patterns):
            continue
        visible_lines.append(line)
    return "\n".join(visible_lines)


def load_model_runtime():
    """Load the trained CLIP text tower only once per server process."""
    if RUNTIME_CACHE["model"] is not None:
        return
    if not BASE_MODEL_PATH.exists() or not TRAINED_CHECKPOINT_PATH.exists():
        raise FileNotFoundError("Base model or trained checkpoint is missing")
    write_bundle_log("CLIP load progress", {"stage": "model_base", "progress": 78, "message": "正在载入 CLIP 基础模型。", "status": "loading", "error": ""})
    device = torch.device("cpu")
    model, _, _ = open_clip.create_model_and_transforms(
        MODEL_NAME,
        pretrained=str(BASE_MODEL_PATH),
    )
    write_bundle_log("CLIP load progress", {"stage": "model_checkpoint", "progress": 87, "message": "正在载入 CLIP 训练权重。", "status": "loading", "error": ""})
    checkpoint = torch.load(TRAINED_CHECKPOINT_PATH, map_location=device, weights_only=False)
    model.load_state_dict(checkpoint["model"])
    model = model.to(device)
    model.eval()
    RUNTIME_CACHE["model"] = model
    RUNTIME_CACHE["tokenizer"] = open_clip.get_tokenizer(MODEL_NAME)
    RUNTIME_CACHE["device"] = device
    write_bundle_log("CLIP load progress", {"stage": "model_ready", "progress": 96, "message": "CLIP 模型已载入，正在完成初始化。", "status": "loading", "error": ""})


def load_index_runtime():
    """Load or reload the completed listing FAISS index and product metadata."""
    metadata_path = resolve_listing_metadata_path()
    if not INDEX_PATH.exists() or not metadata_path.exists():
        raise FileNotFoundError("Listing index is not ready; start the build first")
    progress = read_json_file(PROGRESS_PATH, {})
    if progress.get("status") != "complete":
        raise RuntimeError(
            f"Listing index is still building: {progress.get('completed', 0)}/{progress.get('total', 0)}"
        )
    index_mtime = INDEX_PATH.stat().st_mtime
    cached_mtime = RUNTIME_CACHE.get("index_mtime")
    if RUNTIME_CACHE["index"] is not None and cached_mtime == index_mtime:
        return
    write_bundle_log("CLIP load progress", {"stage": "index", "progress": 46, "message": "正在载入 FAISS 商品索引。", "status": "loading", "error": ""})
    RUNTIME_CACHE["index"] = read_faiss_index_file(INDEX_PATH)
    write_bundle_log("CLIP load progress", {"stage": "metadata", "progress": 60, "message": "正在载入商品元数据。", "status": "loading", "error": ""})
    RUNTIME_CACHE["products"] = normalize_product_metadata_rows(read_json_file(metadata_path, []))
    write_bundle_log("CLIP load progress", {"stage": "prices", "progress": 70, "message": "正在载入价格数据。", "status": "loading", "error": ""})
    RUNTIME_CACHE["prices"] = read_json_file(PRICE_METADATA_PATH, {})
    RUNTIME_CACHE["index_mtime"] = index_mtime
    if RUNTIME_CACHE["index"].ntotal != len(RUNTIME_CACHE["products"]):
        raise RuntimeError("Listing index count does not match metadata count")


def encode_text(query):
    """Encode one listing query with the trained CLIP text tower."""
    load_model_runtime()
    tokenizer = RUNTIME_CACHE["tokenizer"]
    model = RUNTIME_CACHE["model"]
    device = RUNTIME_CACHE["device"]
    tokens = tokenizer([query]).to(device)
    with torch.inference_mode():
        feature = model.encode_text(tokens)
        feature = feature / feature.norm(dim=-1, keepdim=True)
    return feature.cpu().numpy().astype("float32")


def get_rank_window(top_k):
    """Clamp the requested result count to a practical range."""
    return max(1, min(int(top_k), 100))


def should_keep_price(product, min_price, max_price):
    """Return whether a product is inside the optional USD price range."""
    if min_price is None and max_price is None:
        return True
    price = product.get("price_usd")
    if price is None:
        return False
    if min_price is not None and float(price) < float(min_price):
        return False
    if max_price is not None and float(price) > float(max_price):
        return False
    return True


def resolve_product_image_url(product):
    """Return the MAINIMAGE/CDN URL from metadata, or an empty string when unavailable."""
    image_fields = [
        "MAINIMAGE",
        "mainImage",
        "main_image",
        "mainimage",
        "image_url",
        "imgUrl",
        "img_url",
    ]
    for field_name in image_fields:
        image_value = str(product.get(field_name, "") or "").strip()
        if image_value.lower().startswith(("http://", "https://")):
            return image_value
    return ""


def add_sidecar_fields(product):
    """Attach price data and the required CDN image URL to one product."""
    product_id = str(product.get("id", ""))
    prices = RUNTIME_CACHE["prices"] or {}
    if product_id in prices:
        product.update(prices[product_id])
    product["img_url"] = resolve_product_image_url(product)
    return product


def search_listing_index(query_vector, top_k, min_price, max_price):
    """Search the text index and dedupe similar listing families before returning."""
    load_index_runtime()
    index = RUNTIME_CACHE["index"]
    products = RUNTIME_CACHE["products"]
    output_count = get_rank_window(top_k)
    if min_price is not None or max_price is not None:
        search_count = index.ntotal
    else:
        search_count = min(index.ntotal, max(output_count * 30, 300))
    scores, indices = index.search(query_vector, search_count)
    results = []
    seen_families = set()
    seen_images = set()
    result_position = 0
    while result_position < len(indices[0]):
        product_index = int(indices[0][result_position])
        if product_index < 0 or product_index >= len(products):
            result_position += 1
            continue
        product = products[product_index].copy()
        product = add_sidecar_fields(product)
        if not product.get("img_url"):
            result_position += 1
            continue
        if not should_keep_price(product, min_price, max_price):
            result_position += 1
            continue
        family_key = str(product.get("family_key", product.get("listing_key", "")))
        image_key = str(product.get("local_img", product.get("image_url", "")))
        if family_key in seen_families or image_key in seen_images:
            result_position += 1
            continue
        product["similarity"] = round(float(scores[0][result_position]) * 100, 2)
        product["rank"] = len(results) + 1
        product["source"] = "Listing"
        results.append(product)
        seen_families.add(family_key)
        seen_images.add(image_key)
        if len(results) >= output_count:
            break
        result_position += 1
    return results


def image_to_data_url(image):
    """Encode an uploaded image as a compact Kimi-compatible data URL."""
    image_copy = image.copy().convert("RGB")
    image_copy.thumbnail((1280, 1280))
    image_buffer = io.BytesIO()
    image_copy.save(image_buffer, format="JPEG", quality=85, optimize=True)
    encoded = base64.b64encode(image_buffer.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"


def read_uploaded_image(contents):
    """Read uploaded bytes into a normalized PIL image."""
    if not contents:
        return None
    return Image.open(io.BytesIO(contents)).convert("RGB")


def parse_kimi_prompt_json(response_data):
    """Extract the JSON prompt object from one Kimi chat completion response."""
    choices = response_data.get("choices", []) if isinstance(response_data, dict) else []
    if not choices:
        raise RuntimeError("Kimi API returned no choices")
    content_text = choices[0].get("message", {}).get("content", "")
    if isinstance(content_text, dict):
        return content_text
    try:
        return json.loads(content_text)
    except (TypeError, json.JSONDecodeError) as error:
        raise RuntimeError("Kimi response is not valid JSON") from error


def collect_kimi_batch_prompts(raw_plan):
    """Return valid prompts in the exact order supplied by one completed Kimi batch."""
    raw_prompts = raw_plan.get("prompts", []) if isinstance(raw_plan, dict) else []
    if not isinstance(raw_prompts, list):
        return []
    prompts = []
    skipped_count = 0
    for idx, raw_prompt in enumerate(raw_prompts):
        if isinstance(raw_prompt, dict):
            prompt_item = {
                "zh": str(raw_prompt.get("zh", raw_prompt.get("prompt", ""))).strip(),
                "en": str(raw_prompt.get("en", raw_prompt.get("prompt_en", ""))).strip(),
            }
        else:
            prompt_item = {"zh": str(raw_prompt).strip(), "en": ""}
        if prompt_item["zh"] or prompt_item["en"]:
            prompts.append(prompt_item)
        else:
            skipped_count += 1
            write_bundle_log("Kimi prompt skipped (empty)", {
                "index": idx,
                "raw": raw_prompt,
            })
    if skipped_count > 0:
        write_bundle_log("Kimi batch prompts collected", {
            "valid": len(prompts),
            "skipped": skipped_count,
            "total": len(raw_prompts),
        })
    return prompts


def call_kimi_prompt_batch(image_data_url, min_price, max_price, kimi_prompt, batch_start, batch_end, kimi_user_prompt=""):
    """Ask Kimi for one independent batch whose results keep provider return order."""
    api_key = KIMI_CONFIG["api_key"]
    if not api_key:
        raise RuntimeError(f"Missing Kimi api_key in {CONFIG_PATH.name} or {KIMI_API_KEY_ENV} environment variable")
    price_rule = {"currency": "USD", "min": min_price, "max": max_price}
    batch_count = max(1, batch_end - batch_start + 1)
    system_prompt = (kimi_prompt or DEFAULT_KIMI_SYSTEM_PROMPT).strip()
    user_prompt = str(kimi_user_prompt or "").strip()
    schema_guard = (
        "\n\n硬性输出约束：只返回合法JSON对象，不能返回Markdown代码围栏。"
        f"JSON只能包含prompts字段；prompts必须是长度为{batch_count}的数组；"
        "每个元素只能包含zh和en两个字段，不要输出slot。"
    )
    user_text = (
        (user_prompt + "\n\n" if user_prompt else "")
        + f"请生成本批次的 {batch_count} 个 CLIP 检索方向。"
        "这些结果会按照各批次实际返回先后拼接，不要输出编号。\n"
        "Price filter:\n"
        + json.dumps(price_rule, ensure_ascii=False)
        + "\n只返回JSON，不要Markdown代码围栏。"
    )
    content = [{"type": "text", "text": user_text}]
    if image_data_url:
        content.insert(0, {"type": "image_url", "image_url": {"url": image_data_url}})
    payload = {
        "model": KIMI_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt + schema_guard},
            {"role": "user", "content": content},
        ],
        "thinking": {"type": "disabled"},
        "temperature": KIMI_TEMPERATURE,
        "response_format": {"type": "json_object"},
        "max_completion_tokens": min(KIMI_MAX_COMPLETION_TOKENS, 650),
    }
    request = urllib.request.Request(
        KIMI_API_URL,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    response_data = None
    attempt = 0
    while attempt < 3:
        try:
            write_bundle_log("Kimi prompts POST", {
                "endpoint": KIMI_API_URL,
                "model": KIMI_MODEL,
                "attempt": attempt + 1,
                "batch_start": batch_start,
                "batch_end": batch_end,
                "min_price": min_price,
                "max_price": max_price,
            })
            with urllib.request.urlopen(request, timeout=120) as response:
                response_data = json.loads(response.read().decode("utf-8"))
            write_bundle_log("Kimi prompts response", {
                "status": "ok",
                "model": KIMI_MODEL,
                "attempt": attempt + 1,
                "batch_start": batch_start,
                "batch_end": batch_end,
            })
            break
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            write_bundle_log("Kimi prompts HTTP error", {
                "status": error.code,
                "attempt": attempt + 1,
                "batch_start": batch_start,
                "batch_end": batch_end,
                "detail": detail[:300],
            })
            if error.code not in (429, 500, 502, 503, 504) or attempt >= 2:
                raise RuntimeError(f"Kimi API HTTP {error.code}: {detail[:500]}") from error
            retry_after = error.headers.get("Retry-After")
            try:
                delay = float(retry_after) if retry_after else 2.0 + attempt * 2.0
            except (TypeError, ValueError):
                delay = 2.0 + attempt * 2.0
            time.sleep(min(max(delay, 1.0), 10.0))
            attempt += 1
        except urllib.error.URLError as error:
            write_bundle_log("Kimi prompts network error", {
                "attempt": attempt + 1,
                "batch_start": batch_start,
                "batch_end": batch_end,
                "reason": str(error.reason),
            })
            if attempt >= 2:
                raise RuntimeError(f"Kimi API network error: {error.reason}") from error
            time.sleep(2.0 + attempt * 2.0)
            attempt += 1
    raw_plan = parse_kimi_prompt_json(response_data)
    prompts = collect_kimi_batch_prompts(raw_plan)
    write_bundle_log("Kimi batch complete", {
        "batch_start": batch_start,
        "batch_end": batch_end,
        "expected_count": batch_end - batch_start + 1,
        "actual_count": len(prompts),
        "raw_response": response_data,
    })
    return prompts


def call_kimi_prompts(image, min_price, max_price, kimi_prompt, max_workers=3, on_batch_completed=None, kimi_user_prompt=""):
    """Ask Kimi concurrently for ten JSON bundle-product prompts, ordered by completion time."""
    image_data_url = image_to_data_url(image) if image is not None else ""
    batch_ranges = KIMI_PROMPT_BATCH_RANGES
    safe_workers = max(1, min(int(max_workers or 1), len(batch_ranges)))
    completed_prompts = []
    errors = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=safe_workers) as executor:
        future_map = {}
        for batch_start, batch_end in batch_ranges:
            future = executor.submit(
                call_kimi_prompt_batch,
                image_data_url,
                min_price,
                max_price,
                kimi_prompt,
                batch_start,
                batch_end,
                kimi_user_prompt,
            )
            future_map[future] = (batch_start, batch_end)
        for future in concurrent.futures.as_completed(future_map):
            batch_start, batch_end = future_map[future]
            try:
                batch_prompts = future.result()
                completed_prompts.extend(batch_prompts)
                if callable(on_batch_completed) and batch_prompts:
                    on_batch_completed(batch_start, batch_end, batch_prompts)
            except Exception as error:
                errors.append(f"{batch_start}-{batch_end}: {error}")
                write_bundle_log("Kimi prompt batch failed", {
                    "batch_start": batch_start,
                    "batch_end": batch_end,
                    "error": str(error),
                })
    if not completed_prompts and errors:
        raise RuntimeError("Kimi parallel prompts failed: " + "; ".join(errors))
    write_bundle_log("Kimi all batches complete", {
        "total_prompts": len(completed_prompts),
        "expected_total": sum(end - start + 1 for start, end in batch_ranges),
        "batch_count": len(batch_ranges),
        "errors": errors,
    })
    return {"prompts": completed_prompts, "batch_errors": errors, "batch_workers": safe_workers}


def normalize_kimi_prompts(raw_plan, fill_missing=True):
    """Validate Kimi prompts and optionally fill missing directions."""
    raw_prompts = raw_plan.get("prompts", []) if isinstance(raw_plan, dict) else []
    if not isinstance(raw_prompts, list):
        raw_prompts = []
    prompts = []
    for raw_prompt in raw_prompts:
        if isinstance(raw_prompt, dict):
            prompt_zh = str(raw_prompt.get("zh", raw_prompt.get("prompt", ""))).strip()
            prompt_en = str(raw_prompt.get("en", raw_prompt.get("prompt_en", ""))).strip()
        else:
            prompt_zh = str(raw_prompt).strip()
            prompt_en = ""
        if not prompt_zh and not prompt_en:
            continue
        prompts.append({"zh": prompt_zh, "en": prompt_en})
        if len(prompts) >= 10:
            break
    fallback_text = "related product bundle"
    if fill_missing:
        while len(prompts) < 10:
            prompts.append({"zh": fallback_text, "en": fallback_text})
    return {"prompts": prompts}


def search_prompt_groups(prompts, min_price, max_price, top_k, prompt_offset=0):
    """Run each Kimi prompt through the listing CLIP index and group results."""
    groups = []
    selected_results = []
    prompt_index = 0
    while prompt_index < len(prompts):
        prompt_item = prompts[prompt_index]
        recall_text = prompt_item.get("en") or prompt_item.get("zh") or ""
        query_vector = encode_text(recall_text)
        matches = search_listing_index(query_vector, top_k, min_price, max_price)
        group_results = []
        result_index = 0
        while result_index < len(matches):
            product = matches[result_index].copy()
            product["prompt_index"] = prompt_offset + prompt_index + 1
            product["search_prompt"] = prompt_item.get("zh", "")
            product["search_prompt_en"] = prompt_item.get("en", "")
            product["prompt_rank"] = result_index + 1
            group_results.append(product)
            selected_results.append(product)
            result_index += 1
        groups.append(
            {
                "prompt_index": prompt_offset + prompt_index + 1,
                "prompt": prompt_item.get("zh", ""),
                "prompt_en": prompt_item.get("en", ""),
                "results": group_results,
            }
        )
        prompt_index += 1
    return groups, selected_results


def read_tail(path, max_bytes):
    """Read the end of a log file without loading the whole file."""
    if not path.exists():
        return ""
    with path.open("rb") as log_file:
        log_file.seek(0, os.SEEK_END)
        size = log_file.tell()
        log_file.seek(max(0, size - max_bytes), os.SEEK_SET)
        return log_file.read().decode("utf-8", errors="replace")


def is_build_running():
    """Return whether the current build subprocess is still active."""
    process = BUILD_PROCESS.get("process")
    if process is None:
        return False
    return process.poll() is None


def start_build_process(batch_size, force_clean):
    """Start the listing-index build in the background and append logs."""
    if is_build_running():
        return False
    LISTING_INDEX_DIR.mkdir(parents=True, exist_ok=True)
    command = [
        sys.executable,
        str(BUILD_SCRIPT_PATH),
        "--batch-size",
        str(max(1, min(int(batch_size), 2048))),
    ]
    if force_clean:
        command.append("--force-clean")
    log_file = BUILD_LOG_PATH.open("a", encoding="utf-8")
    log_file.write(f"\nserver_start_build {command}\n")
    log_file.flush()
    BUILD_PROCESS["process"] = subprocess.Popen(
        command,
        stdout=log_file,
        stderr=subprocess.STDOUT,
        cwd=str(BUILD_SCRIPT_PATH.parent),
    )
    return True


def build_status_payload():
    """Return progress, cleaning report, and recent build log for the UI."""
    progress = read_json_file(PROGRESS_PATH, {})
    report = read_json_file(REPORT_PATH, {})
    inferred_running = is_build_running()
    if not inferred_running and progress.get("status") == "building":
        completed = int(progress.get("completed", 0) or 0)
        total = int(progress.get("total", 0) or 0)
        inferred_running = total > 0 and completed < total
    payload = {
        "running": inferred_running,
        "progress": progress,
        "report": report,
        "log": read_tail(BUILD_LOG_PATH, 20000),
        "index_exists": INDEX_PATH.exists(),
        "metadata_exists": resolve_listing_metadata_path().exists(),
    }
    if INDEX_PATH.exists():
        payload["index_size_mb"] = round(INDEX_PATH.stat().st_size / 1024 / 1024, 2)
    return payload


def create_app():
    """Create the legacy FastAPI application for pure listing search."""
    application = FastAPI(title="Pure Listing CLIP Search")
    application.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    if IMAGE_DIR.exists():
        application.mount("/listing-images", StaticFiles(directory=IMAGE_DIR), name="listing-images")

    @application.middleware("http")
    async def log_http_request(request: Request, call_next):
        """Write one compact access log line for every API/page request."""
        started_at = time.perf_counter()
        skip_access_log = should_skip_access_log(request.url.path)
        try:
            response = await call_next(request)
        except Exception as error:
            duration_ms = int((time.perf_counter() - started_at) * 1000)
            if not skip_access_log:
                append_server_log(
                    f"{request.method} {request.url.path} ERROR {duration_ms}ms {type(error).__name__}: {error}"
                )
            raise
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        if not skip_access_log:
            append_server_log(
                f"{request.method} {request.url.path} {response.status_code} {duration_ms}ms"
            )
        return response

    @application.get("/api/server/log", response_class=PlainTextResponse)
    async def server_log(max_bytes: int = 50000):
        """Return the recent local server log as plain text."""
        safe_max_bytes = max(1000, min(int(max_bytes), 1000000))
        return PlainTextResponse(read_server_log_filtered(safe_max_bytes))

    @application.get("/api/cdn/image")
    async def proxy_cdn_image(url: str):
        """Fetch one remote CDN image through this server so the request is visible in logs."""
        started_at = time.perf_counter()
        try:
            safe_url = validate_cdn_image_url(url)
            image_bytes, content_type, status_code = await asyncio.to_thread(fetch_cdn_image_bytes, safe_url)
            duration_ms = int((time.perf_counter() - started_at) * 1000)
            append_server_log(f"CDN GET {safe_url} {status_code} {len(image_bytes)}B {duration_ms}ms")
            return Response(
                content=image_bytes,
                media_type=content_type,
                headers={"Cache-Control": "public, max-age=86400"},
            )
        except Exception as error:
            duration_ms = int((time.perf_counter() - started_at) * 1000)
            append_server_log(f"CDN GET {url} ERROR {duration_ms}ms {type(error).__name__}: {error}")
            return Response(status_code=502)

    @application.post("/api/index/build/start")
    async def start_index_build(
        batch_size: int = Form(256),
        force_clean: bool = Form(False),
    ):
        """Start a background cleaned listing-index build."""
        try:
            started = start_build_process(batch_size, force_clean)
            return {"started": started, "status": build_status_payload()}
        except Exception as error:
            return JSONResponse({"error": str(error)}, status_code=400)

    @application.get("/api/index/status")
    async def index_status():
        """Return listing-index build and load status."""
        status = build_status_payload()
        status["kimi_model"] = KIMI_MODEL
        status["kimi_configured"] = bool(KIMI_CONFIG["api_key"])
        if INDEX_PATH.exists() and METADATA_PATH.exists():
            try:
                load_index_runtime()
                status["vectors"] = RUNTIME_CACHE["index"].ntotal
                status["products"] = len(RUNTIME_CACHE["products"])
                status["price_records"] = len(RUNTIME_CACHE["prices"])
            except Exception as error:
                status["load_error"] = str(error)
        return status

    @application.post("/api/search/text")
    async def search_text(
        query: str = Form(...),
        top_k: int = Form(24),
        min_price: float = Form(None),
        max_price: float = Form(None),
    ):
        """Search the cleaned pure-listing index."""
        try:
            if not query.strip():
                raise ValueError("Query is empty")
            query_vector = encode_text(query.strip())
            results = search_listing_index(query_vector, top_k, min_price, max_price)
            return {"results": results}
        except Exception as error:
            return JSONResponse({"error": str(error)}, status_code=400)

    @application.post("/api/search/prompts")
    async def search_prompts(payload: dict = Body(...)):
        """Search the listing index with manually edited Kimi prompt JSON."""
        try:
            plan = normalize_kimi_prompts(payload, fill_missing=False)
            if not plan["prompts"]:
                raise ValueError("Edited prompts are empty")
            min_price = payload.get("min_price")
            max_price = payload.get("max_price")
            safe_top_k = max(1, min(int(payload.get("top_k", 1)), 10))
            groups, selected_results = search_prompt_groups(
                plan["prompts"],
                min_price,
                max_price,
                safe_top_k,
            )
            return {
                "plan": plan,
                "groups": groups,
                "results": selected_results,
                "prompts_searched": len(groups),
                "results_per_prompt": safe_top_k,
                "source": "edited_prompts",
            }
        except Exception as error:
            return JSONResponse({"error": str(error)}, status_code=400)

    @application.post("/api/assemble")
    async def assemble_products(
        file: UploadFile = File(None),
        listing: str = Form(""),
        kimi_prompt: str = Form(""),
        top_k: int = Form(2),
        min_price: float = Form(None),
        max_price: float = Form(None),
    ):
        """Run image-only Kimi JSON prompts, then search the listing CLIP index.
        核心流程（按你要求）：
        - Kimi 生成 10 个方向（3+3+4 并发）
        - 哪个 Kimi 批次先返回，哪个批次先进入 CLIP
        - 当前接口保持一次性返回，不使用 SSE
        - 最终固定返回 10 个商品，按 Kimi 实际返回顺序排序
        """
        try:
            contents = await file.read() if file and file.filename else None
            image = read_uploaded_image(contents)
            if image is None:
                raise ValueError("Please upload an image for Kimi bundle generation")
            effective_system_prompt = DEFAULT_KIMI_SYSTEM_PROMPT
            effective_user_prompt = kimi_prompt.strip()
            safe_top_k = max(1, min(int(top_k), 10))
            batch_groups = []
            selected_results = []
            searched_prompt_count = 0

            def search_completed_kimi_batch(_batch_start, _batch_end, batch_prompts):
                """Search one completed Kimi batch before slower Kimi batches finish."""
                nonlocal searched_prompt_count
                batch_plan = normalize_kimi_prompts({"prompts": batch_prompts}, fill_missing=False)
                prompts = batch_plan["prompts"]
                if not prompts:
                    return
                groups, batch_results = search_prompt_groups(
                    prompts,
                    min_price,
                    max_price,
                    safe_top_k,
                    searched_prompt_count,
                )
                searched_prompt_count += len(prompts)
                batch_groups.extend(groups)
                selected_results.extend(batch_results)

            # === Kimi 批次返回后立即进入 CLIP，接口最终一次返回 ===
            raw_plan = call_kimi_prompts(
                image,
                min_price,
                max_price,
                effective_system_prompt,
                on_batch_completed=search_completed_kimi_batch,
                kimi_user_prompt=effective_user_prompt,
            )
            plan = normalize_kimi_prompts(raw_plan)
            groups = batch_groups
            if not groups:
                groups, selected_results = search_prompt_groups(plan["prompts"], min_price, max_price, safe_top_k)

            # === 固定返回 10 个商品 ===
            if len(selected_results) > 10:
                selected_results = selected_results[:10]
            elif len(selected_results) < 10:
                while len(selected_results) < 10:
                    selected_results.append({
                        "id": f"fallback-{len(selected_results)}",
                        "title": "related product bundle",
                        "prompt_index": 1,
                        "search_prompt": "",
                        "search_prompt_en": "",
                        "prompt_rank": 1,
                        "similarity": 50.0,
                        "source": "fallback"
                    })

            return {
                "plan": plan,
                "groups": groups,
                "results": selected_results,
                "prompts_searched": len(groups),
                "results_per_prompt": safe_top_k,
                "model": KIMI_MODEL,
                "thinking": "disabled",
                "kimi_prompt": effective_user_prompt,
                "return_count": len(selected_results)
            }
        except Exception as error:
            return JSONResponse({"error": str(error)}, status_code=400)

    @application.get("/", response_class=HTMLResponse)
    async def listing_page():
        """Serve the standalone pure-listing search page."""
        return HTMLResponse(HTML_PATH.read_text(encoding="utf-8"))

    return application


app = create_app()


if __name__ == "__main__":
    raise SystemExit("9990 HTTP service is disabled. Use stdio_listing_worker.py through the 3000 server.")

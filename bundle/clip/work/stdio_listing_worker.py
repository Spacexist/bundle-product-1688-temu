"""Serve CLIP listing operations over stdin/stdout without opening an HTTP port."""

import base64
import json
import sys

from full_listing_server import (
    call_kimi_prompts,
    read_uploaded_image,
    normalize_kimi_prompts,
    search_prompt_groups,
    encode_text,
    search_listing_index,
    build_status_payload,
    load_index_runtime,
    RUNTIME_CACHE,
    KIMI_CONFIG,
    KIMI_MODEL,
    DEFAULT_KIMI_SYSTEM_PROMPT,
)


def configure_stdio_encoding():
    """Force safe UTF-8 stream writes even when data contains surrogate escapes."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure:
            reconfigure(encoding="utf-8", errors="backslashreplace")


def write_json_line(payload):
    """Write one JSON response line and flush immediately for the Node parent."""
    sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def read_optional_float(value):
    """Convert one optional numeric value from JSON into a float or None."""
    if value is None or value == "":
        return None
    return float(value)


def read_uploaded_image_from_base64(value):
    """Decode one base64 image payload into a normalized PIL image."""
    if not value:
        return None
    return read_uploaded_image(base64.b64decode(str(value)))


def handle_index_status(_payload):
    """Return listing-index readiness without requiring an HTTP request."""
    status = build_status_payload()
    status["kimi_model"] = KIMI_MODEL
    status["kimi_configured"] = bool(KIMI_CONFIG["api_key"])
    try:
        load_index_runtime()
        status["vectors"] = RUNTIME_CACHE["index"].ntotal
        status["products"] = len(RUNTIME_CACHE["products"])
        status["price_records"] = len(RUNTIME_CACHE["prices"])
    except Exception as error:
        status["load_error"] = str(error)
    return status


def handle_search_text(payload):
    """Search the listing CLIP index with one manual keyword."""
    query = str(payload.get("query", "")).strip()
    if not query:
        raise ValueError("Query is empty")
    top_k = max(1, min(int(payload.get("top_k", 24)), 100))
    min_price = read_optional_float(payload.get("min_price"))
    max_price = read_optional_float(payload.get("max_price"))
    query_vector = encode_text(query)
    return {"results": search_listing_index(query_vector, top_k, min_price, max_price)}


def handle_assemble(payload):
    """Run image-only Kimi JSON prompts, then search the listing CLIP index."""
    image = read_uploaded_image_from_base64(payload.get("image_base64"))
    if image is None:
        raise ValueError("Please provide an image for Kimi bundle generation")
    min_price = read_optional_float(payload.get("min_price"))
    max_price = read_optional_float(payload.get("max_price"))
    effective_system_prompt = str(payload.get("kimi_system_prompt", "")).strip() or DEFAULT_KIMI_SYSTEM_PROMPT
    effective_user_prompt = str(payload.get("kimi_prompt", "")).strip()
    safe_top_k = max(1, min(int(payload.get("top_k", 2)), 10))
    batch_groups = []
    batch_selected_results = []
    searched_prompt_count = 0

    def search_completed_kimi_batch(_batch_start, _batch_end, batch_prompts):
        """Search one returned Kimi batch immediately so later Kimi calls do not block CLIP."""
        nonlocal searched_prompt_count
        batch_plan = normalize_kimi_prompts({"prompts": batch_prompts}, fill_missing=False)
        prompts = batch_plan["prompts"]
        if not prompts:
            return
        groups, selected_results = search_prompt_groups(
            prompts,
            min_price,
            max_price,
            safe_top_k,
            searched_prompt_count,
        )
        searched_prompt_count += len(prompts)
        batch_groups.extend(groups)
        batch_selected_results.extend(selected_results)

    raw_plan = call_kimi_prompts(
        image,
        min_price,
        max_price,
        effective_system_prompt,
        on_batch_completed=search_completed_kimi_batch,
        kimi_user_prompt=effective_user_prompt,
    )
    plan = normalize_kimi_prompts(raw_plan)
    if batch_groups:
        groups = batch_groups
        selected_results = batch_selected_results
    else:
        groups, selected_results = search_prompt_groups(plan["prompts"], min_price, max_price, safe_top_k)
    return {
        "plan": plan,
        "groups": groups,
        "results": selected_results,
        "prompts_searched": len(groups),
        "results_per_prompt": safe_top_k,
        "model": KIMI_MODEL,
        "thinking": "disabled",
        "kimi_prompt": effective_user_prompt,
    }


def dispatch(payload):
    """Route one worker JSON command to the matching CLIP operation."""
    action = str(payload.get("action", "")).strip()
    if action == "index_status":
        return handle_index_status(payload)
    if action == "search_text":
        return handle_search_text(payload)
    if action == "assemble":
        return handle_assemble(payload)
    raise ValueError("Unknown CLIP worker action: " + action)


def main():
    """Read JSON-line requests forever and return JSON-line responses."""
    for line in sys.stdin:
        text = line.strip()
        if not text:
            continue
        request = {}
        try:
            request = json.loads(text)
            request_id = request.get("id")
            result = dispatch(request)
            write_json_line({"id": request_id, "ok": True, "result": result})
        except Exception as error:
            write_json_line({
                "id": request.get("id", ""),
                "ok": False,
                "error": str(error),
            })


if __name__ == "__main__":
    configure_stdio_encoding()
    main()

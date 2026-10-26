#!/usr/bin/env python3
"""Extract CogineWork's public built-in registry without importing the app.

Only committed repository source and packaged catalog data are read. This
does not read runtime settings, credentials, account catalogs or local models.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import subprocess
from collections import Counter
from pathlib import Path


class StaticValues:
    def __init__(self, catalog: dict[str, list[dict]]):
        self.values: dict = {}
        self.catalog = catalog
        self.locations: dict[str, dict] = {}

    def evaluate(self, node: ast.AST):
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.Name):
            return self.values[node.id]
        if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
            return [self.evaluate(item) for item in node.elts]
        if isinstance(node, ast.Dict):
            return {self.evaluate(key): self.evaluate(value) for key, value in zip(node.keys, node.values)}
        if isinstance(node, ast.JoinedStr):
            return "".join(str(self.evaluate(part.value)) if isinstance(part, ast.FormattedValue) else str(part.value) for part in node.values)
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            return self.evaluate(node.left) + self.evaluate(node.right)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            name = node.func.id
            if name == "_models":
                return self.catalog[self.evaluate(node.args[0])]
            if name in {"frozenset", "tuple", "list"}:
                return self.evaluate(node.args[0]) if node.args else []
            if name == "ProviderDiscoveryPolicy":
                result = {"strategy": self.evaluate(node.args[0]), "sync_mode": "manual", "requires_auth": True, "reason": ""}
            elif name == "ModelInfo" or name.endswith("Provider"):
                result = {"_constructor": name}
            else:
                raise ValueError(f"Unsupported static constructor: {name}")
            result.update({keyword.arg: self.evaluate(keyword.value) for keyword in node.keywords if keyword.arg})
            return result
        raise ValueError(f"Unsupported static expression: {ast.dump(node)[:160]}")

    def load(self, root: Path, relative: str):
        tree = ast.parse((root / relative).read_text())
        for statement in tree.body:
            if isinstance(statement, ast.Assign) and len(statement.targets) == 1 and isinstance(statement.targets[0], ast.Name):
                name, value = statement.targets[0].id, statement.value
            elif isinstance(statement, ast.AnnAssign) and isinstance(statement.target, ast.Name) and statement.value is not None:
                name, value = statement.target.id, statement.value
            else:
                continue
            try:
                self.values[name] = self.evaluate(value)
                self.locations[name] = {"file": relative, "line": statement.lineno}
            except (KeyError, TypeError, ValueError):
                # No eval/exec or application import: unrelated runtime state
                # expressions are deliberately outside this extractor.
                continue


def source_hash(root: Path, relative: str, head: str) -> dict:
    content = (root / relative).read_bytes()
    committed = subprocess.check_output(["git", "show", f"{head}:{relative}"], cwd=root)
    if content != committed:
        raise ValueError(f"Source file differs from pinned CogineWork HEAD: {relative}")
    return {"file": relative, "sha256": hashlib.sha256(content).hexdigest()}


def run_git(root: Path, *args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=root, text=True).strip()


def declaration(root: Path, relative: str, name: str) -> dict:
    tree = ast.parse((root / relative).read_text())
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == name:
            return {"file": relative, "line": node.lineno}
    raise ValueError(f"Missing source declaration: {relative}:{name}")


def mapping_locations(root: Path, relative: str, name: str) -> dict[str, dict]:
    tree = ast.parse((root / relative).read_text())
    for node in tree.body:
        target = node.target if isinstance(node, ast.AnnAssign) else node.targets[0] if isinstance(node, ast.Assign) and len(node.targets) == 1 else None
        if isinstance(target, ast.Name) and target.id == name and isinstance(node.value, ast.Dict):
            return {key.value: {"file": relative, "line": key.lineno} for key in node.value.keys if isinstance(key, ast.Constant) and isinstance(key.value, str)}
    raise ValueError(f"Missing source mapping: {relative}:{name}")


def mapping_note(provider_id: str, route: list | None) -> str:
    if route:
        return ("Source-owned explicit route; " + ("the CogineWork and models.dev provider IDs differ, so same-ID lookup is incorrect. " if route[0] != provider_id else "the provider IDs match. ") + "Match request model IDs exactly within the expected API base URL and Provider variant; this does not authorize cross-route fact inheritance.")
    reasons = {
        "coginework-local": "Local model-service inventory has no public models.dev route in source.",
        "ollama": "Local inventory may contain local tags and quantizations; source declares no models.dev route.",
        "lmstudio": "Local inventory may contain local paths and quantizations; source declares no models.dev route.",
        "coginellm": "Cogine gateway and its cogine/free route have no explicit models.dev deployment mapping.",
        "ollama-cloud": "Source declares no models.dev mapping for the separate Ollama Cloud deployment; :cloud identity is retained.",
        "github-models": "This Provider is retired in CogineWork and source declares no models.dev route.",
        "tokendance": "Source declares no models.dev deployment mapping for this gateway and its protocol variants.",
        "openai-codex": "The ChatGPT subscription OAuth backend differs from the public OpenAI API; source declares no models.dev route.",
        "azure-openai": "Azure uses account deployment identities and an account URL; it cannot inherit the public OpenAI API route by model name.",
        "kimi-codingplan": "The dedicated Kimi coding-plan route has no explicit mapping; source Moonshot open-platform routes are different deployments.",
        "minimax-cn": "The China MiniMax route has no explicit mapping; source maps only the distinct international MiniMax deployment.",
    }
    return reasons.get(provider_id, "No explicit source-owned models.dev route; do not infer one from a same-name Provider, family or SDK.")


def refresh_urls(provider: dict) -> list[dict]:
    base, adapter, provider_id = provider["base_url"].rstrip("/"), provider["adapter"], provider["id"]
    auth = provider["discovery_requires_auth"]
    protocol = provider["default_protocol"]
    if provider_id == "opencode":
        return [
            {"url": "https://opencode.ai/inference/v1/models", "purpose": "membership", "protocol": "source_defined", "requires_auth": False},
            {"url": "https://models.opencode.ai/api.json", "purpose": "protocol_and_metadata", "protocol": "source_defined", "requires_auth": False},
        ]
    if provider_id == "opencode-go":
        return [
            {"url": "https://opencode.ai/zen/go/v1/models", "purpose": "membership", "protocol": "source_defined", "requires_auth": False},
            {"url": "https://models.opencode.ai/api.json", "purpose": "protocol_and_metadata", "protocol": "source_defined", "requires_auth": False},
        ]
    if provider["is_local"] or provider["discovery_strategy"] in {"catalog_only", "unsupported"}:
        return []
    if provider_id == "gemini":
        url = base + "/v1beta/models"
    elif adapter == "AnthropicProvider":
        url = base + "/v1/models"
    elif not base:
        return []
    elif provider_id == "deepseek":
        # OpenAI SDK appends /models to the supplied API base, which has no /v1.
        url = base + "/models"
    else:
        url = base + "/models"
    return [{"url": url, "purpose": "membership", "protocol": protocol, "requires_auth": auth}]


def extract(root: Path) -> dict:
    base = "src/coginework/providers/"
    head = run_git(root, "rev-parse", "HEAD")
    document = json.loads((root / (base + "data/model_catalog.json")).read_text())
    catalog = json.loads(json.dumps(document["providers"]))
    gateway = json.loads((root / (base + "data/gateway_model_metadata.json")).read_text())
    overlays = {}
    # Exact packaged-only overlay in model_catalog._load_packaged_catalog.
    for provider_id, key in [("opencode", "OPENCODE_MODELS"), ("kilo", "KILO_MODELS")]:
        rows = gateway.get("providers", {}).get(provider_id)
        if rows is None:
            continue
        anonymous = [dict(row) for row in rows.values() if row.get("price_status") == "free" and row.get("access_mode") == "anonymous" and row.get("model_protocol") == "chat_completions" and row.get("supports_text_output") is not False]
        ids = {row["id"] for row in anonymous}
        catalog[key] = anonymous + [row for row in catalog.get(key, []) if not row.get("is_free", False) and row["id"] not in ids]
        overlays[key] = {"provider_id": provider_id, "anonymous_free_count": len(anonymous), "base_count": len(document["providers"].get(key, [])), "effective_count": len(catalog[key]), "source": declaration(root, base + "model_catalog.py", "_load_packaged_catalog"), "metadata_file": base + "data/gateway_model_metadata.json", "metadata_published_at": gateway.get("published_at"), "rule": "Replace old free fallbacks with release-owned anonymous free chat_completions text-output records; retain old paid records with distinct exact IDs."}
    for entries in catalog.values():
        for row in entries:
            row["id"], row["name"] = row["id"].strip(), row["name"].strip()
            row["max_tokens"] = None
            row["source"] = "builtin"
    static = StaticValues(catalog)
    relatives = [
        base + "coginellm_provisioning.py", base + "tokendance_provider.py",
        base + "provider_discovery_policy.py", base + "provider_catalog.py",
        base + "modelsdev_catalog.py", base + "provider_manager.py",
        base + "acciowork_provider.py",
    ]
    for relative in relatives:
        static.load(root, relative)
    values = static.values
    registry = values["BUILTIN_PROVIDERS"]
    policies = values["BUILTIN_DISCOVERY_POLICIES"]
    routes = values["PROVIDER_ROUTES"]
    keys = values["BUILTIN_PROVIDER_CATALOG_KEYS"]
    policy_locations = mapping_locations(root, base + "provider_discovery_policy.py", "BUILTIN_DISCOVERY_POLICIES")
    route_locations = mapping_locations(root, base + "modelsdev_catalog.py", "PROVIDER_ROUTES")
    # Locate each construction by its declared variable; tuple evaluation only
    # references those dictionaries and preserves built-in presentation order.
    registry_symbols = next(node for node in ast.parse((root / (base + "provider_catalog.py")).read_text()).body if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == "BUILTIN_PROVIDERS")
    symbols = [node.id for node in registry_symbols.value.elts]
    providers = []
    for order, (raw, symbol) in enumerate(zip(registry, symbols)):
        provider_id, adapter = raw["id"], raw["_constructor"]
        policy = policies[provider_id]
        models = raw.get("models", [])
        models = [{key: value for key, value in model.items() if key != "_constructor"} for model in models]
        route = routes.get(provider_id)
        catalog_key = keys.get(provider_id)
        meta = raw.get("meta", {})
        declared_base_url = raw.get("base_url", "")
        base_url = declared_base_url or ("http://127.0.0.1:11434" if adapter == "OllamaProvider" else "")
        chat_model = raw.get("chat_model", "OpenAIChatModel")
        default_protocol = "messages" if raw.get("chat_model") == "AnthropicChatModel" or adapter == "AnthropicProvider" else "generate-content" if adapter == "GeminiProvider" else "responses" if adapter in {"OpenAIResponseProvider", "CodexProvider"} else "chat-completions"
        entry = {
            "id": provider_id, "name": raw["name"], "adapter": adapter, "order": order,
            "base_url": base_url, "base_url_declared": declared_base_url,
            "runtime_base_url_environment_override": "OLLAMA_HOST" if adapter == "OllamaProvider" else None,
            "base_url_default_source": declaration(root, base + "ollama_provider.py", "model_post_init") if adapter == "OllamaProvider" else static.locations[symbol],
            "is_local": raw.get("is_local", False),
            "require_api_key": raw.get("require_api_key", True), "supports_oauth": bool(raw.get("supports_oauth", False) or meta.get("supports_oauth", False)),
            "show_in_selector": raw.get("show_in_selector", True), "catalog_status": raw.get("catalog_status", "active"),
            "provider_group": raw.get("provider_group", ""), "provider_variant": raw.get("provider_variant", ""),
            "meta": meta, "chat_model": chat_model, "default_protocol": default_protocol,
            "meta_default_protocol": meta.get("default_protocol"),
            "default_protocol_basis": "Derived from the source-declared chat_model/adapter, with Provider.chat_model default OpenAIChatModel. No built-in source meta.default_protocol is declared. Heterogeneous gateways still require exact per-model protocol metadata.",
            "discovery_strategy": policy["strategy"],
            "model_sync_mode": policy["sync_mode"], "discovery_requires_auth": policy["requires_auth"],
            "discovery_reason": policy["reason"], "discovered_models_selectable": raw.get("discovered_models_selectable", False),
            "modelsdev_provider": route[0] if route else None,
            "modelsdev_expected_base_url": route[1] if route else None,
            "modelsdev_route_matches_default": bool(route and base_url.rstrip("/") == route[1].rstrip("/")),
            "modelsdev_mapping_note": mapping_note(provider_id, route),
            "fallback_catalog_key": catalog_key, "fallback_models": models, "fallback_count": len(models),
            "fallback_base_count": len(document["providers"][catalog_key]) if catalog_key else len(models),
            "fallback_effective_count": len(models), "fallback_overlay": overlays.get(catalog_key),
            "fallback_catalog_version": document["catalog_version"], "fallback_published_at": document.get("published_at"),
            "source": static.locations[symbol], "policy_source": policy_locations[provider_id],
            "modelsdev_route_source": route_locations.get(provider_id),
            "public_base_url_options": meta.get("base_url_options", []),
            "restricted_in_default_manager": provider_id in values.get("_RESTRICTED_BUILTIN_PROVIDER_IDS", []) or raw.get("provider_group", "") in values.get("_RESTRICTED_BUILTIN_PROVIDER_GROUPS", []),
        }
        entry["refresh_urls"] = refresh_urls(entry)
        entry["refresh_class"] = "local_private_inventory" if entry["is_local"] else "subscription_oauth" if provider_id == "openai-codex" else "catalog_only" if policy["strategy"] in {"catalog_only", "unsupported"} else "anonymous_public" if not policy["requires_auth"] else "authenticated_api"
        providers.append(entry)
    source_files = relatives + [base + name for name in ["provider.py", "provider_discovery.py", "model_catalog.py", "gateway_metadata.py", "catalog_source_http.py", "catalog_source_parsing.py", "openai_provider.py", "openai_response_provider.py", "anthropic_provider.py", "gemini_provider.py", "opencode_provider.py", "openrouter_provider.py", "coginellm_provider.py", "dashscope_provider.py", "agnes_provider.py", "lmstudio_provider.py", "ollama_provider.py", "free_model_catalog.py", "data/model_catalog.json", "data/gateway_model_metadata.json"]]
    return {
        "schema_version": 1,
        "scope": "Static built-in CogineWork source registry; no private settings, credentials, account eligibility or custom connections read",
        "coginework": {"root": str(root), "head": head, "branch": run_git(root, "branch", "--show-current"), "origin": run_git(root, "remote", "get-url", "origin"), "source_files_match_head": True, "source_files": [source_hash(root, file, head) for file in source_files]},
        "summary": {"provider_count": len(providers), "modelsdev_explicit_routes": sum(provider["modelsdev_provider"] is not None for provider in providers), "fallback_base_model_records": sum(provider["fallback_base_count"] for provider in providers), "fallback_model_records": sum(provider["fallback_count"] for provider in providers), "fallback_effective_model_records": sum(provider["fallback_effective_count"] for provider in providers), "refresh_classes": dict(Counter(provider["refresh_class"] for provider in providers)), "discovery_strategies": dict(Counter(provider["discovery_strategy"] for provider in providers))},
        "providers": providers,
        "excluded_provider_definitions": [{"id": "acciowork-local-agent", "enabled": values.get("ACCIOWORK_PROVIDER_ENABLED"), "reason": "Not registered unless source enable flag is true and platform is darwin", "source": static.locations["ACCIOWORK_PROVIDER_ENABLED"]}],
        "limitations": ["No user-configured connections, credentials or account-visible model catalogs were read.", "Packaged fallback rows include the release-owned Zen/Kilo metadata overlay and are baseline inputs, never proof of a successful latest refresh.", "Azure uses account deployment identities and has no generic public listing endpoint.", "Local inventories and subscription OAuth catalogs cannot be acquired by an anonymous public collector.", "Refresh endpoint descriptions are derived from source adapters; no inference or connection-check calls are made by this extractor.", "Source-default Ollama URL is recorded without reading OLLAMA_HOST; runtime environment overrides are unknown.", "CogineWork's explicit models.dev routes were designed for context facts; using them for N still requires Modelspage's field/identity contract and exact model matches, not inheritance from canonical names."],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--coginework-root", type=Path, default=Path("/Users/kiedis/Coding/AI/CogineWork"))
    parser.add_argument("--out", type=Path, default=Path(".modelspage/full-validation/inputs/coginework-providers.json"))
    args = parser.parse_args()
    payload = extract(args.coginework_root.resolve())
    args.out.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.out.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(args.out)
    print(json.dumps({"output": str(args.out), "head": payload["coginework"]["head"], **payload["summary"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()

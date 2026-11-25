"""Private, line-delimited pipe between Node and the pinned Gemini client."""

import asyncio
import importlib
import importlib.metadata
import json
import os
import re
import sys
import tempfile
import unicodedata
from collections import Counter


def reply(**fields):
    print(json.dumps(fields), flush=True)


try:
    if importlib.metadata.version("gemini-webapi") != "2.1.1":
        raise ImportError()
    from curl_cffi.requests import AsyncSession, Cookies
    from gemini_webapi import GeminiClient
    from gemini_webapi.constants import AccountStatus, CARD_CONTENT_RE, Endpoint, MODEL_HEADER_KEY
    from gemini_webapi.exceptions import AuthError, GeminiError, ModelInvalidError, TemporarilyBlockedError, UsageLimitExceededError
    from gemini_webapi.exceptions import TimeoutError as GeminiTimeout
    from gemini_webapi.types import AvailableModel
    from gemini_webapi.utils.logger import logger
    from gemini_webapi.utils.parsing import get_clean_text, get_nested_value
except (ImportError, importlib.metadata.PackageNotFoundError):
    reply(error="dependencies")
    sys.exit(0)

logger.remove()
os.umask(0o077)


class TextClient(GeminiClient):
    async def _init_rpc(self):
        # Temporary text requests have no use for the account's saved conversations.
        await self._fetch_user_status()
        await self._fetch_preferences()
        await self._sync_activity()

    async def _fetch_usage_info(self):
        # shortcut: this text adapter skips usage metrics because a denied metrics RPC disables cookie refresh, remove once upstream distinguishes that denial from sign-out.
        pass

    def _parse_candidate(self, candidate_data, cid, rid, rcid):
        if CARD_CONTENT_RE.match(get_nested_value(candidate_data, [1, 0], "") or ""):
            notice = get_nested_value(candidate_data, [22, 0], "") or ""
            if notice.lower().startswith(("i seem to be encountering an error.", "i encountered an error.")):
                raise UpstreamErrorCard()
        return super()._parse_candidate(candidate_data, cid, rid, rcid)


class RejectedRequest(GeminiError):
    def __init__(self, response):
        self.status_code = response.status_code
        self.retry_after = response.headers.get("retry-after")


class EmptyCatalog(GeminiError):
    pass


class UpstreamErrorCard(GeminiError):
    pass


class ContextLost(GeminiError):
    pass


request_http = AsyncSession.request


async def request_without_auth_retries(session, method, url, *args, **kwargs):
    response = await request_http(session, method, url, *args, **kwargs)
    rejected = url in (Endpoint.INIT, Endpoint.BATCH_EXEC, Endpoint.GENERATE) and response.status_code in (401, 403, 429)
    missing_chat = url == Endpoint.GENERATE and response.status_code in (404, 410)
    if rejected or missing_chat:
        error = RejectedRequest(response)
        if kwargs.get("stream"):
            await response.aclose()
        raise error
    return response


class TemporaryModel(AvailableModel):
    @property
    def model_header(self):
        headers = super().model_header
        selection = json.loads(headers[MODEL_HEADER_KEY])
        selection[7] = 1  # Chrome includes this when it selects a model in Temporary Chat.
        headers[MODEL_HEADER_KEY] = json.dumps(selection)
        return headers


MODEL_NAMES = {
    "auto": ("adapts-to-your-needs", "Adapts to your needs"),
    "4-hydrogen": ("4-hydrogen", "4 Hydrogen"),
    "4-hydrogen-thinking": ("hydrogen-thinking", "4 Hydrogen Thinking"),
    "neon": ("4-neon", "4 Neon"),
    "4-neon": ("4-neon", "4 Neon"),
    "carbon": ("4-carbon", "4 Carbon"),
    "4-carbon": ("4-carbon", "4 Carbon"),
}


def catalog(client):
    rows = []
    for model in client.list_models() or []:
        if not model.is_available:
            continue
        slug = model.model_name.removeprefix("gemini-")
        label = model.display_name or slug
        normalized = "".join(
            char for char in unicodedata.normalize("NFKD", label.lower())
            if not unicodedata.category(char).startswith("M")
        )
        default = re.sub(r"[^a-z0-9.]+", "-", normalized).strip(".-") or model.model_id
        identifier, label = MODEL_NAMES.get(slug, (default, label))
        rows.append((identifier, label, model))
    counts = Counter(identifier for identifier, _, _ in rows)
    models = {}
    menu = []
    for identifier, label, model in rows:
        if counts[identifier] > 1:
            identifier += "--" + model.model_id
        models[identifier] = TemporaryModel.model_validate(model.model_dump())
        menu.append({"id": identifier, "name": label})
    return models, menu


async def refresh_catalog(client):
    previous = client._model_registry
    client._model_registry = {}
    try:
        await client._fetch_user_status()
        if client.account_status == AccountStatus.UNAUTHENTICATED:
            raise AuthError()
        result = catalog(client)
        if not result[1]:
            raise EmptyCatalog()
        return result
    except Exception:
        client._model_registry = previous
        raise


def fail(error, client):
    response = getattr(error, "response", None)
    status = getattr(response, "status_code", None) or getattr(error, "status_code", None)
    if status is None:
        match = re.fullmatch(r"(?:Failed to generate contents\. Status:|Batch execution failed with status code) (\d{3})", str(error))
        status = int(match[1]) if match else None
    if isinstance(error, (TemporarilyBlockedError, UsageLimitExceededError)) or status == 429:
        headers = getattr(response, "headers", {})
        code = "gemini_model_rate_limited" if isinstance(error, UsageLimitExceededError) else "gemini_rate_limited"
        reply(error=code, status=429, retryAfter=getattr(error, "retry_after", None) or headers.get("retry-after"))
    elif isinstance(error, AuthError) or status == 401 or client.account_status == AccountStatus.UNAUTHENTICATED:
        reply(error="login")
    elif isinstance(error, ModelInvalidError):
        reply(error="gemini_model_unavailable", status=422, message="Gemini rejected the requested model. Refresh the model list and retry.")
    elif isinstance(error, EmptyCatalog):
        reply(error="gemini_model_catalog_unavailable", status=503, message="Gemini did not offer any available models.")
    elif isinstance(error, ContextLost):
        reply(error="gemini_context_lost", status=409, message="The prior Gemini Temporary Chat is no longer available.")
    elif isinstance(error, UpstreamErrorCard):
        reply(error="gemini_upstream_error", status=502, message="Gemini returned a temporary error. Retry the request.")
    elif isinstance(error, (GeminiTimeout, TimeoutError)):
        reply(error="gemini_generation_timeout", status=504, message="Gemini direct HTTP timed out.")
    elif status == 403:
        reply(error="gemini_access_denied", status=403, message="Gemini refused the direct HTTP request.")
    else:
        reply(error="gemini_direct_failed", status=502)


async def stream_text(chat, prompt):
    text = sent = ""
    # The SDK must not replay after a delta has gone to the caller.
    async for output in chat.send_message_stream(prompt, temporary=True, current_retry=0):
        text = output.text or ""
        stable = get_clean_text(text)
        if stable.startswith(sent) and len(stable) > len(sent):
            reply(delta=stable[len(sent):])
            sent = stable
    return text


async def main():
    cookies = json.loads(sys.stdin.readline())["cookies"]
    client = TextClient()
    jar = Cookies()
    for cookie in cookies:
        jar.set(cookie["name"], cookie["value"], domain=cookie["domain"], path=cookie["path"], secure=cookie["secure"])
    client.cookies = jar
    try:
        try:
            await asyncio.wait_for(client.init(timeout=240, auto_refresh=True), 35)
            if client.account_status == AccountStatus.UNAUTHENTICATED:
                reply(error="login")
                return
            models, menu = catalog(client)
        except Exception as error:
            fail(error, client)
            return
        reply(models=menu)
        chat_id = None
        chat = None
        retained = {}
        while line := await asyncio.to_thread(sys.stdin.readline):
            request = json.loads(line)
            try:
                if request.get("catalog"):
                    models, menu = await refresh_catalog(client)
                    reply(models=menu)
                    continue
                key = request["chat"]
                resume = request.get("resume", key == chat_id)
                retained_chat = retained.pop(key, None)
                model = models[request["model"]]
                if resume:
                    chat = chat if chat_id == key else retained_chat
                    if chat is None or (request.get("retain") and not chat.cid):
                        raise ContextLost()
                    if chat.model.model_header != model.model_header:
                        raise ContextLost()
                else:
                    chat = client.start_chat(model=model)
                chat_id = key
                prior_cid = chat.cid if resume else None
                if request.get("stream"):
                    text = await stream_text(chat, request["prompt"])
                else:
                    options = {"current_retry": 0} if request.get("retain") else {}
                    text = (await chat.send_message(request["prompt"], temporary=True, **options)).text
                if prior_cid and chat.cid != prior_cid:
                    raise ContextLost()
                if text and text.strip():
                    reusable = bool(request.get("retain") and chat.cid)
                    if reusable:
                        retained[key] = chat
                        if len(retained) > 32:
                            retained.pop(next(iter(retained)))
                    reply(text=text, reusable=reusable)
                else:
                    reply(error="gemini_no_reply", status=502, message="Gemini returned an empty reply.")
            except Exception as error:
                if not request.get("catalog"):
                    chat_id = None
                    chat = None
                    if (request.get("resume") and isinstance(error, RejectedRequest)
                            and error.status_code in (404, 410)):
                        error = ContextLost()
                fail(error, client)
    finally:
        await client.close()


def run():
    # Also clean up if the adapter disappears and stdin closes first.
    with tempfile.TemporaryDirectory(prefix="cookies-", dir=os.environ.get("GEMINI_COOKIE_PATH")) as cache:
        os.environ["GEMINI_COOKIE_PATH"] = cache
        asyncio.run(main())


if __name__ == "__main__":
    # The worker uses the dedicated Chrome profile even if the optional browser discovery package is installed.
    importlib.import_module("gemini_webapi.utils.get_access_token").load_browser_cookies = lambda **_: {}
    # Preserve terminal HTTP statuses before the library turns them into retryable API errors.
    AsyncSession.request = request_without_auth_retries
    run()

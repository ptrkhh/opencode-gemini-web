import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import direct_worker as worker


class DirectWorkerTest(unittest.IsolatedAsyncioTestCase):
    def test_worker_removes_its_cache_without_parent_cleanup(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"GEMINI_COOKIE_PATH": directory}):
            async def fake_worker():
                cache = Path(os.environ["GEMINI_COOKIE_PATH"])
                self.assertEqual(cache.parent, Path(directory))
                (cache / "synthetic-cookie-cache").write_text("synthetic")

            with patch.object(worker, "main", fake_worker):
                worker.run()
            self.assertEqual(list(Path(directory).iterdir()), [])

    async def test_retains_distinct_temporary_chats_and_rejects_an_expired_one(self):
        test_case = self

        class Chat:
            def __init__(self, model):
                self.model = model
                self.cid = ""

            async def send_message(self, prompt, *, temporary, current_retry):
                test_case.assertTrue(temporary)
                test_case.assertEqual(current_retry, 0)
                if prompt == "expired":
                    self.cid = "replacement"
                elif not self.cid:
                    self.cid = prompt
                return SimpleNamespace(text=self.cid)

        client = SimpleNamespace(init=AsyncMock(), close=AsyncMock(),
                                 start_chat=Chat, account_status=worker.AccountStatus.AVAILABLE)
        model = worker.AvailableModel(model_id="model", model_name="gemini-neon",
                                      display_name="Deeper analysis", description="", capacity=1)
        client.list_models = lambda: [model]
        commands = [
            {"chat": key, "model": "4-neon", "prompt": prompt, "resume": resume, "retain": True}
            for key, prompt, resume in [
                ("a", "first", False), ("b", "second", False), ("a", "follow", True),
                ("a", "expired", True), ("a", "missing", True), ("b", "other-follow", True),
            ]
        ]
        stream = io.StringIO("\n".join(map(json.dumps, [{"cookies": []}, *commands])))
        with patch.object(worker.sys, "stdin", stream), patch.object(worker, "TextClient", return_value=client), patch.object(worker, "reply") as send:
            await worker.main()
        results = [call.kwargs for call in send.call_args_list[1:]]
        self.assertEqual([record.get("text") for record in results], ["first", "second", "first", None, None, "second"])
        self.assertEqual([record.get("error") for record in results[3:5]], ["gemini_context_lost"] * 2)
        self.assertTrue(results[-1]["reusable"])

    async def test_streams_only_new_text_and_disables_upstream_replay(self):
        async def chunks(prompt, *, temporary, current_retry):
            self.assertEqual(prompt, "prompt")
            self.assertTrue(temporary)
            self.assertEqual(current_retry, 0)
            for text in ("", "First\n```", "Revised", "First second\n```"):
                yield SimpleNamespace(text=text)
        with patch.object(worker, "reply") as emit:
            self.assertEqual(await worker.stream_text(SimpleNamespace(send_message_stream=chunks), "prompt"), "First second\n```")
        self.assertEqual([call.kwargs["delta"] for call in emit.call_args_list], ["First", " second"])

    def test_gemini_error_cards_are_not_successful_replies(self):
        candidate = [None] * 23
        candidate[1] = ["https://googleusercontent.com/card_content/123"]
        candidate[22] = ["I seem to be encountering an error. Can I try something else for you?"]
        with self.assertRaises(worker.UpstreamErrorCard):
            worker.TextClient()._parse_candidate(candidate, "", "", "")

    async def test_stops_at_rate_limit_and_preserves_retry_after(self):
        response = SimpleNamespace(status_code=429, headers={"retry-after": "75"}, aclose=AsyncMock())
        request = AsyncMock(return_value=response)
        with patch.object(worker, "request_http", request):
            with self.assertRaises(worker.RejectedRequest) as denied:
                await worker.request_without_auth_retries(None, "POST", worker.Endpoint.GENERATE, stream=True)
        self.assertEqual(denied.exception.status_code, 429)
        self.assertEqual(denied.exception.retry_after, "75")
        request.assert_awaited_once()
        response.aclose.assert_awaited_once()

    def test_only_model_usage_errors_get_model_scoped_cooldowns(self):
        client = SimpleNamespace(account_status=worker.AccountStatus.AVAILABLE)
        with patch.object(worker, "reply") as send:
            worker.fail(worker.UsageLimitExceededError(), client)
            worker.fail(worker.RejectedRequest(SimpleNamespace(status_code=429, headers={})), client)
        self.assertEqual([call.kwargs["error"] for call in send.call_args_list],
                         ["gemini_model_rate_limited", "gemini_rate_limited"])

    async def test_keeps_the_previous_registry_after_an_empty_refresh(self):
        previous = {"model": object()}
        client = SimpleNamespace(
            _model_registry=previous,
            account_status=worker.AccountStatus.AVAILABLE,
            _fetch_user_status=AsyncMock(),
            list_models=lambda: [],
        )
        with self.assertRaises(worker.EmptyCatalog):
            await worker.refresh_catalog(client)
        self.assertIs(client._model_registry, previous)

    def test_catalog_keeps_browser_model_ids_and_temporary_selection(self):
        models, menu = worker.catalog(SimpleNamespace(list_models=lambda: [
            worker.AvailableModel(model_id="one", model_name="gemini-fast",
                                  display_name="2.5 Flash", description="", capacity=1),
            worker.AvailableModel(model_id="two", model_name="gemini-neon",
                                  display_name="Deeper analysis", description="", capacity=1),
        ]))
        self.assertEqual([entry["id"] for entry in menu], ["2.5-flash", "4-neon"])
        self.assertEqual(json.loads(models["4-neon"].model_header[worker.MODEL_HEADER_KEY])[7], 1)


if __name__ == "__main__":
    unittest.main()

"""A single batch uses the configured model concurrency without requiring multiple jobs."""
import json
import threading
import time
from fastapi.testclient import TestClient
from app.config import Settings
from app.main import create_app
from app.providers import FakeLLM


class RendezvousProvider(FakeLLM):
    def __init__(self):
        super().__init__()
        self.barrier = threading.Barrier(2, timeout=2)

    def generate(self, *args, **kwargs):
        self.barrier.wait()
        return super().generate(*args, **kwargs)


def test_single_group_batch_uses_two_model_workers(tmp_path):
    provider = RendezvousProvider()
    settings = Settings(database_path=tmp_path / "parallel.db", llm_max_concurrency=2)
    records = [dict(conversation_id=f"parallel-{i}", channel="agent chat", language="RU", transcript=[
        dict(timestamp="00:01", speaker="operator", text="Синтетическая реплика.")]) for i in range(2)]
    with TestClient(create_app(settings, provider=provider)) as client:
        response = client.post('/api/imports/file', data={'group_id': 'PARALLEL'},
                               files={'file': ('synthetic.json', json.dumps(records, ensure_ascii=False).encode('utf-8'), 'application/json')})
        assert response.status_code == 200
        job = client.post('/api/evaluations', json={'group_id': 'PARALLEL'}).json()['data']
        deadline = time.monotonic() + 5
        while job['status'] in {'queued', 'running'} and time.monotonic() < deadline:
            time.sleep(.01)
            job = client.get('/api/jobs/' + job['id']).json()['data']
        assert job['status'] == 'completed'
        assert job['succeeded'] == 2
        assert provider.calls == 2

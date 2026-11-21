import pytest

from app import diagnostics


@pytest.fixture(autouse=True)
def isolated_generation_diagnostics(monkeypatch, tmp_path):
    monkeypatch.setattr(diagnostics, "LOG_PATH", tmp_path / "generation-diagnostics.jsonl")

"""Server configuration from the process environment; secrets never appear in repr."""
from dataclasses import dataclass, field
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Settings:
    database_path: Path = ROOT / "data" / "cqa.db"
    llm_provider: str = "fake"
    llm_model: str | None = None
    llm_api_key: str | None = field(default=None, repr=False)
    llm_base_url: str | None = field(default=None, repr=False)
    dataset_url: str | None = field(default=None, repr=False)
    cors_origins: tuple[str, ...] = ()
    score_rounding: str = "half_up"
    score_decimals: int = 2
    gross_error_zeroes_total: bool = False
    rationale_language: str = "ru"
    llm_max_concurrency: int = 2
    llm_timeout: float = 60
    llm_max_attempts: int = 3
    dataset_timeout: float = 60
    max_upload_bytes: int = 20 * 1024 * 1024
    max_queued_jobs: int = 32

    def __post_init__(self):
        if self.llm_provider not in {"fake", "openai", "anthropic"}:
            raise ValueError("Invalid LLM_PROVIDER")
        if self.score_rounding not in {"half_up", "half_even"} or not 0 <= self.score_decimals <= 8:
            raise ValueError("Invalid scoring policy")
        if min(self.llm_max_concurrency, self.llm_max_attempts, self.llm_timeout,
               self.dataset_timeout, self.max_upload_bytes, self.max_queued_jobs) <= 0:
            raise ValueError("Limits must be positive")

    @property
    def scoring_policy(self):
        return {"rounding": self.score_rounding, "decimals": self.score_decimals,
                "gross_error_zeroes_total": self.gross_error_zeroes_total}

    @classmethod
    def from_env(cls):
        def flag(name, default):
            value = os.getenv(name, default).lower()
            if value not in {"true", "false"}:
                raise ValueError(f"Invalid {name}")
            return value == "true"
        return cls(
            database_path=Path(os.getenv("DATABASE_PATH", str(ROOT / "data" / "cqa.db"))),
            llm_provider=os.getenv("LLM_PROVIDER", "fake"), llm_model=os.getenv("LLM_MODEL") or None,
            llm_api_key=os.getenv("LLM_API_KEY") or None, llm_base_url=os.getenv("LLM_BASE_URL") or None,
            dataset_url=os.getenv("DATASET_URL") or None,
            cors_origins=tuple(x.strip() for x in os.getenv("CORS_ORIGINS", "").split(",") if x.strip()),
            score_rounding=os.getenv("SCORE_ROUNDING", "half_up"),
            score_decimals=int(os.getenv("SCORE_DECIMALS", "2")),
            gross_error_zeroes_total=flag("GROSS_ERROR_ZEROES_TOTAL", "false"),
            rationale_language=os.getenv("RATIONALE_LANGUAGE", "ru"),
            llm_max_concurrency=int(os.getenv("LLM_MAX_CONCURRENCY", "2")),
            llm_timeout=float(os.getenv("LLM_TIMEOUT", "60")),
            llm_max_attempts=int(os.getenv("LLM_MAX_ATTEMPTS", "3")),
            dataset_timeout=float(os.getenv("DATASET_TIMEOUT", "60")),
            max_upload_bytes=int(os.getenv("MAX_UPLOAD_BYTES", str(20 * 1024 * 1024))),
            max_queued_jobs=int(os.getenv("MAX_QUEUED_JOBS", "32")),
        )

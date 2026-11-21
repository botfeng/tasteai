class RecommendationError(Exception):
    """Only fixed, locally authored messages may cross the API boundary."""

    def __init__(self, code: str, message: str, status: int = 503):
        super().__init__(code)
        self.code = code
        self.message = message
        self.status = status


class OutputValidationError(Exception):
    def __init__(self, code: str, field_path: tuple[str | int, ...] = ()):
        # Codes and structural locations only; never retain model text or Pydantic input.
        super().__init__(code)
        self.code = code
        self.field_path = field_path

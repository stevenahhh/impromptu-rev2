"""Machine-identifiable rejection raised for unsafe input at the ingestion boundary."""


class InputValidationError(ValueError):
    """A safe, machine-identifiable rejection at the input boundary."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(f"{code}: {message}")

"""Public errors contain fixed, safe explanations, never upstream exception text."""


class APIError(Exception):
    def __init__(self, status, code, message, details=None, retryable=False):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message
        self.details, self.retryable = details or [], retryable


def require(value):
    if value is None:
        raise APIError(404, "NOT_FOUND", "Объект не найден.")
    return value

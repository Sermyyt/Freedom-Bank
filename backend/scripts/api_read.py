"""Read paginated API collections without logging response content."""
from scripts.run_batch import BatchError, request_data


def items(client, path, **params):
    offset = 0
    while True:
        page = request_data(client, 'GET', path, params={**params, 'limit': 100, 'offset': offset})
        if not isinstance(page, dict):
            raise BatchError('Invalid API collection.')
        rows, total = page.get('items'), page.get('total')
        if not isinstance(rows, list) or type(total) is not int or total < 0:
            raise BatchError('Invalid API pagination.')
        if any(not isinstance(row, dict) for row in rows):
            raise BatchError('Invalid API collection item.')
        yield from rows
        offset += len(rows)
        if offset >= total:
            return
        if not rows:
            raise BatchError('API pagination did not advance.')

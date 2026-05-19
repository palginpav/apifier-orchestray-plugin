# Widget API

A simple API for widget management.

## API Keys

Pass your API key via the `X-API-Key` header with every request.

### GET /widgets

List all widgets for the authenticated account.

```bash
curl -X GET https://api.example.com/widgets \
  -H "X-API-Key: your_api_key"
```

### Response

```json
[
  { "id": "w1", "name": "Sprocket" },
  { "id": "w2", "name": "Gadget" }
]
```

### POST /widgets/{widgetId}/activate

Activate a specific widget.

```bash
curl -X POST https://api.example.com/widgets/w1/activate \
  -H "X-API-Key: your_api_key"
```

### Returns

```json
{ "id": "w1", "active": true }
```

<!--
  Original Markdown content in the style of a typical GitHub-hosted repo
  API doc. Used as a real-world-shaped fixture for the apifier Markdown
  parser integration test. No content lifted from any specific service's docs.
-->

# Widgets API

The Widgets API provides programmatic access to create, retrieve, and manage
widgets in your account. All requests must be made over HTTPS.

Base URL: `https://api.widgets.example.com`

## Authentication

All API requests require authentication. The Widgets API supports two methods:

**API Key** — Pass your key in the `X-API-Key` header:

```
X-API-Key: your_api_key_here
```

**Bearer token** — Pass your token in the `Authorization` header:

```
Authorization: Bearer your_bearer_token_here
```

API keys and tokens are available from your account dashboard at
<https://widgets.example.com/settings/keys>.

---

## POST /widgets

Create a new widget.

| Parameter  | Type    | In   | Required | Description                              |
|------------|---------|------|----------|------------------------------------------|
| name       | string  | body | Yes      | Display name for the widget.             |
| color      | string  | body | No       | Hex color code, e.g. `#ff5733`.          |
| quantity   | integer | body | No       | Initial stock quantity. Defaults to `0`. |

### Request body

```json
{
  "name": "Sprocket XL",
  "color": "#3498db",
  "quantity": 100
}
```

### Response 200

```json
{
  "id": "wgt_01HZ3K9MXQR7P",
  "name": "Sprocket XL",
  "color": "#3498db",
  "quantity": 100,
  "created_at": "2026-05-19T12:00:00Z"
}
```

### Response 422

```json
{
  "error": "validation_error",
  "message": "name is required",
  "field": "name"
}
```

### Example

```bash
curl -X POST https://api.widgets.example.com/widgets \
  -H "X-API-Key: your_api_key_here" \
  -H "Content-Type: application/json" \
  -d '{"name":"Sprocket XL","color":"#3498db","quantity":100}'
```

---

## GET /widgets/{id}

Retrieve a single widget by its unique identifier.

| Parameter | Type   | In   | Required | Description         |
|-----------|--------|------|----------|---------------------|
| id        | string | path | Yes      | The widget ID.      |

### Response 200

```json
{
  "id": "wgt_01HZ3K9MXQR7P",
  "name": "Sprocket XL",
  "color": "#3498db",
  "quantity": 100,
  "created_at": "2026-05-19T12:00:00Z"
}
```

### Response 404

```json
{
  "error": "not_found",
  "message": "Widget wgt_01HZ3K9MXQR7P does not exist."
}
```

### Example

```bash
curl https://api.widgets.example.com/widgets/wgt_01HZ3K9MXQR7P \
  -H "X-API-Key: your_api_key_here"
```

---

## DELETE /widgets/{id}

Permanently delete a widget. This action is irreversible.

| Parameter | Type   | In   | Required | Description                  |
|-----------|--------|------|----------|------------------------------|
| id        | string | path | Yes      | The ID of the widget to delete. |

### Response 200

```json
{
  "id": "wgt_01HZ3K9MXQR7P",
  "deleted": true
}
```

### Response 404

```json
{
  "error": "not_found",
  "message": "Widget wgt_01HZ3K9MXQR7P does not exist."
}
```

### Example

```bash
curl -X DELETE https://api.widgets.example.com/widgets/wgt_01HZ3K9MXQR7P \
  -H "X-API-Key: your_api_key_here"
```

---

## Error codes

| Code | Meaning                                |
|------|----------------------------------------|
| 400  | Bad request — invalid parameters.      |
| 401  | Unauthorized — missing or invalid key. |
| 404  | Not found — resource does not exist.   |
| 422  | Unprocessable entity — validation failed. |
| 429  | Too many requests — rate limit hit.    |
| 500  | Internal server error.                 |

Rate limit: 1000 requests per minute per API key.

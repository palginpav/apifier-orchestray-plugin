# Example API

A REST API for managing example resources. Supports CRUD operations on users and items.

## Authentication

All endpoints require a Bearer token in the `Authorization` header.

```
Authorization: Bearer <your_token>
```

Use the `/auth/token` endpoint to obtain a token. Tokens expire after 24 hours.

## GET /users/{id}

Retrieve a single user by their unique identifier.

### Parameters

| Name | In   | Type   | Required | Description           |
|------|------|--------|----------|-----------------------|
| id   | path | string | true     | The unique user ID.   |

### Query Parameters

| Name    | In    | Type    | Required | Description                  |
|---------|-------|---------|----------|------------------------------|
| include | query | string  | false    | Comma-separated fields list. |
| verbose | query | boolean | false    | Return extended details.     |

### Response

```json
{
  "id": "usr_123",
  "name": "Alice",
  "email": "alice@example.com"
}
```

### Example response 404

```json
{
  "error": "USER_NOT_FOUND",
  "message": "User not found."
}
```

## POST /users

Create a new user account.

### Body

```json
{
  "name": "Bob",
  "email": "bob@example.com",
  "role": "viewer"
}
```

### Response

```json
{
  "id": "usr_456",
  "name": "Bob",
  "email": "bob@example.com",
  "role": "viewer"
}
```

## DELETE /users/{id}

Delete a user by ID.

### Parameters

| Name | In   | Type   | Required | Description         |
|------|------|--------|----------|---------------------|
| id   | path | string | true     | The user ID to delete. |

### Response

```json
{
  "deleted": true
}
```

# API Documentation Standards

This document defines the standards and best practices for documenting APIs in the Dome project. Following these guidelines ensures consistent, comprehensive, and maintainable API documentation.

## 1. Introduction

### Purpose

The purpose of these standards is to establish a consistent approach to API documentation across the Dome project. Well-documented APIs improve developer experience, reduce integration time, and ensure proper usage of our services.

### Scope

These standards apply to all API documentation in the Dome project, including:

- RPC interfaces exposed by services
- HTTP endpoints
- Queue message formats
- Service binding interfaces

## 2. OpenAPI/Swagger Specification

### Why OpenAPI/Swagger

We use OpenAPI (formerly known as Swagger) as our standard for API documentation because it:

- Provides a structured, machine-readable format
- Supports code generation for clients and servers
- Has a rich ecosystem of tools for validation and visualization
- Is widely adopted in the industry

### Version

We use **OpenAPI 3.0** for all API documentation. This version provides the best balance of features and tool support.

### File Structure

OpenAPI specifications should be stored in the following locations:

- `docs/api/{service-name}/openapi.yaml` - Main OpenAPI specification file
- `docs/api/{service-name}/schemas/` - Reusable schema components
- `docs/api/{service-name}/examples/` - Example requests and responses

## 3. Documenting RPC Interfaces

While OpenAPI is primarily designed for REST APIs, we adapt it for our RPC-style interfaces using the following conventions:

### RPC Method Mapping

Map RPC methods to HTTP POST endpoints with the method name as the path:

```yaml
paths:
  /simplePut:
    post:
      summary: Store a small piece of content
      description: Synchronously stores a small content item (≤ 1 MiB) in R2 and metadata in D1.
      operationId: simplePut
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/SimplePutRequest'
      responses:
        '200':
          description: Content stored successfully
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/SimplePutResponse'
        '400':
          $ref: '#/components/responses/BadRequest'
        '500':
          $ref: '#/components/responses/InternalError'
```

### Service Binding Documentation

Document service bindings with a special tag and include examples of how to use the binding:

```yaml
tags:
  - name: Service Binding
    description: This API is exposed via Cloudflare service binding.

# In the method documentation:
x-binding-example: |
  // Example usage with service binding
  const result = await env.SERVICE_NAME.simplePut({
    content: "Hello, world!",
    contentType: "note"
  });
```

## 4. API Documentation Components

### Endpoints/Methods

Each endpoint or RPC method should include:

- **Summary**: A brief one-line description
- **Description**: A detailed explanation of what the method does
- **Operation ID**: A unique identifier for the operation (usually the method name)
- **Tags**: Categorization tags for grouping related operations
- **Parameters/Request Body**: Detailed description of all inputs
- **Responses**: All possible response types and status codes
- **Examples**: Example requests and responses
- **Security**: Authentication requirements

### Parameters and Request Bodies

Document all parameters and request body fields with:

- **Name**: The parameter or field name
- **Type**: The data type (string, number, boolean, object, array, etc.)
- **Required**: Whether the parameter is required or optional
- **Description**: A clear explanation of the parameter's purpose and constraints
- **Example**: A realistic example value
- **Default**: The default value, if any
- **Constraints**: Any validation rules or constraints (min/max values, patterns, etc.)

Example:

```yaml
components:
  schemas:
    SimplePutRequest:
      type: object
      required:
        - content
      properties:
        content:
          type: string
          description: The content to store. Must be ≤ 1 MiB.
          example: 'This is a note about an interesting topic.'
        contentType:
          type: string
          enum: [note, code, text/plain]
          default: note
          description: The type of content being stored.
        id:
          type: string
          description: Optional ID for the content. If not provided, a ULID will be generated.
          example: '01F8Z6ARNVT4SSRRF3J1XKHRPG'
        userId:
          type: string
          description: The ID of the user who owns this content. If not provided, the authenticated user's ID will be used.
          example: 'user_01F8Z6ARNVT4SSRRF3J1XKHRPG'
```

### Responses

Document all possible responses with:

- **Status Code**: The HTTP status code
- **Description**: A clear explanation of when this response is returned
- **Schema**: The structure of the response body
- **Example**: A realistic example response

Example:

```yaml
responses:
  '200':
    description: Content stored successfully
    content:
      application/json:
        schema:
          type: object
          properties:
            id:
              type: string
              description: The ID of the stored content.
              example: '01F8Z6ARNVT4SSRRF3J1XKHRPG'
        example:
          id: '01F8Z6ARNVT4SSRRF3J1XKHRPG'
```

### Error Responses

Document all possible error responses with:

- **Status Code**: The HTTP status code
- **Error Code**: A unique identifier for the error type
- **Message**: A human-readable error message
- **Details**: Additional information about the error

Example:

```yaml
components:
  responses:
    BadRequest:
      description: Invalid request parameters
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/Error'
          example:
            error:
              code: VALIDATION_ERROR
              message: Invalid request parameters
              details:
                field: content
                reason: Content size exceeds maximum allowed (1 MiB)
```

### Authentication

Document authentication requirements with:

- **Type**: The authentication type (Bearer token, API key, etc.)
- **Location**: Where the authentication credentials should be provided (header, query parameter, etc.)
- **Format**: The expected format of the credentials

Example:

```yaml
components:
  securitySchemes:
    BearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
      description: JWT token obtained from the authentication service

security:
  - BearerAuth: []
```

## 5. Example OpenAPI Specification

Here's a simplified example of an OpenAPI specification for the Silo service:

```yaml
openapi: 3.0.0
info:
  title: Silo API
  description: API for the Silo content storage service
  version: 1.0.0

tags:
  - name: Service Binding
    description: This API is exposed via Cloudflare service binding.
  - name: Content
    description: Operations for managing content

paths:
  /simplePut:
    post:
      tags:
        - Content
      summary: Store a small piece of content
      description: Synchronously stores a small content item (≤ 1 MiB) in R2 and metadata in D1.
      operationId: simplePut
      x-binding-example: |
        // Example usage with service binding
        const result = await env.SILO.simplePut({
          content: "Hello, world!",
          contentType: "note"
        });
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/SimplePutRequest'
      responses:
        '200':
          description: Content stored successfully
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/SimplePutResponse'
        '400':
          $ref: '#/components/responses/BadRequest'
        '500':
          $ref: '#/components/responses/InternalError'

components:
  schemas:
    SimplePutRequest:
      type: object
      required:
        - content
      properties:
        content:
          type: string
          description: The content to store. Must be ≤ 1 MiB.
          example: 'This is a note about an interesting topic.'
        contentType:
          type: string
          enum: [note, code, text/plain]
          default: note
          description: The type of content being stored.
        id:
          type: string
          description: Optional ID for the content. If not provided, a ULID will be generated.
          example: '01F8Z6ARNVT4SSRRF3J1XKHRPG'
        userId:
          type: string
          description: The ID of the user who owns this content. If not provided, the authenticated user's ID will be used.
          example: 'user_01F8Z6ARNVT4SSRRF3J1XKHRPG'

    SimplePutResponse:
      type: object
      properties:
        id:
          type: string
          description: The ID of the stored content.
          example: '01F8Z6ARNVT4SSRRF3J1XKHRPG'

    Error:
      type: object
      properties:
        error:
          type: object
          properties:
            code:
              type: string
              description: A unique identifier for the error type.
            message:
              type: string
              description: A human-readable error message.
            details:
              type: object
              description: Additional information about the error.

  responses:
    BadRequest:
      description: Invalid request parameters
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/Error'
          example:
            error:
              code: VALIDATION_ERROR
              message: Invalid request parameters
              details:
                field: content
                reason: Content size exceeds maximum allowed (1 MiB)

    InternalError:
      description: Internal server error
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/Error'
          example:
            error:
              code: INTERNAL_ERROR
              message: An unexpected error occurred
```

## 6. Generating and Maintaining Documentation

### Tools for Generating Documentation

- **Swagger UI**: For interactive API documentation
- **Redoc**: For static API documentation
- **OpenAPI Generator**: For generating client libraries
- **Swagger Editor**: For editing OpenAPI specifications

### Process for Keeping Documentation Up-to-Date

1. **Update with Code Changes**: Update API documentation whenever the API changes
2. **Review Documentation**: Include documentation review in code reviews
3. **Validate Specifications**: Use OpenAPI validation tools to ensure specifications are valid
4. **Test Examples**: Ensure example requests and responses are valid and up-to-date

### Integration with Code

Consider using code annotations or TypeScript interfaces to generate OpenAPI specifications from code. This helps keep documentation in sync with the implementation.

## 7. Best Practices

### Do's

- **Be comprehensive**: Document all endpoints, parameters, and responses
- **Use realistic examples**: Provide examples that reflect actual usage
- **Keep documentation up-to-date**: Update documentation whenever the API changes
- **Use consistent terminology**: Use the same terms throughout the documentation
- **Document error responses**: Clearly document all possible error responses

### Don'ts

- **Don't use ambiguous language**: Be clear and specific
- **Don't omit details**: Include all relevant information
- **Don't use inconsistent formats**: Follow the standards consistently
- **Don't expose sensitive information**: Redact sensitive data in examples
- **Don't duplicate information**: Use references to avoid duplication

## 8. Conclusion

Following these API documentation standards will ensure that the Dome project's APIs are well-documented, consistent, and easy to use. Well-documented APIs improve developer experience, reduce integration time, and ensure proper usage of our services.

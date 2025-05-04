import { z } from 'zod';

/**
 * Utility to convert JSON schema objects to Zod schemas
 * This provides compatibility between nodes using JSON schema
 * and the LangChain structured output parser that requires Zod
 */
export class ZodSchemaConverter {
  /**
   * Convert a JSON Schema object to a Zod schema
   * @param jsonSchema The JSON schema object to convert
   * @returns A Zod schema equivalent to the JSON schema
   */
  static fromJsonSchema(jsonSchema: any): z.ZodTypeAny {
    if (!jsonSchema) {
      throw new Error('JSON schema is required');
    }

    // Handle root schema
    return this.convertSchemaNode(jsonSchema);
  }

  /**
   * Convert a JSON schema node to a Zod schema node
   * Handles nested schema structures recursively
   */
  private static convertSchemaNode(node: any): z.ZodTypeAny {
    if (!node.type) {
      return z.any();
    }

    switch (node.type) {
      case 'object':
        return this.convertObjectSchema(node);
      case 'array':
        return this.convertArraySchema(node);
      case 'string':
        return z.string();
      case 'number':
        return z.number();
      case 'integer':
        return z.number().int();
      case 'boolean':
        return z.boolean();
      case 'null':
        return z.null();
      default:
        return z.any();
    }
  }

  /**
   * Convert a JSON schema object to a Zod object schema
   */
  private static convertObjectSchema(node: any): z.ZodObject<any> {
    const shape: Record<string, z.ZodTypeAny> = {};

    // Process all properties
    if (node.properties) {
      Object.entries(node.properties).forEach(([key, propSchema]) => {
        shape[key] = this.convertSchemaNode(propSchema as any);
      });
    }

    // Create the base object schema
    let schema = z.object(shape);

    // Handle required properties
    if (Array.isArray(node.required) && node.required.length > 0) {
      const requiredKeys = new Set(node.required);

      // Mark non-required properties as optional
      const partialShape: Record<string, z.ZodTypeAny> = {};

      Object.entries(shape).forEach(([key, value]) => {
        if (!requiredKeys.has(key)) {
          partialShape[key] = value.optional();
        } else {
          partialShape[key] = value;
        }
      });

      schema = z.object(partialShape);
    }

    return schema;
  }

  /**
   * Convert a JSON schema array to a Zod array schema
   */
  private static convertArraySchema(node: any): z.ZodArray<any> {
    // If items is defined, convert it to a Zod schema
    if (node.items) {
      return z.array(this.convertSchemaNode(node.items));
    }

    // Default to array of any
    return z.array(z.any());
  }
}

import type { JSONSchema7 } from 'json-schema';
import type { LanguageModelV1 } from 'ai';
import type { Schema } from 'ai';
import type { Targets } from 'zod-to-json-schema';
import { z } from 'zod';
import { ZodArray } from 'zod';
import { ZodDate } from 'zod';
import { ZodDefault } from 'zod';
import { ZodNull } from 'zod';
import { ZodNumber } from 'zod';
import { ZodObject } from 'zod';
import { ZodOptional } from 'zod';
import type { ZodSchema } from 'zod';
import { ZodString } from 'zod';
import type { ZodTypeAny } from 'zod';
import { ZodUnion } from 'zod';

/**
 * All supported array validation check types that can be processed or converted to descriptions.
 * @constant
 */
declare const ALL_ARRAY_CHECKS: readonly ["min", "max", "length"];
export { ALL_ARRAY_CHECKS }
export { ALL_ARRAY_CHECKS as ALL_ARRAY_CHECKS_alias_1 }

/**
 * All supported number validation check types that can be processed or converted to descriptions.
 * @constant
 */
declare const ALL_NUMBER_CHECKS: readonly ["min", "max", "multipleOf"];
export { ALL_NUMBER_CHECKS }
export { ALL_NUMBER_CHECKS as ALL_NUMBER_CHECKS_alias_1 }

/**
 * All supported string validation check types that can be processed or converted to descriptions.
 * @constant
 */
declare const ALL_STRING_CHECKS: readonly ["regex", "emoji", "email", "url", "uuid", "cuid", "min", "max"];
export { ALL_STRING_CHECKS }
export { ALL_STRING_CHECKS as ALL_STRING_CHECKS_alias_1 }

/**
 * All Zod types (both supported and unsupported).
 * @constant
 */
declare const ALL_ZOD_TYPES: readonly ["ZodObject", "ZodArray", "ZodUnion", "ZodString", "ZodNumber", "ZodDate", "ZodAny", "ZodDefault", "ZodIntersection", "ZodNever", "ZodNull", "ZodTuple", "ZodUndefined"];
export { ALL_ZOD_TYPES }
export { ALL_ZOD_TYPES as ALL_ZOD_TYPES_alias_1 }

/**
 * Type representing all Zod schema types (supported and unsupported).
 */
declare type AllZodType = (typeof ALL_ZOD_TYPES)[number];
export { AllZodType }
export { AllZodType as AllZodType_alias_1 }

declare class AnthropicSchemaCompatLayer extends SchemaCompatLayer {
    constructor(model: LanguageModelV1);
    getSchemaTarget(): Targets | undefined;
    shouldApply(): boolean;
    processZodType(value: ZodTypeAny): ZodTypeAny;
}
export { AnthropicSchemaCompatLayer }
export { AnthropicSchemaCompatLayer as AnthropicSchemaCompatLayer_alias_1 }

/**
 * Processes a schema using provider compatibility layers and converts it to an AI SDK Schema.
 *
 * @param options - Configuration object for schema processing
 * @param options.schema - The schema to process (AI SDK Schema or Zod object schema)
 * @param options.compatLayers - Array of compatibility layers to try
 * @param options.mode - Must be 'aiSdkSchema'
 * @returns Processed schema as an AI SDK Schema
 */
declare function applyCompatLayer(options: {
    schema: Schema | z.ZodSchema;
    compatLayers: SchemaCompatLayer[];
    mode: 'aiSdkSchema';
}): Schema;

/**
 * Processes a schema using provider compatibility layers and converts it to a JSON Schema.
 *
 * @param options - Configuration object for schema processing
 * @param options.schema - The schema to process (AI SDK Schema or Zod object schema)
 * @param options.compatLayers - Array of compatibility layers to try
 * @param options.mode - Must be 'jsonSchema'
 * @returns Processed schema as a JSONSchema7
 */
declare function applyCompatLayer(options: {
    schema: Schema | z.ZodSchema;
    compatLayers: SchemaCompatLayer[];
    mode: 'jsonSchema';
}): JSONSchema7;
export { applyCompatLayer }
export { applyCompatLayer as applyCompatLayer_alias_1 }

/**
 * Type representing array validation checks.
 */
declare type ArrayCheckType = (typeof ALL_ARRAY_CHECKS)[number];
export { ArrayCheckType }
export { ArrayCheckType as ArrayCheckType_alias_1 }

declare type ArrayConstraints = {
    minLength?: number;
    maxLength?: number;
    exactLength?: number;
};

/**
 * Converts an AI SDK Schema or Zod schema to a Zod schema.
 *
 * If the input is already a Zod schema, it returns it unchanged.
 * If the input is an AI SDK Schema, it extracts the JSON schema and converts it to Zod.
 *
 * @param schema - The schema to convert (AI SDK Schema or Zod schema)
 * @returns A Zod schema equivalent of the input
 * @throws Error if the conversion fails
 *
 * @example
 * ```typescript
 * import { jsonSchema } from 'ai';
 * import { convertSchemaToZod } from '@mastra/schema-compat';
 *
 * const aiSchema = jsonSchema({
 *   type: 'object',
 *   properties: {
 *     name: { type: 'string' }
 *   }
 * });
 *
 * const zodSchema = convertSchemaToZod(aiSchema);
 * ```
 */
declare function convertSchemaToZod(schema: Schema | z.ZodSchema): z.ZodType;
export { convertSchemaToZod }
export { convertSchemaToZod as convertSchemaToZod_alias_1 }

/**
 * Converts a Zod schema to an AI SDK Schema with validation support.
 *
 * This function mirrors the behavior of Vercel's AI SDK zod-schema utility but allows
 * customization of the JSON Schema target format.
 *
 * @param zodSchema - The Zod schema to convert
 * @param target - The JSON Schema target format (defaults to 'jsonSchema7')
 * @returns An AI SDK Schema object with built-in validation
 *
 * @example
 * ```typescript
 * import { z } from 'zod';
 * import { convertZodSchemaToAISDKSchema } from '@mastra/schema-compat';
 *
 * const userSchema = z.object({
 *   name: z.string(),
 *   age: z.number().min(0)
 * });
 *
 * const aiSchema = convertZodSchemaToAISDKSchema(userSchema);
 * ```
 */
declare function convertZodSchemaToAISDKSchema(zodSchema: ZodSchema, target?: Targets): Schema<any>;
export { convertZodSchemaToAISDKSchema }
export { convertZodSchemaToAISDKSchema as convertZodSchemaToAISDKSchema_alias_1 }

declare type DateConstraints = {
    minDate?: string;
    maxDate?: string;
    dateFormat?: string;
};

declare class DeepSeekSchemaCompatLayer extends SchemaCompatLayer {
    constructor(model: LanguageModelV1);
    getSchemaTarget(): Targets | undefined;
    shouldApply(): boolean;
    processZodType(value: ZodTypeAny): ZodTypeAny;
}
export { DeepSeekSchemaCompatLayer }
export { DeepSeekSchemaCompatLayer as DeepSeekSchemaCompatLayer_alias_1 }

declare class GoogleSchemaCompatLayer extends SchemaCompatLayer {
    constructor(model: LanguageModelV1);
    getSchemaTarget(): Targets | undefined;
    shouldApply(): boolean;
    processZodType(value: ZodTypeAny): ZodTypeAny;
}
export { GoogleSchemaCompatLayer }
export { GoogleSchemaCompatLayer as GoogleSchemaCompatLayer_alias_1 }

declare const isArr: (v: ZodTypeAny) => v is ZodArray<any, any>;
export { isArr }
export { isArr as isArr_alias_1 }

export declare const isDate: (v: ZodTypeAny) => v is ZodDate;

export declare const isDefault: (v: ZodTypeAny) => v is ZodDefault<any>;

export declare const isNull: (v: ZodTypeAny) => v is ZodNull;

declare const isNumber: (v: ZodTypeAny) => v is ZodNumber;
export { isNumber }
export { isNumber as isNumber_alias_1 }

declare const isObj: (v: ZodTypeAny) => v is ZodObject<any, any, any>;
export { isObj }
export { isObj as isObj_alias_1 }

declare const isOptional: (v: ZodTypeAny) => v is ZodOptional<any>;
export { isOptional }
export { isOptional as isOptional_alias_1 }

declare const isString: (v: ZodTypeAny) => v is ZodString;
export { isString }
export { isString as isString_alias_1 }

declare const isUnion: (v: ZodTypeAny) => v is ZodUnion<[ZodTypeAny, ...ZodTypeAny[]]>;
export { isUnion }
export { isUnion as isUnion_alias_1 }

declare class MetaSchemaCompatLayer extends SchemaCompatLayer {
    constructor(model: LanguageModelV1);
    getSchemaTarget(): Targets | undefined;
    shouldApply(): boolean;
    processZodType(value: ZodTypeAny): ZodTypeAny;
}
export { MetaSchemaCompatLayer }
export { MetaSchemaCompatLayer as MetaSchemaCompatLayer_alias_1 }

/**
 * Type representing number validation checks.
 */
declare type NumberCheckType = (typeof ALL_NUMBER_CHECKS)[number];
export { NumberCheckType }
export { NumberCheckType as NumberCheckType_alias_1 }

declare type NumberConstraints = {
    gt?: number;
    gte?: number;
    lt?: number;
    lte?: number;
    multipleOf?: number;
};

declare class OpenAIReasoningSchemaCompatLayer extends SchemaCompatLayer {
    constructor(model: LanguageModelV1);
    getSchemaTarget(): Targets | undefined;
    isReasoningModel(): boolean;
    shouldApply(): boolean;
    processZodType(value: ZodTypeAny): ZodTypeAny;
}
export { OpenAIReasoningSchemaCompatLayer }
export { OpenAIReasoningSchemaCompatLayer as OpenAIReasoningSchemaCompatLayer_alias_1 }

declare class OpenAISchemaCompatLayer extends SchemaCompatLayer {
    constructor(model: LanguageModelV1);
    getSchemaTarget(): Targets | undefined;
    shouldApply(): boolean;
    processZodType(value: ZodTypeAny): ZodTypeAny;
}
export { OpenAISchemaCompatLayer }
export { OpenAISchemaCompatLayer as OpenAISchemaCompatLayer_alias_1 }

/**
 * Abstract base class for creating schema compatibility layers for different AI model providers.
 *
 * This class provides a framework for transforming Zod schemas to work with specific AI model
 * provider requirements and limitations. Each provider may have different support levels for
 * JSON Schema features, validation constraints, and data types.
 *
 * @abstract
 *
 * @example
 * ```typescript
 * import { SchemaCompatLayer } from '@mastra/schema-compat';
 * import type { LanguageModelV1 } from 'ai';
 *
 * class CustomProviderCompat extends SchemaCompatLayer {
 *   constructor(model: LanguageModelV1) {
 *     super(model);
 *   }
 *
 *   shouldApply(): boolean {
 *     return this.getModel().provider === 'custom-provider';
 *   }
 *
 *   getSchemaTarget() {
 *     return 'jsonSchema7';
 *   }
 *
 *   processZodType<T extends z.AnyZodObject>(value: z.ZodTypeAny): ShapeValue<T> {
 *     // Custom processing logic for this provider
 *     switch (value._def.typeName) {
 *       case 'ZodString':
 *         return this.defaultZodStringHandler(value, ['email', 'url']);
 *       default:
 *         return this.defaultUnsupportedZodTypeHandler(value);
 *     }
 *   }
 * }
 * ```
 */
declare abstract class SchemaCompatLayer {
    private model;
    /**
     * Creates a new schema compatibility instance.
     *
     * @param model - The language model this compatibility layer applies to
     */
    constructor(model: LanguageModelV1);
    /**
     * Gets the language model associated with this compatibility layer.
     *
     * @returns The language model instance
     */
    getModel(): LanguageModelV1;
    /**
     * Determines whether this compatibility layer should be applied for the current model.
     *
     * @returns True if this compatibility layer should be used, false otherwise
     * @abstract
     */
    abstract shouldApply(): boolean;
    /**
     * Returns the JSON Schema target format for this provider.
     *
     * @returns The schema target format, or undefined to use the default 'jsonSchema7'
     * @abstract
     */
    abstract getSchemaTarget(): Targets | undefined;
    /**
     * Processes a specific Zod type according to the provider's requirements.
     *
     * @param value - The Zod type to process
     * @returns The processed Zod type
     * @abstract
     */
    abstract processZodType(value: ZodTypeAny): ZodTypeAny;
    /**
     * Default handler for Zod object types. Recursively processes all properties in the object.
     *
     * @param value - The Zod object to process
     * @returns The processed Zod object
     */
    defaultZodObjectHandler(value: ZodObject<any, any, any>, options?: {
        passthrough?: boolean;
    }): ZodObject<any, any, any>;
    /**
     * Merges validation constraints into a parameter description.
     *
     * This helper method converts validation constraints that may not be supported
     * by a provider into human-readable descriptions.
     *
     * @param description - The existing parameter description
     * @param constraints - The validation constraints to merge
     * @returns The updated description with constraints, or undefined if no constraints
     */
    mergeParameterDescription(description: string | undefined, constraints: NumberConstraints | StringConstraints | ArrayConstraints | DateConstraints | {
        defaultValue?: unknown;
    }): string | undefined;
    /**
     * Default handler for unsupported Zod types. Throws an error for specified unsupported types.
     *
     * @param value - The Zod type to check
     * @param throwOnTypes - Array of type names to throw errors for
     * @returns The original value if not in the throw list
     * @throws Error if the type is in the unsupported list
     */
    defaultUnsupportedZodTypeHandler<T extends z.AnyZodObject>(value: z.ZodTypeAny, throwOnTypes?: readonly UnsupportedZodType[]): ShapeValue<T>;
    /**
     * Default handler for Zod array types. Processes array constraints according to provider support.
     *
     * @param value - The Zod array to process
     * @param handleChecks - Array constraints to convert to descriptions vs keep as validation
     * @returns The processed Zod array
     */
    defaultZodArrayHandler(value: ZodArray<any, any>, handleChecks?: readonly ArrayCheckType[]): ZodArray<any, any>;
    /**
     * Default handler for Zod union types. Processes all union options.
     *
     * @param value - The Zod union to process
     * @returns The processed Zod union
     * @throws Error if union has fewer than 2 options
     */
    defaultZodUnionHandler(value: ZodUnion<[ZodTypeAny, ...ZodTypeAny[]]>): ZodTypeAny;
    /**
     * Default handler for Zod string types. Processes string validation constraints.
     *
     * @param value - The Zod string to process
     * @param handleChecks - String constraints to convert to descriptions vs keep as validation
     * @returns The processed Zod string
     */
    defaultZodStringHandler(value: ZodString, handleChecks?: readonly StringCheckType[]): ZodString;
    /**
     * Default handler for Zod number types. Processes number validation constraints.
     *
     * @param value - The Zod number to process
     * @param handleChecks - Number constraints to convert to descriptions vs keep as validation
     * @returns The processed Zod number
     */
    defaultZodNumberHandler(value: ZodNumber, handleChecks?: readonly NumberCheckType[]): ZodNumber;
    /**
     * Default handler for Zod date types. Converts dates to ISO strings with constraint descriptions.
     *
     * @param value - The Zod date to process
     * @returns A Zod string schema representing the date in ISO format
     */
    defaultZodDateHandler(value: ZodDate): ZodString;
    /**
     * Default handler for Zod optional types. Processes the inner type and maintains optionality.
     *
     * @param value - The Zod optional to process
     * @param handleTypes - Types that should be processed vs passed through
     * @returns The processed Zod optional
     */
    defaultZodOptionalHandler(value: ZodOptional<any>, handleTypes?: readonly AllZodType[]): ZodTypeAny;
    /**
     * Processes a Zod object schema and converts it to an AI SDK Schema.
     *
     * @param zodSchema - The Zod object schema to process
     * @returns An AI SDK Schema with provider-specific compatibility applied
     */
    processToAISDKSchema(zodSchema: z.ZodSchema): Schema;
    /**
     * Processes a Zod object schema and converts it to a JSON Schema.
     *
     * @param zodSchema - The Zod object schema to process
     * @returns A JSONSchema7 object with provider-specific compatibility applied
     */
    processToJSONSchema(zodSchema: z.ZodSchema): JSONSchema7;
}
export { SchemaCompatLayer }
export { SchemaCompatLayer as SchemaCompatLayer_alias_1 }

/**
 * Utility type to extract the keys from a Zod object shape.
 */
declare type ShapeKey<T extends z.AnyZodObject> = keyof ZodShape<T>;
export { ShapeKey }
export { ShapeKey as ShapeKey_alias_1 }

/**
 * Utility type to extract the value types from a Zod object shape.
 */
declare type ShapeValue<T extends z.AnyZodObject> = ZodShape<T>[ShapeKey<T>];
export { ShapeValue }
export { ShapeValue as ShapeValue_alias_1 }

/**
 * Type representing string validation checks.
 */
declare type StringCheckType = (typeof ALL_STRING_CHECKS)[number];
export { StringCheckType }
export { StringCheckType as StringCheckType_alias_1 }

declare type StringConstraints = {
    minLength?: number;
    maxLength?: number;
    email?: boolean;
    url?: boolean;
    uuid?: boolean;
    cuid?: boolean;
    emoji?: boolean;
    regex?: {
        pattern: string;
        flags?: string;
    };
};

/**
 * Zod types that are generally supported by AI model providers.
 * @constant
 */
declare const SUPPORTED_ZOD_TYPES: readonly ["ZodObject", "ZodArray", "ZodUnion", "ZodString", "ZodNumber", "ZodDate", "ZodAny", "ZodDefault"];
export { SUPPORTED_ZOD_TYPES }
export { SUPPORTED_ZOD_TYPES as SUPPORTED_ZOD_TYPES_alias_1 }

/**
 * Type representing supported Zod schema types.
 */
declare type SupportedZodType = (typeof SUPPORTED_ZOD_TYPES)[number];
export { SupportedZodType }
export { SupportedZodType as SupportedZodType_alias_1 }

/**
 * Zod types that are not supported by most AI model providers and should be avoided.
 * @constant
 */
declare const UNSUPPORTED_ZOD_TYPES: readonly ["ZodIntersection", "ZodNever", "ZodNull", "ZodTuple", "ZodUndefined"];
export { UNSUPPORTED_ZOD_TYPES }
export { UNSUPPORTED_ZOD_TYPES as UNSUPPORTED_ZOD_TYPES_alias_1 }

/**
 * Type representing unsupported Zod schema types.
 */
declare type UnsupportedZodType = (typeof UNSUPPORTED_ZOD_TYPES)[number];
export { UnsupportedZodType }
export { UnsupportedZodType as UnsupportedZodType_alias_1 }

/**
 * Utility type to extract the shape of a Zod object schema.
 */
declare type ZodShape<T extends z.AnyZodObject> = T['shape'];
export { ZodShape }
export { ZodShape as ZodShape_alias_1 }

export { }

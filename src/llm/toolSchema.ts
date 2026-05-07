import { Type, type FunctionDeclaration, type Schema } from '@google/genai';

/**
 * OpenAI/JSON-Schema flavour of a tool definition. This is the shape Ollama
 * (and OpenAI-compatible servers) expect under `tools[]`.
 */
export interface JsonSchemaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JsonSchemaObject;
  };
}

export interface JsonSchemaObject {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export interface JsonSchemaProperty {
  type: string;
  description?: string;
  enum?: unknown[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

function geminiTypeToJson(t: Type | undefined): string {
  switch (t) {
    case Type.STRING:
      return 'string';
    case Type.NUMBER:
      return 'number';
    case Type.INTEGER:
      return 'integer';
    case Type.BOOLEAN:
      return 'boolean';
    case Type.ARRAY:
      return 'array';
    case Type.OBJECT:
      return 'object';
    default:
      return 'string';
  }
}

function convertSchema(schema: Schema): JsonSchemaProperty {
  const out: JsonSchemaProperty = { type: geminiTypeToJson(schema.type) };
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum as unknown[];
  if (schema.items) out.items = convertSchema(schema.items as Schema);
  if (schema.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      out.properties[k] = convertSchema(v as Schema);
    }
  }
  if (schema.required) out.required = [...schema.required];
  return out;
}

/**
 * Convert a Gemini `FunctionDeclaration[]` into OpenAI-style JSON Schema
 * tools so the same tool registry can be served to Ollama / OpenAI APIs.
 */
export function toJsonSchemaTools(decls: FunctionDeclaration[]): JsonSchemaTool[] {
  return decls.map((d) => {
    const params = d.parameters
      ? convertSchema(d.parameters as Schema)
      : ({ type: 'object', properties: {} } as JsonSchemaProperty);
    const obj: JsonSchemaObject = {
      type: 'object',
      properties: params.properties ?? {},
      ...(params.required ? { required: params.required } : {}),
    };
    return {
      type: 'function',
      function: {
        name: d.name ?? '',
        description: d.description ?? '',
        parameters: obj,
      },
    };
  });
}

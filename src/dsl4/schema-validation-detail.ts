import type {ErrorObject} from 'ajv';

/** The bounded, source-free part of an Ajv failure needed to explain a correction. */
export interface Dsl4SchemaValidationDetail {
  keyword: string;
  field?: string;
  expected?: string;
  alternative?: boolean;
}

export function dsl4SchemaValidationDetail(
  error: ErrorObject,
  errors: readonly ErrorObject[] = [],
): Dsl4SchemaValidationDetail {
  const params = error.params as Record<string, unknown>;
  const field = params.missingProperty ?? params.additionalProperty ?? params.propertyName;
  const expected = params.type ?? params.limit ?? params.allowedValue;
  return {
    keyword: error.keyword,
    ...(errors.some(
      (candidate) =>
        ['oneOf', 'anyOf'].includes(candidate.keyword) &&
        (error.instancePath === candidate.instancePath ||
          error.instancePath.startsWith(`${candidate.instancePath}/`)),
    )
      ? {alternative: true}
      : {}),
    ...(typeof field === 'string' && field.length > 0
      ? {field: [...field].slice(0, 160).join('')}
      : {}),
    ...((typeof expected === 'string' && expected.length > 0) || typeof expected === 'number'
      ? {expected: [...String(expected)].slice(0, 160).join('')}
      : {}),
  };
}

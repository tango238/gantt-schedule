export interface SchemaValidationError {
  instancePath: string;
  keyword: string;
  message?: string;
  params: Record<string, unknown>;
}
declare function validate(data: unknown): boolean;
declare namespace validate {
  let errors: SchemaValidationError[] | null;
}
export { validate };
export default validate;

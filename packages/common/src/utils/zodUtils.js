/**
 * Format Zod validation errors into a more user-friendly format
 *
 * @param error The Zod error to format
 * @returns A formatted error object
 */
export function formatZodError(error) {
    return {
        issues: error.errors.map(err => ({
            path: err.path.join('.'),
            message: err.message,
            code: err.code,
        })),
    };
}
//# sourceMappingURL=zodUtils.js.map
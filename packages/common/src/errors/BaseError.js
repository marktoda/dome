/**
 * Base error class for all application errors
 */
export class BaseError extends Error {
    /**
     * Creates a new BaseError
     * @param message Error message
     * @param code Error code
     * @param status HTTP status code
     * @param details Additional error details
     */
    constructor(message, code, status = 500, details) {
        super(message);
        this.name = this.constructor.name;
        this.code = code;
        this.status = status;
        this.details = details;
        // Maintains proper stack trace for where our error was thrown (only available on V8)
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor);
        }
    }
}
//# sourceMappingURL=BaseError.js.map
import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from "@nestjs/common";
import { ZodError } from "zod";

/**
 * Translate a `ZodError` thrown by request-body validation (`create[Model].parse`
 * / `update[Model].parse`) into a 400 response with the raw Zod issues.
 */
@Catch(ZodError)
export class ZodExceptionFilter implements ExceptionFilter {
  catch(err: ZodError, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    response.status(HttpStatus.BAD_REQUEST).json({
      statusCode: HttpStatus.BAD_REQUEST,
      message: "Validation failed",
      errors: err.issues,
    });
  }
}

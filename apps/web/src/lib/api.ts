import type {
  ApiError,
  ApiErrorCode,
  ErrorEnvelope,
  RequestMeta,
  SuccessEnvelope,
} from "@asi/contracts";
import { NextResponse } from "next/server";

export interface JsonSuccessOptions extends ResponseInit {
  readonly meta?: RequestMeta;
}

export function jsonSuccess<T>(
  data: T,
  options: JsonSuccessOptions = {},
): NextResponse<SuccessEnvelope<T>> {
  const { meta, ...responseInit } = options;
  const body: SuccessEnvelope<T> =
    meta === undefined ? { data } : { data, meta };

  return NextResponse.json(body, responseInit);
}

export function jsonError(
  code: ApiErrorCode,
  message: string,
  status: number,
  details?: ApiError["details"],
): NextResponse<ErrorEnvelope> {
  const error: ApiError =
    code === "internal_error"
      ? { code, message: "An internal error occurred" }
      : details === undefined
        ? { code, message }
        : { code, message, details };

  return NextResponse.json({ error }, { status });
}

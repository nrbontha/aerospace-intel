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


export function jsonValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, jsonValue(child)]),
    );
  }
  return value;
}

export function jsonPage<T>(
  records: T[],
  page: number,
  pageSize: number,
  total: number,
): Response {
  return NextResponse.json(
    {
      data: records.map(jsonValue),
      meta: {
        page,
        pageSize,
        totalItems: total,
        totalPages: Math.ceil(total / pageSize) || 0,
      },
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

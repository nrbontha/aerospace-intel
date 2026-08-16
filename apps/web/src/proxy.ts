import { type NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE_NAME =
  process.env.SESSION_COOKIE_NAME?.trim() || "asi_session";

function isPublicPath(pathname: string): boolean {
  const normalizedPath =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  return (
    normalizedPath === "/login" ||
    normalizedPath === "/api/v1/auth/login" ||
    normalizedPath === "/health" ||
    normalizedPath === "/health/ready" ||
    normalizedPath === "/api/v1/health" ||
    normalizedPath === "/api/v1/health/ready"
  );
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (isPublicPath(pathname) || request.cookies.has(SESSION_COOKIE_NAME)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      {
        error: {
          code: "UNAUTHORIZED",
          message: "Authentication is required",
        },
      },
      { status: 401 },
    );
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)",
  ],
};

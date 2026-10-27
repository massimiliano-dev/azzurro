import { NextResponse, type NextRequest } from 'next/server';

/** Login aziendale obbligatorio: senza sessione si viene portati alla pagina di accesso. */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const hasSession = request.cookies.has('azzurro_session');
  if (!hasSession && pathname !== '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next|sw\\.js|manifest\\.webmanifest|icons|icon\\.svg|favicon\\.ico|offline|robots\\.txt).*)'],
};

import { NextResponse, type NextRequest } from 'next/server';
import { basicAuthOk } from './lib/auth';

/** Basic auth in front of every page and Server Action when WEB_BASIC_AUTH_* is configured. */
export function proxy(request: NextRequest) {
  if (basicAuthOk(request.headers.get('authorization'))) return NextResponse.next();
  return new NextResponse('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Automated Opportunity Center", charset="UTF-8"' },
  });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
};

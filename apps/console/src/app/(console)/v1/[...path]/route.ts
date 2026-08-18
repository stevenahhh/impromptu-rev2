import { proxyPrivateApi } from "../../../../private-api-proxy";

type RouteContext = Readonly<{
  params: Promise<{ readonly path: string[] }>;
}>;

async function proxy(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  return proxyPrivateApi(request, path);
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;

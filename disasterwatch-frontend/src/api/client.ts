type Json = Record<string, any> | any[];

export type ApiError = {
  status: number;
  message: string;
  url: string;
};

const buildUrl = (base: string, path: string) => {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
};

export async function getJson<T = Json>(
  url: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err: ApiError = {
      status: res.status,
      message: text || res.statusText || "Request failed",
      url,
    };
    throw err;
  }

  return (await res.json()) as T;
}

export async function getJsonFromBase<T>(
  baseUrl: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  return getJson<T>(buildUrl(baseUrl, path), init);
}

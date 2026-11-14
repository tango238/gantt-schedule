export interface Me {
  user: { id: string; email: string; name: string; picture: string | null; isAdmin: boolean };
  isAdmin: boolean;
}

/** 未ログインなら null。それ以外のエラーは throw。 */
export async function fetchMe(): Promise<Me | null> {
  const res = await fetch("/api/me");
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`/api/me: ${res.status}`);
  return (await res.json()) as Me;
}

export async function fetchAuthConfig(): Promise<{ devLogin: string[] }> {
  const res = await fetch("/api/auth-config");
  if (!res.ok) throw new Error(`/api/auth-config: ${res.status}`);
  return (await res.json()) as { devLogin: string[] };
}

export async function logout(): Promise<void> {
  // Origin ヘッダはブラウザが自動付与する (サーバー側の CSRF 検証用)
  await fetch("/auth/logout", { method: "POST" });
}

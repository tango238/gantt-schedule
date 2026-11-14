import { useEffect, useState } from "react";

// 依存を増やさないための最小ルーター (history API)。
export type Route =
  | { name: "home" }
  | { name: "schedule"; id: string }
  | { name: "admin" }
  | { name: "notfound" };

export function matchRoute(pathname: string): Route {
  if (pathname === "/") return { name: "home" };
  if (pathname === "/admin") return { name: "admin" };
  const m = /^\/s\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
  if (m) return { name: "schedule", id: m[1] };
  return { name: "notfound" };
}

export function navigate(to: string): void {
  history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute(): Route {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return matchRoute(path);
}

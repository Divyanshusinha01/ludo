import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const { AuthPanel } = await import("@/components/AuthPanel");
const { HomeOnlineFlow } = await import("@/components/HomeOnlineFlow");
const { resetAuthForTests } = await import("@/lib/auth");

type Route = { status: number; body: unknown };
let routes: Record<string, Route | Route[]>;
let calls: Array<{ url: string; method: string; body: unknown }>;

function jsonResponse({ status, body }: Route) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  resetAuthForTests();
  calls = [];
  routes = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const route = routes[url];
      const next = Array.isArray(route) ? route.shift() : route;
      if (!next) throw new Error(`unexpected fetch ${url}`);
      return jsonResponse(next);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.cookie = "ludo_last_username=; max-age=0; path=/";
});

const signedInToken: Route = {
  status: 200,
  body: {
    ok: true,
    token: "jwt.header.sig",
    expiresAt: Date.now() + 600_000,
    profile: { username: "divsi", displayName: "Divsi" },
  },
};
const rejected: Route = { status: 401, body: { ok: false, error: "unauthorized" } };

describe("AuthPanel", () => {
  it("a remembered device renders nothing", async () => {
    routes["/api/auth/token"] = signedInToken;
    const { container } = render(<AuthPanel />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(calls).toEqual([{ url: "/api/auth/token", method: "GET", body: undefined }]);
  });

  it("prefills the create-game name from the profile", async () => {
    routes["/api/auth/token"] = signedInToken;
    render(
      <>
        <AuthPanel />
        <HomeOnlineFlow mode="create" offline={false} onModeChange={() => {}} />
      </>,
    );
    await waitFor(() => expect(screen.getByLabelText("Your name")).toHaveValue("Divsi"));
  });

  it("a rejected session shows login with the last username prefilled", async () => {
    document.cookie = "ludo_last_username=divsi; path=/";
    routes["/api/auth/token"] = rejected;
    render(<AuthPanel />);
    expect(await screen.findByLabelText("Username")).toHaveValue("divsi");
    expect(screen.getByRole("tab", { name: "Log in" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("anonymous visitors see a collapsed optional prompt", async () => {
    routes["/api/auth/token"] = rejected;
    render(<AuthPanel />);
    const open = await screen.findByRole("button", { name: "Sign in or create account" });
    fireEvent.click(open);
    expect(screen.getByRole("tab", { name: "Sign up" })).toHaveAttribute("aria-selected", "true");
  });

  it("login posts credentials, then hides the panel", async () => {
    document.cookie = "ludo_last_username=divsi; path=/";
    routes["/api/auth/token"] = [rejected, signedInToken];
    routes["/api/auth/login"] = {
      status: 200,
      body: { ok: true, profile: { username: "divsi", displayName: "Divsi" } },
    };
    render(<AuthPanel />);
    fireEvent.change(await screen.findByLabelText("Password"), {
      target: { value: "pw12345678" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    await waitFor(() => expect(screen.queryByLabelText("Password")).toBeNull());
    const loginCall = calls.find((c) => c.url === "/api/auth/login")!;
    expect(loginCall).toEqual({
      url: "/api/auth/login",
      method: "POST",
      body: { username: "divsi", password: "pw12345678" },
    });
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/auth/token")).toHaveLength(2));
  });

  it("shows the server's error message on a failed login", async () => {
    document.cookie = "ludo_last_username=divsi; path=/";
    routes["/api/auth/token"] = rejected;
    routes["/api/auth/login"] = {
      status: 401,
      body: { ok: false, error: "invalidCredentials", message: "Wrong username or password" },
    };
    render(<AuthPanel />);
    fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Wrong username or password");
  });
});

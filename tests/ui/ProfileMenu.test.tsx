import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("@/components/ProfileMenuPanel", () => ({
  ProfileMenuPanel: () => <p>stats panel</p>,
}));

const { ProfileMenu } = await import("@/components/ProfileMenu");
const { ProfileStats } = await import("@/components/ProfileStats");
const { resetAuthForTests } = await import("@/lib/auth");

function stubToken(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

beforeEach(() => {
  resetAuthForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ProfileMenu", () => {
  it("shows nothing for anonymous visitors", async () => {
    stubToken(401, { ok: false, error: "unauthorized" });
    const { container } = render(<ProfileMenu />);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the username chip and toggles the stats panel", async () => {
    stubToken(200, {
      ok: true,
      token: "jwt.header.sig",
      expiresAt: Date.now() + 600_000,
      profile: { username: "divsi", displayName: "Divsi" },
    });
    render(<ProfileMenu />);
    const trigger = await screen.findByRole("button", { name: "Profile: divsi" });
    expect(trigger).toHaveTextContent("Ddivsi");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Your profile" });
    expect(await within(dialog).findByText("stats panel")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });
});

describe("ProfileStats", () => {
  it("derives losses and win rate", () => {
    render(
      <ProfileStats
        profile={{
          username: "divsi",
          displayName: "Divsi",
          rating: 1020,
          peakRating: 1040,
          gamesPlayed: 8,
          wins: 3,
          ratedGames: 2,
          tokensCaptured: 11,
          tokensLost: 7,
          createdAt: 0,
        }}
      />,
    );
    const value = (label: string) => screen.getByText(label).nextElementSibling?.textContent;
    expect(value("Games")).toBe("8");
    expect(value("Wins")).toBe("3");
    expect(value("Losses")).toBe("5");
    expect(value("Win rate")).toBe("38%");
    expect(value("Captured")).toBe("11");
    expect(value("Lost")).toBe("7");
    expect(value("Rating")).toBe("1020");
    expect(value("Peak")).toBe("1040");
  });
});

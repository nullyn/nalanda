import type { Locator, Page } from "playwright";

type AccountLocator = Pick<
	Locator,
	"waitFor" | "count" | "isVisible" | "evaluate"
> & {
	first(): AccountLocator;
	nth(index: number): AccountLocator;
};
type AccountPage = {
	getByRole(...args: Parameters<Page["getByRole"]>): AccountLocator;
	locator(selector: string): AccountLocator;
};

export function instagramPath(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== "www.instagram.com") return null;
		return parsed.pathname;
	} catch {
		return null;
	}
}

export async function verifyInstagramAccount(
	page: AccountPage,
	username: string,
) {
	// Instagram varies between a Profile label and a profile-picture link.
	// Ignore links inside main: those can belong to a viewed post's author.
	const profileLinks = page.getByRole("link", { name: "Profile", exact: true });
	await profileLinks
		.first()
		.waitFor({ state: "visible", timeout: 5_000 })
		.catch(() => undefined);
	for (let index = 0; index < (await profileLinks.count()); index += 1) {
		const link = profileLinks.nth(index);
		if (!(await link.isVisible().catch(() => false))) continue;
		const profile = await link.evaluate((element) => ({
			href: element.getAttribute("href"),
			outsideMain: !element.closest("main"),
		}));
		const path = profile.href
			? instagramPath(new URL(profile.href, "https://www.instagram.com").href)
			: null;
		const parts = path?.split("/").filter(Boolean) ?? [];
		if (!profile.outsideMain || parts.length !== 1) continue;
		if (parts[0]?.toLowerCase() !== username.toLowerCase())
			throw new Error(
				`Chrome is signed in to a different Instagram account; expected @${username}.`,
			);
		return;
	}
	const profileImages = page.locator(
		'a[href^="/"] img[alt$="profile picture"]',
	);
	await profileImages.first().waitFor({ state: "visible", timeout: 15_000 });
	const count = await profileImages.count();
	let signedInUsername: string | undefined;
	for (let index = 0; index < count; index += 1) {
		const image = profileImages.nth(index);
		if (!(await image.isVisible().catch(() => false))) continue;
		const profile = await image.evaluate((element) => {
			const link = element.closest("a");
			return {
				href: link?.getAttribute("href"),
				alt: element.getAttribute("alt"),
				outsideMain: Boolean(link && !link.closest("main")),
			};
		});
		if (!profile.outsideMain) continue;
		const profilePath = profile.href?.split("/").filter(Boolean) ?? [];
		if (profilePath.length !== 1) continue;
		const profileLabel = profile.alt ?? "";
		if (!profileLabel.toLocaleLowerCase().endsWith("'s profile picture"))
			continue;
		const labelHandle = profileLabel.slice(0, -"'s profile picture".length);
		if (labelHandle.toLowerCase() !== profilePath[0]?.toLowerCase()) continue;
		signedInUsername = profilePath[0];
		break;
	}
	if (!signedInUsername) {
		throw new Error(
			"Could not identify the signed-in Instagram profile picture link in the navbar.",
		);
	}
	if (signedInUsername.toLowerCase() !== username.toLowerCase()) {
		throw new Error(
			`Chrome is signed in to a different Instagram account; expected @${username}.`,
		);
	}
}
